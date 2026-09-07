import { getAuditTrailForRound } from "./auditLogger.js";

/*
  The factual Raisium record for one RC agreement.

  If a dispute arises, both parties should be able to obtain what actually
  happened: what was agreed, what was paid, when the trigger was registered,
  what the calculation said, which documents were signed and by whom. That is a
  record, not an argument — this package contains no assessment of who is right,
  no finding of breach, and no legal conclusion. It is titled accordingly.

  Access is limited to the parties to that agreement and Raisium admin. An
  investor sees their own agreement and the round-level facts; they do not see
  another investor's personal data.
*/

export const EVIDENCE_PACKAGE_TITLE = "Dokumentasjon for RC-avtale";

// Never exported. Identity numbers and credentials have no evidentiary value
// in this package and every reason not to be copied out of the system.
const REDACTED_KEYS = new Set([
  "national_id", "national_id_encrypted", "fodselsnummer", "personnummer",
  "password", "password_hash", "token", "access_token", "api_key",
  "card", "card_number", "cvc", "iban", "stripe_secret"
]);

function redact(row) {
  if (!row || typeof row !== "object") return row;
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !REDACTED_KEYS.has(key))
  );
}

/*
  Decides whether this user may see this agreement's record.

  Startup users on the company that issued the round, the investor who is party
  to the agreement, and Raisium admin. Nobody else.
*/
export async function canAccessEvidence(connection, agreementId, user, { isUserInSameCompany }) {
  const [rows] = await connection.query(
    `SELECT id, startup_id, investor_id, round_id FROM rc_agreements WHERE id = ? LIMIT 1`,
    [agreementId]
  );
  const agreement = rows[0];
  if (!agreement) return { allowed: false, reason: "not_found" };

  if (user.role === "admin") return { allowed: true, agreement, scope: "admin" };
  if (Number(agreement.investor_id) === Number(user.id)) {
    return { allowed: true, agreement, scope: "investor" };
  }
  if (await isUserInSameCompany(connection, user.id, agreement.startup_id)) {
    return { allowed: true, agreement, scope: "startup" };
  }

  return { allowed: false, reason: "forbidden" };
}

export async function buildEvidencePackage(connection, agreementId, scope) {
  const [[agreement]] = await connection.query(
    `SELECT a.*, u.email AS investor_email, COALESCE(u.name, u.email) AS investor_name
     FROM rc_agreements a
     LEFT JOIN users u ON u.id = a.investor_id
     WHERE a.id = ? LIMIT 1`,
    [agreementId]
  );
  if (!agreement) return null;

  const [[round]] = await connection.query(
    `SELECT id, startup_id, target_amount, valuation_cap, discount_rate,
            trigger_period, conversion_years, open, closed_reason, closed_at, created_at
     FROM emission_rounds WHERE id = ? LIMIT 1`,
    [agreement.round_id]
  );

  // The executed agreement and its signatures.
  const [documents] = await connection.query(
    `SELECT d.id, d.type, d.title, d.status, d.document_hash, d.locked_at, d.created_at
     FROM documents d
     JOIN document_signers ds ON ds.document_id = d.id
     WHERE d.round_id = ? AND (ds.user_id = ? OR d.type <> 'RC')
     GROUP BY d.id
     ORDER BY d.created_at ASC`,
    [agreement.round_id, agreement.investor_id]
  );

  const documentIds = documents.map((d) => d.id);
  let signatures = [];
  if (documentIds.length) {
    const [rows] = await connection.query(
      `SELECT ds.document_id, ds.role, ds.status, ds.signed_at,
              COALESCE(u.name, ds.email) AS signer_name, ds.user_id
       FROM document_signers ds
       LEFT JOIN users u ON u.id = ds.user_id
       WHERE ds.document_id IN (?)
       ORDER BY ds.document_id ASC, ds.id ASC`,
      [documentIds]
    );
    signatures = rows;
  }

  const [payments] = await connection.query(
    `SELECT agreement_id, amount, status, reference, initiated_at, confirmed_at
     FROM rc_payments WHERE agreement_id = ?`,
    [agreement.id]
  );

  const [[conversion]] = await connection.query(
    `SELECT id, trigger_type, status, conversion_date, par_value_due_date,
            preparation_started_at, third_party_confirmed_at, calculations_json, created_at
     FROM conversion_events WHERE round_id = ? ORDER BY id DESC LIMIT 1`,
    [agreement.round_id]
  ).catch(() => [[]]);

  // Only this investor's par payment record; other investors' are not theirs
  // to see, and the company sees them through the conversion view instead.
  const [parRequests] = await connection.query(
    `SELECT conversion_event_id, agreement_id, par_value_amount, share_count,
            par_value_per_share, reference, due_date, status, paid_confirmed_at
     FROM conversion_par_value_requests
     WHERE agreement_id = ?`,
    [agreement.id]
  ).catch(() => [[]]);

  let calculation = null;
  try {
    const parsed = JSON.parse(conversion?.calculations_json || "null");
    if (parsed) {
      calculation = {
        calculation_version: parsed.calculation_version,
        capitalization_basis_type: parsed.capitalization_basis_type,
        capitalization_denominator: parsed.capitalization_denominator,
        frozen_at: parsed.frozen_at,
        totals: parsed.totals,
        // This investor's own allocation only.
        allocation: (parsed.investors || []).find(
          (i) => Number(i.agreement_id) === Number(agreement.id)
        ) || null
      };
    }
  } catch { /* an unreadable snapshot is reported as absent */ }

  const auditTrail = (await getAuditTrailForRound(connection, agreement.round_id))
    .filter((event) =>
      // The investor's own view is limited to round-level events and their own.
      scope !== "investor" ||
      !event.agreement_id ||
      Number(event.agreement_id) === Number(agreement.id))
    .map(redact);

  return {
    title: EVIDENCE_PACKAGE_TITLE,
    generated_at: new Date().toISOString(),
    disclaimer:
      "Dette er en faktisk oversikt over hva som er registrert i Raisium for denne RC-avtalen. " +
      "Dokumentet inneholder ingen vurdering av partenes rettigheter eller plikter, og tar ikke " +
      "stilling til om noen har misligholdt avtalen.",
    agreement: redact({
      ...agreement,
      investor_email: scope === "investor" || scope === "admin" ? agreement.investor_email : undefined
    }),
    round: redact(round),
    documents,
    signatures,
    investment_payments: payments,
    par_payments: parRequests,
    trigger: conversion
      ? {
          conversion_event_id: conversion.id,
          trigger_type: conversion.trigger_type,
          status: conversion.status,
          registered_at: conversion.preparation_started_at || conversion.created_at,
          conversion_date: conversion.conversion_date,
          share_contribution_confirmed_at: conversion.third_party_confirmed_at
        }
      : null,
    calculation,
    audit_trail: auditTrail
  };
}
