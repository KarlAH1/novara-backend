import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import db from "../config/db.js";
import { sendEmail } from "./emailService.js";
import { escapeHtml } from "./html.js";
import { AUDIT_EVENTS, recordAuditEvent } from "./auditLogger.js";
import { enqueueCriticalAuditEvent } from "./auditOutbox.js";
import { tableExists } from "./schemaCapabilities.js";
import { publicAppUrl } from "./publicUrl.js";

/*
  Confirmation that the money came in, by a revisor Raisium pays.

  Every payment goes directly to the startup. Twice in a round's life someone
  qualified confirms that it arrived:

    - year 0 ("round"): the investment amounts paid under the RC agreements,
      once the round is full or closed. Not required by law, but it gives the
      company and its investors an independent record of what was paid;
    - at conversion ("conversion"): the par amounts, which aksjeloven § 10-9
      annet ledd requires to be confirmed by a revisor (or, for cash, a bank,
      advokat or statsautorisert regnskapsfører) before registration.

  The startup does not find or pay anyone. A request appears in the confirmer's
  queue as soon as the payments are complete, with each payment and what it was
  checked against: Stripe's record for card payments, and a bank statement the
  company uploads for bank transfers. The confirmer takes the request, which
  produces the confirmation document, and signs it.
*/

export const CONFIRMATION_KINDS = { ROUND: "round", CONVERSION: "conversion" };
export const CONFIRMATION_STATUS = {
  AWAITING_EVIDENCE: "awaiting_evidence",
  READY: "ready",
  INFO_REQUESTED: "info_requested",
  CONFIRMED: "confirmed"
};
export const CONFIRMER_ROLE = "confirmer";
const CONFIRMER_SIGNER_ROLE = "Revisor";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(__dirname, "../templates");
const frontendBase = () => publicAppUrl();

export async function ensurePaymentConfirmationSchema() {
  const connection = await db.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS payment_confirmation_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kind VARCHAR(16) NOT NULL,
        startup_id INT NOT NULL,
        round_id INT NOT NULL,
        conversion_event_id INT NULL,
        scope_key VARCHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL,
        needs_bank_evidence TINYINT(1) NOT NULL DEFAULT 0,
        evidence_document_id INT NULL,
        info_request_message TEXT NULL,
        info_requested_at DATETIME NULL,
        document_id INT NULL,
        claimed_by INT NULL,
        claimed_at DATETIME NULL,
        confirmed_by INT NULL,
        confirmed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_confirmation_scope (scope_key),
        INDEX idx_confirmation_status (status),
        INDEX idx_confirmation_document (document_id)
      )
    `);
  } finally {
    connection.release();
  }
}

const scopeKeyFor = (kind, id) => `${kind}:${id}`;

function formatNok(value) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("no-NO", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })} NOK`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("no-NO", { year: "numeric", month: "long", day: "numeric" });
}

/* ------------------------------------------------------------ evidence */

async function roundPaymentRows(connection, roundId) {
  const hasLegalProfiles = await tableExists(connection, "investor_legal_profiles");
  const [rows] = await connection.query(
    `SELECT a.id AS agreement_id, a.rc_id, a.investment_amount, a.stripe_payment_intent_id,
            a.stripe_paid_at, a.payment_confirmed_by_startup_at, a.activated_at,
            ${hasLegalProfiles ? "COALESCE(NULLIF(lp.full_name, ''), u.name, u.email)" : "COALESCE(u.name, u.email)"} AS payer_name
     FROM rc_agreements a
     JOIN users u ON u.id = a.investor_id
     ${hasLegalProfiles ? "LEFT JOIN investor_legal_profiles lp ON lp.user_id = a.investor_id" : ""}
     WHERE a.round_id = ? AND a.status = 'Active RC'
     ORDER BY COALESCE(a.activated_at, a.created_at), a.id`,
    [roundId]
  );
  return rows.map((row) => ({
    payer_name: row.payer_name,
    reference: row.rc_id || `RC-${row.agreement_id}`,
    amount: Number(row.investment_amount),
    method: row.stripe_payment_intent_id ? "stripe" : "bank",
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    paid_at: row.stripe_paid_at || row.payment_confirmed_by_startup_at || row.activated_at
  }));
}

async function conversionPaymentRows(connection, conversionId) {
  const [rows] = await connection.query(
    `SELECT id, investor_name, investor_email, reference, par_value_amount, share_count,
            stripe_payment_intent_id, stripe_paid_at, paid_confirmed_at
     FROM conversion_par_value_requests
     WHERE conversion_event_id = ?
     ORDER BY id`,
    [conversionId]
  );
  return rows.map((row) => ({
    payer_name: row.investor_name || row.investor_email,
    reference: row.reference || `PARI-${row.id}`,
    amount: Number(row.par_value_amount),
    share_count: Number(row.share_count || 0),
    method: row.stripe_payment_intent_id ? "stripe" : "bank",
    stripe_payment_intent_id: row.stripe_payment_intent_id || null,
    paid_at: row.stripe_paid_at || row.paid_confirmed_at,
    paid: Boolean(row.paid_confirmed_at)
  }));
}

export async function getPaymentRows(connection, request) {
  return request.kind === CONFIRMATION_KINDS.CONVERSION
    ? conversionPaymentRows(connection, request.conversion_event_id)
    : roundPaymentRows(connection, request.round_id);
}

function paymentRowsHtml(rows, { withShares = false } = {}) {
  const cell = "padding: 6px 8px; border-bottom: 1px solid #ddd4c7; text-align: left; vertical-align: top;";
  const header = ["Innbetalt av", ...(withShares ? ["Aksjer"] : []), "Beløp", "Dato", "Referanse", "Kontrollert mot"]
    .map((label) => `<th style="${cell}">${label}</th>`).join("");
  const body = rows.map((row) => `<tr>
      <td style="${cell}">${escapeHtml(row.payer_name)}</td>
      ${withShares ? `<td style="${cell}">${row.share_count.toLocaleString("no-NO")}</td>` : ""}
      <td style="${cell}">${escapeHtml(formatNok(row.amount))}</td>
      <td style="${cell}">${escapeHtml(formatDate(row.paid_at))}</td>
      <td style="${cell}">${escapeHtml(row.reference)}</td>
      <td style="${cell}">${row.method === "stripe" ? `Stripe ${escapeHtml(row.stripe_payment_intent_id)}` : "Kontoutskrift"}</td>
    </tr>`).join("");
  return `<table style="width: 100%; border-collapse: collapse; font-size: 14px;"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function evidenceBasisText(rows) {
  const viaStripe = rows.some((row) => row.method === "stripe");
  const viaBank = rows.some((row) => row.method === "bank");
  return [
    viaStripe ? "Kortbetalinger er kontrollert mot Stripes betalingsoppføringer på selskapets egen Stripe-konto." : null,
    viaBank ? "Bankoverføringer er kontrollert mot kontoutskrift fra selskapets bankkonto, lastet opp av selskapet." : null
  ].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------ requests */

function deriveStatus(request, rows) {
  if (request.status === CONFIRMATION_STATUS.CONFIRMED) return CONFIRMATION_STATUS.CONFIRMED;
  if (request.status === CONFIRMATION_STATUS.INFO_REQUESTED) return CONFIRMATION_STATUS.INFO_REQUESTED;
  const needsBank = rows.some((row) => row.method === "bank");
  return needsBank && !request.evidence_document_id
    ? CONFIRMATION_STATUS.AWAITING_EVIDENCE
    : CONFIRMATION_STATUS.READY;
}

async function createRequest(connection, { kind, startupId, roundId, conversionId = null }) {
  const scopeKey = scopeKeyFor(kind, kind === CONFIRMATION_KINDS.CONVERSION ? conversionId : roundId);
  const draft = { kind, round_id: roundId, conversion_event_id: conversionId, evidence_document_id: null, status: null };
  const rows = await getPaymentRows(connection, draft);
  if (!rows.length) return null;
  const status = deriveStatus(draft, rows);

  const [result] = await connection.query(
    `INSERT IGNORE INTO payment_confirmation_requests
     (kind, startup_id, round_id, conversion_event_id, scope_key, status, needs_bank_evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [kind, startupId, roundId, conversionId, scopeKey, status, rows.some((row) => row.method === "bank") ? 1 : 0]
  );
  return result.affectedRows ? { id: result.insertId, kind, startupId, roundId, status } : null;
}

/*
  Opens a request for every round and conversion whose payments are complete
  and that has none yet. Cheap enough to run after each payment event and when
  a queue is opened; the unique scope key makes it safe to run concurrently.
*/
export async function syncConfirmationRequests(connection = db, { roundId = null, conversionId = null } = {}) {
  if (!(await tableExists(connection, "payment_confirmation_requests"))) return [];
  const created = [];

  const [rounds] = await connection.query(
    `SELECT er.id, er.startup_id
     FROM emission_rounds er
     WHERE (? IS NULL OR er.id = ?)
       AND NOT EXISTS (SELECT 1 FROM payment_confirmation_requests r WHERE r.scope_key = CONCAT('round:', er.id))
       AND EXISTS (SELECT 1 FROM rc_agreements a WHERE a.round_id = er.id AND a.status = 'Active RC')
       AND (er.committed_amount >= er.target_amount OR er.open = 0 OR er.deadline < NOW())`,
    [roundId, roundId]
  );
  for (const round of rounds) {
    const request = await createRequest(connection, { kind: CONFIRMATION_KINDS.ROUND, startupId: round.startup_id, roundId: round.id });
    if (request) created.push(request);
  }

  const [conversions] = await connection.query(
    `SELECT ce.id, ce.round_id, ce.startup_id
     FROM conversion_events ce
     JOIN documents gf ON gf.id = ce.gf_document_id AND gf.status = 'LOCKED'
     WHERE (? IS NULL OR ce.id = ?)
       AND NOT EXISTS (SELECT 1 FROM payment_confirmation_requests r WHERE r.scope_key = CONCAT('conversion:', ce.id))
       AND EXISTS (SELECT 1 FROM conversion_par_value_requests pr WHERE pr.conversion_event_id = ce.id)
       AND NOT EXISTS (
         SELECT 1 FROM conversion_par_value_requests pr
         WHERE pr.conversion_event_id = ce.id AND pr.paid_confirmed_at IS NULL
       )`,
    [conversionId, conversionId]
  );
  for (const conversion of conversions) {
    const request = await createRequest(connection, {
      kind: CONFIRMATION_KINDS.CONVERSION,
      startupId: conversion.startup_id,
      roundId: conversion.round_id,
      conversionId: conversion.id
    });
    if (request) created.push(request);
  }

  for (const request of created) {
    notifyRequestOpened(connection, request).catch((error) => console.error("Confirmation notice failed:", error));
  }
  return created;
}

// Runs a sync without making the caller wait or fail on it.
export function syncConfirmationRequestsLater(scope) {
  setImmediate(() => {
    syncConfirmationRequests(db, scope).catch((error) => console.error("Confirmation request sync failed:", error));
  });
}

async function companyFor(connection, startupId) {
  const [[company]] = await connection.query(
    `SELECT c.company_name, c.orgnr, u.email AS startup_email
     FROM users u
     LEFT JOIN company_memberships cm ON cm.user_id = u.id
     LEFT JOIN companies c ON c.id = cm.company_id
     WHERE u.id = ? LIMIT 1`,
    [startupId]
  );
  return company || {};
}

const TRIGGER_LABELS = {
  time_elapsed: "Tidsfrist nådd",
  new_priced_round: "Ny emisjon",
  new_round: "Ny emisjon",
  ownership_change: "Ny eierstruktur"
};

const kindLabel = (kind) => kind === CONFIRMATION_KINDS.CONVERSION ? "aksjeinnskudd ved konvertering" : "innbetalinger i RC-runden";

async function notifyRequestOpened(connection, request) {
  const company = await companyFor(connection, request.startupId);
  const companyName = company.company_name || "selskapet";

  const [confirmers] = await connection.query("SELECT email FROM users WHERE role = ?", [CONFIRMER_ROLE]);
  await Promise.allSettled(confirmers.map((confirmer) => sendEmail({
    to: confirmer.email,
    subject: `Ny bekreftelse: ${kindLabel(request.kind)} – ${companyName}`,
    text: `Hei,\n\n${companyName} har fått inn alle ${kindLabel(request.kind)}, og bekreftelsen venter på deg.\n\n${request.status === CONFIRMATION_STATUS.AWAITING_EVIDENCE ? "Selskapet laster fortsatt opp kontoutskrift for bankoverføringene.\n\n" : ""}Åpne køen: ${frontendBase()}/bekreftelser.html`
  })));

  if (request.status === CONFIRMATION_STATUS.AWAITING_EVIDENCE && company.startup_email) {
    await sendEmail({
      to: company.startup_email,
      subject: "Last opp kontoutskrift for bankoverføringene",
      text: `Hei,\n\nRaisiums revisor skal bekrefte ${kindLabel(request.kind)}. Noen har betalt med bankoverføring, så revisor trenger en kontoutskrift som viser at pengene kom inn.\n\nLast den opp her: ${frontendBase()}/${request.kind === CONFIRMATION_KINDS.CONVERSION ? "convert.html" : "dashboard.html"}`
    }).catch((error) => console.error("Evidence request e-mail failed:", error));
  }
}

/* ------------------------------------------------------------ views */

export async function describeRequest(connection, request) {
  const rows = await getPaymentRows(connection, request);
  const company = await companyFor(connection, request.startup_id);
  return {
    id: request.id,
    kind: request.kind,
    kind_label: kindLabel(request.kind),
    status: request.status,
    company_name: company.company_name || null,
    orgnr: company.orgnr || null,
    round_id: request.round_id,
    conversion_event_id: request.conversion_event_id,
    needs_bank_evidence: Boolean(request.needs_bank_evidence),
    has_bank_evidence: Boolean(request.evidence_document_id),
    info_request_message: request.info_request_message || null,
    document_id: request.document_id || null,
    claimed_by: request.claimed_by || null,
    confirmed_at: request.confirmed_at || null,
    created_at: request.created_at,
    total_amount: rows.reduce((sum, row) => sum + row.amount, 0),
    payments: rows
  };
}

export async function getRequest(connection, id, { lock = false } = {}) {
  const [[request]] = await connection.query(
    `SELECT * FROM payment_confirmation_requests WHERE id = ? LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [id]
  );
  return request || null;
}

export async function listQueue(connection) {
  const [rows] = await connection.query(
    `SELECT * FROM payment_confirmation_requests
     ORDER BY status = 'confirmed', FIELD(status, 'ready', 'info_requested', 'awaiting_evidence', 'confirmed'), created_at`
  );
  return Promise.all(rows.map((request) => describeRequest(connection, request)));
}

export async function listForStartup(connection, startupId) {
  const [rows] = await connection.query(
    "SELECT * FROM payment_confirmation_requests WHERE startup_id = ? ORDER BY created_at",
    [startupId]
  );
  return Promise.all(rows.map((request) => describeRequest(connection, request)));
}

/* ------------------------------------------------------------ actions */

export async function attachBankEvidence(connection, request, startupDocumentId) {
  const rows = await getPaymentRows(connection, request);
  const status = deriveStatus({ ...request, status: null, evidence_document_id: startupDocumentId }, rows);
  await connection.query(
    `UPDATE payment_confirmation_requests
     SET evidence_document_id = ?, status = ?
     WHERE id = ? AND status <> 'confirmed'`,
    [startupDocumentId, status, request.id]
  );
  if (request.status !== CONFIRMATION_STATUS.READY && status === CONFIRMATION_STATUS.READY) {
    const company = await companyFor(connection, request.startup_id);
    const [confirmers] = await connection.query("SELECT email FROM users WHERE role = ?", [CONFIRMER_ROLE]);
    await Promise.allSettled(confirmers.map((confirmer) => sendEmail({
      to: confirmer.email,
      subject: `Dokumentasjon lastet opp – ${company.company_name || "selskapet"}`,
      text: `Hei,\n\n${company.company_name || "Selskapet"} har lastet opp kontoutskrift, og bekreftelsen er klar.\n\n${frontendBase()}/bekreftelser.html`
    })));
  }
  return status;
}

export async function requestMoreInformation(connection, request, { message, confirmer }) {
  await connection.query(
    `UPDATE payment_confirmation_requests
     SET status = 'info_requested', info_request_message = ?, info_requested_at = NOW(), evidence_document_id = NULL
     WHERE id = ? AND status <> 'confirmed'`,
    [message, request.id]
  );
  const company = await companyFor(connection, request.startup_id);
  if (company.startup_email) {
    await sendEmail({
      to: company.startup_email,
      subject: "Revisor trenger mer dokumentasjon",
      text: `Hei,\n\n${confirmer.name || "Revisor"} trenger mer dokumentasjon for å bekrefte ${kindLabel(request.kind)}:\n\n${message}\n\nLast opp her: ${frontendBase()}/${request.kind === CONFIRMATION_KINDS.CONVERSION ? "convert.html" : "dashboard.html"}`
    }).catch((error) => console.error("Info request e-mail failed:", error));
  }
}

/*
  The confirmer takes a request: the confirmation document is produced from the
  payments as they stand now, naming this confirmer, with them as its signer.
  Taking it again returns the same document.
*/
export async function claimRequest(connection, requestId, confirmer) {
  await connection.beginTransaction();
  try {
    const request = await getRequest(connection, requestId, { lock: true });
    if (!request) {
      await connection.rollback();
      return { ok: false, code: 404, error: "Fant ikke bekreftelsen." };
    }
    if (request.document_id) {
      await connection.rollback();
      return Number(request.claimed_by) === Number(confirmer.id)
        ? { ok: true, documentId: request.document_id }
        : { ok: false, code: 409, error: "En annen bekrefter har allerede tatt denne." };
    }
    if (request.status !== CONFIRMATION_STATUS.READY) {
      await connection.rollback();
      return { ok: false, code: 409, error: "Dokumentasjonen er ikke komplett ennå." };
    }

    const rows = await getPaymentRows(connection, request);
    if (request.kind === CONFIRMATION_KINDS.CONVERSION && rows.some((row) => !row.paid)) {
      await connection.rollback();
      return { ok: false, code: 409, error: "Ikke alle paribeløp er registrert som betalt." };
    }

    const company = await companyFor(connection, request.startup_id);
    const today = formatDate(new Date());
    const capacity = confirmer.confirmer_capacity || "revisor";
    let html;
    let type;
    let title;

    if (request.kind === CONFIRMATION_KINDS.CONVERSION) {
      const [[conversion]] = await connection.query("SELECT * FROM conversion_events WHERE id = ? LIMIT 1", [request.conversion_event_id]);
      const calculations = JSON.parse(conversion?.calculations_json || "{}");
      type = "CONVERSION_CAPITAL_CONFIRMATION";
      title = `Bekreftelse på innbetalt aksjekapital – ${company.company_name || ""}`.trim();
      html = fs.readFileSync(path.join(templatesDir, "conversion-capital-confirmation-template.html"), "utf8")
        .replace(/{{company_name}}/g, escapeHtml(company.company_name || ""))
        .replace(/{{orgnr}}/g, escapeHtml(company.orgnr || ""))
        .replace(/{{date}}/g, escapeHtml(today))
        .replace(/{{third_party_name}}/g, escapeHtml(confirmer.name || confirmer.email))
        .replace(/{{third_party_capacity}}/g, escapeHtml(capacity))
        .replace(/{{third_party_email}}/g, escapeHtml(confirmer.email))
        .replace(/{{trigger_type}}/g, escapeHtml(TRIGGER_LABELS[conversion?.trigger_type] || conversion?.trigger_type || ""))
        .replace(/{{conversion_date}}/g, escapeHtml(formatDate(conversion?.conversion_date)))
        .replace(/{{par_value_due_date}}/g, escapeHtml(formatDate(conversion?.par_value_due_date)))
        .replace(/{{payment_rows}}/g, paymentRowsHtml(rows, { withShares: true }))
        .replace(/{{evidence_basis}}/g, escapeHtml(evidenceBasisText(rows)))
        .replace(/{{total_new_shares}}/g, escapeHtml(Number(calculations.totals?.total_conversion_share_count || 0).toLocaleString("no-NO")))
        .replace(/{{total_nominal_amount}}/g, escapeHtml(formatNok(calculations.totals?.total_nominal_amount)))
        .replace(/{{total_share_premium}}/g, escapeHtml(formatNok(calculations.totals?.total_share_premium)));
    } else {
      type = "ROUND_PAYMENT_CONFIRMATION";
      title = `Bekreftelse på mottatte innbetalinger – ${company.company_name || ""}`.trim();
      html = fs.readFileSync(path.join(templatesDir, "round-payment-confirmation-template.html"), "utf8")
        .replace(/{{company_name}}/g, escapeHtml(company.company_name || ""))
        .replace(/{{orgnr}}/g, escapeHtml(company.orgnr || ""))
        .replace(/{{date}}/g, escapeHtml(today))
        .replace(/{{confirmer_name}}/g, escapeHtml(confirmer.name || confirmer.email))
        .replace(/{{confirmer_capacity}}/g, escapeHtml(capacity))
        .replace(/{{confirmer_email}}/g, escapeHtml(confirmer.email))
        .replace(/{{payment_rows}}/g, paymentRowsHtml(rows))
        .replace(/{{evidence_basis}}/g, escapeHtml(evidenceBasisText(rows)))
        .replace(/{{agreement_count}}/g, String(rows.length))
        .replace(/{{total_amount}}/g, escapeHtml(formatNok(rows.reduce((sum, row) => sum + row.amount, 0))));
    }

    const [documentResult] = await connection.query(
      `INSERT INTO documents (type, startup_id, round_id, title, html_content, status)
       VALUES (?, ?, ?, ?, ?, 'DRAFT')`,
      [type, request.startup_id, request.round_id, title, html]
    );
    const documentId = documentResult.insertId;
    await connection.query(
      `INSERT INTO document_signers (document_id, user_id, email, role, status)
       VALUES (?, ?, ?, ?, 'ACCEPTED')`,
      [documentId, confirmer.id, confirmer.email, CONFIRMER_SIGNER_ROLE]
    );
    await connection.query(
      `UPDATE payment_confirmation_requests
       SET document_id = ?, claimed_by = ?, claimed_at = NOW()
       WHERE id = ?`,
      [documentId, confirmer.id, request.id]
    );
    if (request.kind === CONFIRMATION_KINDS.CONVERSION) {
      await connection.query(
        `UPDATE conversion_events
         SET capital_confirmation_document_id = ?, third_party_name = ?, third_party_email = ?
         WHERE id = ?`,
        [documentId, confirmer.name || confirmer.email, confirmer.email, request.conversion_event_id]
      );
    }
    await recordAuditEvent(connection, AUDIT_EVENTS.CONFIRMATION_CLAIMED, {
      startupId: request.startup_id,
      roundId: request.round_id,
      documentId,
      actorUserId: confirmer.id,
      actorRole: CONFIRMER_ROLE,
      metadata: { request_id: request.id, kind: request.kind, conversion_event_id: request.conversion_event_id }
    });

    await connection.commit();
    return { ok: true, documentId };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/*
  Called by the signing route when a document locks. If it is a confirmation,
  the request is done, the evidence is recorded and the company is told.
*/
export async function completeConfirmationForDocument(connection, documentId, { actorUserId = null, documentHash = null } = {}) {
  if (!(await tableExists(connection, "payment_confirmation_requests"))) return null;
  const [[request]] = await connection.query(
    "SELECT * FROM payment_confirmation_requests WHERE document_id = ? LIMIT 1",
    [documentId]
  );
  if (!request || request.status === CONFIRMATION_STATUS.CONFIRMED) return null;

  await connection.query(
    `UPDATE payment_confirmation_requests
     SET status = 'confirmed', confirmed_by = ?, confirmed_at = NOW()
     WHERE id = ? AND status <> 'confirmed'`,
    [actorUserId, request.id]
  );
  await enqueueCriticalAuditEvent(
    connection,
    request.kind === CONFIRMATION_KINDS.CONVERSION ? AUDIT_EVENTS.SHARE_CONTRIBUTION_CONFIRMED : AUDIT_EVENTS.ROUND_PAYMENTS_CONFIRMED,
    {
      startupId: request.startup_id,
      roundId: request.round_id,
      documentId,
      documentHash,
      actorUserId,
      actorRole: CONFIRMER_ROLE,
      metadata: { request_id: request.id, conversion_event_id: request.conversion_event_id }
    }
  );
  return request;
}

export async function notifyConfirmationCompleted(connection, request) {
  const company = await companyFor(connection, request.startup_id);
  if (!company.startup_email) return;
  await sendEmail({
    to: company.startup_email,
    subject: request.kind === CONFIRMATION_KINDS.CONVERSION
      ? "Revisor har bekreftet aksjeinnskuddet"
      : "Revisor har bekreftet innbetalingene i runden",
    text: request.kind === CONFIRMATION_KINDS.CONVERSION
      ? `Hei,\n\nRevisor har bekreftet at aksjeinnskuddet er innbetalt. Bekreftelsen ligger i dokumentpakken til Foretaksregisteret.\n\n${frontendBase()}/convert.html`
      : `Hei,\n\nRevisor har bekreftet innbetalingene i RC-runden. Bekreftelsen ligger blant dokumentene deres i Raisium.\n\n${frontendBase()}/dashboard.html`
  }).catch((error) => console.error("Confirmation completed e-mail failed:", error));
}
