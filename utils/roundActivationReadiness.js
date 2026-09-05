import { calculateRcConversion } from "./rcConversionCalculator.js";
import {
  confirmationMatches,
  getActiveArticlesConfirmation
} from "./articlesConfirmation.js";
import { ensureStartupArticlesParsed } from "./startupArticlesBasis.js";

/*
  One authoritative backend check for whether a private round may go live.

  Everything downstream of activation — the share price an investor is quoted,
  the number of shares they are later allocated, the par amount they must pay,
  the capital increase the company must resolve — is derived from the company's
  share basis and the round's terms. If those are wrong or inconsistent at
  activation, the error is only discovered at conversion, by which point money
  has been taken and agreements have been signed.

  So this fails closed: anything missing or inconsistent blocks activation.
*/

// Product-level warning only. Not a legal threshold.
export const PAR_AMOUNT_WARNING_RATIO = 0.10;

function safeParseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    LIMIT 1
    `,
    [tableName]
  );
  return rows.length > 0;
}

/*
  Resolves the company's share basis and says where each number came from.

  The Articles of Association are the authoritative source: they are what the
  company is legally bound by and what Foretaksregisteret holds. A value typed
  into the profile is accepted only where the Articles are silent, and a
  disagreement between the two is an error rather than something to resolve
  silently in either direction.
*/
export async function resolveShareBasis(connection, startupId) {
  const [profileRows] = await connection.query(
    `
    SELECT nominal_value_per_share, current_share_count, share_basis_temporary
    FROM startup_profiles WHERE user_id = ? LIMIT 1
    `,
    [startupId]
  );
  const profile = profileRows[0] || null;

  let articlesRow = null;
  if (await tableExists(connection, "startup_documents")) {
    const hasDocumentType = await columnExists(connection, "startup_documents", "document_type");
    const hasFileData = await columnExists(connection, "startup_documents", "file_data");
    const [rows] = await connection.query(
      `
      SELECT id, filename, url, mime_type, parse_status, parsed_fields_json
             ${hasFileData ? ", file_data" : ""}
      FROM startup_documents
      WHERE startup_id = ?
        ${hasDocumentType ? "AND document_type = 'current_articles_of_association'" : ""}
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 1
      `,
      [startupId]
    );
    articlesRow = rows[0] ? await ensureStartupArticlesParsed(connection, rows[0]) : null;
  }

  const parsed = safeParseJson(articlesRow?.parsed_fields_json);
  const articlesPar = Number(parsed?.nominal_value || 0) || null;
  const articlesShareCount = Number(parsed?.share_count || 0) || null;
  const articlesCapital = Number(parsed?.share_capital_amount || 0) || null;

  const profilePar = Number(profile?.nominal_value_per_share || 0) || null;
  const profileShareCount = Number(profile?.current_share_count || 0) || null;

  const issues = [];

  // A disagreement between the Articles and the profile is never resolved
  // silently — the company has to correct one of them.
  if (articlesPar && profilePar && Math.abs(articlesPar - profilePar) > 0.0001) {
    issues.push(
      `Pålydende per aksje i profilen (${profilePar}) stemmer ikke med gjeldende vedtekter (${articlesPar}). Rett opp før runden åpnes.`
    );
  }
  if (articlesShareCount && profileShareCount && articlesShareCount !== profileShareCount) {
    issues.push(
      `Antall aksjer i profilen (${profileShareCount}) stemmer ikke med gjeldende vedtekter (${articlesShareCount}). Rett opp før runden åpnes.`
    );
  }

  const parValue = articlesPar || profilePar || null;
  const shareCount = articlesShareCount || profileShareCount || null;
  const shareCapital = articlesCapital || (parValue && shareCount ? parValue * shareCount : null);

  // Share capital must equal share count times par value for a company with a
  // single uniform par value. If it does not, one of the three is wrong and no
  // downstream calculation can be trusted.
  if (parValue && shareCount && shareCapital) {
    const expected = parValue * shareCount;
    if (Math.abs(expected - shareCapital) > 0.5) {
      issues.push(
        `Aksjekapitalen (${shareCapital}) stemmer ikke med antall aksjer × pålydende (${shareCount} × ${parValue} = ${expected}). Rett opp grunnlaget før runden åpnes.`
      );
    }
  }

  return {
    par_value: parValue,
    share_count: shareCount,
    share_capital_amount: shareCapital,
    par_value_source: articlesPar ? "articles" : (profilePar ? "profile" : null),
    share_count_source: articlesShareCount ? "articles" : (profileShareCount ? "profile" : null),
    articles_document_id: articlesRow?.id || null,
    articles_parse_status: articlesRow?.parse_status || null,
    share_basis_temporary: Boolean(Number(profile?.share_basis_temporary || 0)),
    issues
  };
}

/*
  Illustrative economics for the round, shown to the company before it opens.
  Uses the valuation cap as the share price basis, which is the price a cap-only
  trigger produces and the upper bound on the price for any other trigger — so
  the par amount shown here is the smallest the investor could face.
*/
export function buildParPreview({ valuationCap, shareCount, parValue, exampleInvestment }) {
  const cap = Number(valuationCap || 0);
  const shares = Number(shareCount || 0);
  const par = Number(parValue || 0);
  const investment = Number(exampleInvestment || 0);

  if (!cap || !shares || !par || !investment) return null;

  const sharePrice = Math.round((cap / shares) * 100) / 100;
  if (sharePrice <= par) {
    return {
      share_price: sharePrice,
      par_value: par,
      blocked: true,
      reason:
        `Tegningskursen med denne valuation cap-en (${sharePrice} per aksje) er ikke høyere enn aksjenes pålydende (${par}). ` +
        "Konvertering kan ikke gjennomføres på disse vilkårene."
    };
  }

  const result = calculateRcConversion({
    investment_amount: investment,
    valuation_cap: cap,
    trigger_type: "ownership_change",
    capitalization_base_share_count: shares,
    nominal_value_per_share: par
  });

  const ratio = result.par_amount / investment;

  return {
    current_share_count: shares,
    par_value: par,
    valuation_cap: cap,
    share_price: result.share_price,
    example_investment: investment,
    rc_shares: result.final_share_count,
    par_amount: result.par_amount,
    par_amount_ratio: ratio,
    warn: ratio >= PAR_AMOUNT_WARNING_RATIO,
    blocked: false
  };
}

/*
  The full activation gate. Returns { ready, blockers, warnings, basis, preview }.
*/
export async function checkRoundActivationReadiness(connection, startupId, round) {
  const blockers = [];
  const warnings = [];

  if (!round) {
    return { ready: false, blockers: ["Fant ingen runde å åpne."], warnings, basis: null, preview: null };
  }

  const basis = await resolveShareBasis(connection, startupId);
  blockers.push(...basis.issues);

  if (!basis.articles_document_id) {
    blockers.push("Gjeldende vedtekter må lastes opp før runden kan åpnes.");
  }
  if (!basis.par_value) {
    blockers.push("Pålydende per aksje mangler. Det hentes fra vedtektene eller registreres i profilen.");
  }
  if (!basis.share_count) {
    blockers.push("Gjeldende antall aksjer mangler. Det hentes fra vedtektene eller registreres i profilen.");
  }
  if (!basis.share_capital_amount) {
    blockers.push("Selskapets aksjekapital mangler og kan ikke utledes av antall aksjer og pålydende.");
  }
  if (basis.share_basis_temporary) {
    blockers.push(
      "Aksjegrunnlaget er markert som foreløpig. Bekreft pålydende og antall aksjer mot gjeldende vedtekter før runden åpnes."
    );
  }

  /*
    A parser reading a PDF, and a model filling in what the parser missed, are
    both useful and neither is legal truth. Before the round opens, a person at
    the company has to look at the three figures the whole model rests on and
    confirm they match the current articles — and confirm the figures the system
    actually holds, not an earlier set that has since been edited.
  */
  const confirmation = await getActiveArticlesConfirmation(connection, startupId);
  if (!confirmation) {
    blockers.push(
      "Aksjekapital, antall aksjer og pålydende må bekreftes mot gjeldende vedtekter før runden kan åpnes."
    );
  } else if (!confirmationMatches(confirmation, {
    shareCapital: basis.share_capital_amount,
    shareCount: basis.share_count,
    parValue: basis.par_value
  })) {
    blockers.push(
      "Aksjegrunnlaget er endret etter at det ble bekreftet. Kontroller tallene mot gjeldende vedtekter og bekreft på nytt."
    );
  }

  const targetAmount = Number(round.target_amount || 0);
  const valuationCap = Number(round.valuation_cap || 0);
  const triggerPeriod = Number(round.trigger_period || round.conversion_years || 0);

  if (!targetAmount || targetAmount <= 0) {
    blockers.push("Målbeløp for runden må være satt.");
  }
  if (!valuationCap || valuationCap <= 0) {
    blockers.push("Valuation cap må være satt.");
  }
  if (!triggerPeriod || triggerPeriod < 1) {
    blockers.push("Triggerperioden (long-stop) må være satt til minst 1 år.");
  }
  if (!String(round.bank_account || "").trim()) {
    blockers.push("Kontonummer for innbetaling må være satt.");
  }

  // The invariant the whole model rests on: the investor's share price has to
  // exceed par, or no number of shares can carry the investment amount.
  let preview = null;
  if (valuationCap > 0 && basis.share_count && basis.par_value) {
    const sharePrice = Math.round((valuationCap / basis.share_count) * 100) / 100;
    if (sharePrice <= basis.par_value) {
      blockers.push(
        `Tegningskursen med denne valuation cap-en (${sharePrice} per aksje) er ikke høyere enn aksjenes pålydende ` +
        `(${basis.par_value}). Øk valuation cap, eller gjennomgå selskapets aksjestruktur, før runden åpnes.`
      );
    } else if (targetAmount > 0) {
      preview = buildParPreview({
        valuationCap,
        shareCount: basis.share_count,
        parValue: basis.par_value,
        exampleInvestment: targetAmount
      });
      if (preview?.warn) {
        warnings.push(
          `Investorene må til sammen betale ca. ${preview.par_amount} NOK i aksjeinnskudd ved konvertering — ` +
          `ca. ${(preview.par_amount_ratio * 100).toFixed(1)} % av investeringsbeløpet. Det kommer i tillegg til det de allerede har betalt.`
        );
      }
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    basis,
    preview,
    articles_confirmation: confirmation
      ? {
          confirmed_at: confirmation.confirmed_at,
          confirmed_by: confirmation.confirmed_by,
          source: confirmation.source,
          share_capital_amount: Number(confirmation.share_capital_amount),
          share_count: Number(confirmation.share_count),
          par_value_per_share: Number(confirmation.par_value_per_share),
          matches_current_basis: confirmationMatches(confirmation, {
            shareCapital: basis.share_capital_amount,
            shareCount: basis.share_count,
            parValue: basis.par_value
          })
        }
      : null
  };
}
