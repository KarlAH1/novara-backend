import express from "express";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import { renderHtmlToPdfBuffer } from "../utils/pdfRenderer.js";
import { fileURLToPath } from "url";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { resolveCompanyStartupOwner } from "../utils/startupContext.js";
import {
  aggregateRcConversions,
  calculateRcConversion,
  RC_CALCULATION_VERSION
} from "../utils/rcConversionCalculator.js";
import { ensureStartupArticlesParsed } from "../utils/startupArticlesBasis.js";
import { buildUpdatedArticlesDraft } from "../utils/updatedArticlesBuilder.js";
import { fetchBrregCompany } from "../utils/brreg.js";
import { sendEmail } from "../utils/emailService.js";
import {
  sendConversionStartedEmail,
  sendDocumentSigningRequestEmail,
  sendRoundClosedEmail
} from "../utils/notificationEmailFlow.js";
import { sendTelegramAdminAlert } from "../utils/telegramNotifier.js";
import { getEmissionRoundColumns } from "../utils/emissionRoundState.js";
import { decryptNationalId } from "../utils/nationalIdCrypto.js";
import { AUDIT_EVENTS, getClientIp, recordAuditEvent } from "../utils/auditLogger.js";
import {
  assertSignerMatchesBody,
  confirmBoardRole,
  getConfirmedBoardRole,
  requireConfirmedChair,
  suggestBoardChair
} from "../utils/boardChairResolution.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templatesDir = path.resolve(__dirname, "../templates");
const frontendBase = String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    LIMIT 1
    `,
    [tableName]
  );

  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );

  return rows.length > 0;
}

function getTriggerLabel(triggerType) {
  if (triggerType === "new_round" || triggerType === "new_priced_round") return "Ny emisjon";
  if (triggerType === "ownership_change") return "Ny eierstruktur";
  if (triggerType === "time_elapsed") return "Tidsfrist nådd";
  if (triggerType === "target_reached") return "Målbeløp nådd";
  return "Ikke valgt";
}

function safeParseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function formatDateLabel(value) {
  if (!value) return "Ikke satt";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("no-NO", { year: "numeric", month: "long", day: "numeric" });
}

function formatDateTimeLabel(value) {
  if (!value) return "Ikke satt";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("no-NO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function makeSafeFilename(input, fallback) {
  const raw = String(input || "").trim();
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9æøå\-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback || "dokument";
}

function formatCurrency(value) {
  const numeric = Number(value || 0);
  return `${numeric.toLocaleString("no-NO", { maximumFractionDigits: 2 })} NOK`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeTriggerType(triggerType) {
  const normalized = String(triggerType || "").trim();
  return normalized === "new_round" ? "new_priced_round" : normalized;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function subtractDays(value, days) {
  return addDays(value, -days);
}

function toMysqlDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseRequestedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

async function getRcAgreementColumns(connection) {
  const [rows] = await connection.query("SHOW COLUMNS FROM rc_agreements");
  return new Set(rows.map((row) => row.Field));
}

async function getTargetReachedAt(connection, round) {
  if (!round) return null;

  const targetAmount = Number(round.target_amount || 0);
  if (!targetAmount || targetAmount <= 0) {
    return null;
  }

  const rcColumns = await getRcAgreementColumns(connection);
  const orderColumn = rcColumns.has("payment_confirmed_by_startup_at")
    ? "a.payment_confirmed_by_startup_at"
    : "a.created_at";

  const [rows] = await connection.query(
    `
    SELECT
      a.investment_amount,
      ${orderColumn} AS effective_confirmed_at
    FROM rc_agreements a
    WHERE a.round_id = ?
      AND a.status = 'Active RC'
    ORDER BY effective_confirmed_at ASC, a.id ASC
    `,
    [round.id]
  );

  let cumulative = 0;
  for (const row of rows) {
    cumulative += Number(row.investment_amount || 0);
    if (cumulative >= targetAmount && row.effective_confirmed_at) {
      return new Date(row.effective_confirmed_at);
    }
  }

  if (round.closed_reason === "target_reached" && round.closed_at) {
    const fallbackDate = new Date(round.closed_at);
    if (!Number.isNaN(fallbackDate.getTime())) {
      return fallbackDate;
    }
  }

  return null;
}

async function evaluateTriggerApproval(connection, round, triggerType) {
  const normalizedTriggerType = normalizeTriggerType(triggerType);
  if (!["new_priced_round", "ownership_change"].includes(normalizedTriggerType)) {
    return {
      requiresAdminApproval: false,
      targetReachedAt: null,
      approvalBlockedUntil: null,
      reason: null
    };
  }

  const targetReachedAt = await getTargetReachedAt(connection, round);
  if (!targetReachedAt) {
    return {
      requiresAdminApproval: false,
      targetReachedAt: null,
      approvalBlockedUntil: null,
      reason: null
    };
  }

  const approvalBlockedUntil = addDays(targetReachedAt, 30);
  const requiresAdminApproval = approvalBlockedUntil.getTime() > Date.now();

  return {
    requiresAdminApproval,
    targetReachedAt,
    approvalBlockedUntil,
    reason: requiresAdminApproval
      ? `Trigger event er registrert mindre enn 30 dager etter at målbeløpet ble nådd (${formatDateLabel(targetReachedAt)}). Admin må godkjenne før dokumentflyten kan starte.`
      : null
  };
}

function buildParValueReference(agreementId, conversionId) {
  const safeAgreementId = String(agreementId || "").trim() || "0";
  const safeConversionId = String(conversionId || "").trim() || "0";
  return `PARI-${safeConversionId}-${safeAgreementId}`;
}

async function getLatestRoundForStartup(connection, startupId) {
  const [rows] = await connection.query(
    `
    SELECT id, startup_id, target_amount, amount_raised, committed_amount, conversion_years, trigger_period, discount_rate, valuation_cap, deadline, closed_reason, bank_account, created_at
    FROM emission_rounds
    WHERE startup_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [startupId]
  );

  return rows[0] || null;
}

async function hasConversionRoundId(connection) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'conversion_events'
      AND COLUMN_NAME = 'round_id'
    LIMIT 1
    `
  );

  return rows.length > 0;
}

async function getCurrentConversionEvent(connection, startupId, roundId) {
  const hasRoundId = await hasConversionRoundId(connection);
  const [rows] = await connection.query(
    hasRoundId
      ? `
        SELECT *
        FROM conversion_events
        WHERE startup_id = ? AND round_id = ?
        ORDER BY id DESC
        LIMIT 1
        `
      : `
        SELECT *
        FROM conversion_events
        WHERE startup_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
    hasRoundId ? [startupId, roundId] : [startupId]
  );

  return rows[0] || null;
}

function resolveConversionTimeline(round, triggerType, requestedDate) {
  const normalizedTriggerType = normalizeTriggerType(triggerType);
  const noticeBaseDate = new Date();
  const defaultParValueDueDate = addDays(noticeBaseDate, 7);

  if (normalizedTriggerType === "time_elapsed") {
    const deadline = parseRequestedDate(round?.deadline);
    if (!deadline) {
      return { conversionDate: null, parValueDueDate: null };
    }

    return {
      conversionDate: deadline,
      parValueDueDate: defaultParValueDueDate
    };
  }

  const explicitDate = parseRequestedDate(requestedDate);
  const conversionDate = explicitDate || addDays(new Date(), 3);

  return {
    conversionDate,
    parValueDueDate: defaultParValueDueDate
  };
}

async function ensureAutoTimeElapsedConversion(connection, startupId, round) {
  if (!round?.deadline) {
    return null;
  }

  const deadline = new Date(round.deadline);
  if (Number.isNaN(deadline.getTime())) {
    return null;
  }

  const preparationStart = subtractDays(deadline, 3);
  if (preparationStart.getTime() > Date.now()) {
    return null;
  }

  const existing = await getCurrentConversionEvent(connection, startupId, round.id);
  if (existing) {
    return existing;
  }

  const parValueDueDate = addDays(new Date(), 7);

  const [result] = await connection.query(
    `
    INSERT INTO conversion_events (
      startup_id, round_id, trigger_type, status, conversion_date, par_value_due_date, preparation_started_at, started_automatically
    )
    VALUES (?, ?, 'time_elapsed', 'triggered', ?, ?, NOW(), 1)
    `,
    [
      startupId,
      round.id,
      toMysqlDateTime(deadline),
      toMysqlDateTime(parValueDueDate)
    ]
  );

  await recordAuditEvent(connection, AUDIT_EVENTS.TRIGGER_DETECTED, {
      startupId, roundId: round.id,
      actorRole: "system",
      triggerType: "time_elapsed",
      newStatus: "triggered",
      metadata: { conversion_event_id: result.insertId, automatic: true, deadline: round.deadline }
    });

  return {
    id: result.insertId,
    startup_id: startupId,
    round_id: round.id,
    trigger_type: "time_elapsed",
    status: "triggered",
    conversion_date: toMysqlDateTime(deadline),
    par_value_due_date: toMysqlDateTime(parValueDueDate),
    started_automatically: 1
  };
}

async function getConversionParticipants(connection, roundId) {
  const [rows] = await connection.query(
    `
    SELECT
      a.id,
      a.investor_id,
      a.investment_amount,
      a.rc_id,
      COALESCE(u.name, u.email) AS investor_name,
      u.email AS investor_email
    FROM rc_agreements a
    LEFT JOIN users u ON u.id = a.investor_id
    WHERE a.round_id = ?
      AND a.status = 'Active RC'
    ORDER BY a.id ASC
    `,
    [roundId]
  );

  return rows;
}

async function getConversionBasis(connection, startupId) {
  const [profileRows] = await connection.query(
    `
    SELECT nominal_value_per_share, current_share_count, share_basis_temporary
    FROM startup_profiles
    WHERE user_id = ?
    LIMIT 1
    `,
    [startupId]
  );

  let articlesRows = [[]];
  if (await tableExists(connection, "startup_documents")) {
    const hasDocumentType = await columnExists(connection, "startup_documents", "document_type");
    const hasMimeType = await columnExists(connection, "startup_documents", "mime_type");
    const hasParseStatus = await columnExists(connection, "startup_documents", "parse_status");
    const hasParsedFields = await columnExists(connection, "startup_documents", "parsed_fields_json");
    const hasExtractedText = await columnExists(connection, "startup_documents", "extracted_text");

    articlesRows = await connection.query(
      `
      SELECT id, filename, url,
             ${hasMimeType ? "mime_type" : "NULL AS mime_type"},
             ${hasParseStatus ? "parse_status" : "'not_started' AS parse_status"},
             ${hasParsedFields ? "parsed_fields_json" : "NULL AS parsed_fields_json"},
             ${hasExtractedText ? "extracted_text" : "NULL AS extracted_text"},
             uploaded_at
      FROM startup_documents
      WHERE startup_id = ?
        ${hasDocumentType ? "AND document_type = 'current_articles_of_association'" : ""}
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 1
      `,
      [startupId]
    );
  }

  const profileBasis = profileRows[0] || null;
  const rawArticles = articlesRows[0] || null;
  const articlesBasisRow = rawArticles
    ? await ensureStartupArticlesParsed(connection, rawArticles)
    : null;
  const parsedArticles = safeParseJson(articlesBasisRow?.parsed_fields_json);

  const resolvedNominalValue = Number(profileBasis?.nominal_value_per_share || 0) > 0
    ? Number(profileBasis.nominal_value_per_share)
    : (Number(parsedArticles?.nominal_value || 0) > 0 ? Number(parsedArticles.nominal_value) : null);

  const parsedShareCount = Number(parsedArticles?.share_count || 0);
  const parsedShareCapital = Number(parsedArticles?.share_capital_amount || 0);
  const derivedShareCount = parsedShareCapital > 0 && Number(resolvedNominalValue || 0) > 0
    ? Math.round(parsedShareCapital / Number(resolvedNominalValue))
    : null;

  const resolvedCurrentShareCount = Number(profileBasis?.current_share_count || 0) > 0
    ? Math.round(Number(profileBasis.current_share_count))
    : (parsedShareCount > 0 ? Math.round(parsedShareCount) : derivedShareCount);

  const missingFields = [];
  if (!Number(resolvedNominalValue || 0)) missingFields.push("pålydende per aksje");
  if (!Number(resolvedCurrentShareCount || 0)) missingFields.push("gjeldende antall aksjer");
  if (!articlesBasisRow) missingFields.push("gjeldende vedtekter");
  const isShareBasisTemporary = Boolean(Number(profileBasis?.share_basis_temporary || 0));
  if (isShareBasisTemporary) missingFields.push("foreløpig aksjegrunnlag");

  if (isShareBasisTemporary && articlesBasisRow && Number(resolvedNominalValue || 0) > 0 && Number(resolvedCurrentShareCount || 0) > 0) {
    await connection.query(
      "UPDATE startup_profiles SET share_basis_temporary = 0 WHERE user_id = ?",
      [startupId]
    );
  }

  return {
    nominal_value_per_share: resolvedNominalValue,
    current_share_count: resolvedCurrentShareCount,
    current_share_capital_amount: parsedShareCapital || (resolvedCurrentShareCount && resolvedNominalValue
      ? Number(resolvedCurrentShareCount) * Number(resolvedNominalValue)
      : null),
    share_basis_temporary: isShareBasisTemporary,
    missing_fields: missingFields,
    is_complete: missingFields.length === 0,
    articles_document: articlesBasisRow
      ? {
          id: articlesBasisRow.id,
          filename: articlesBasisRow.filename,
          url: articlesBasisRow.url,
          parse_status: articlesBasisRow.parse_status,
          parsed_fields: parsedArticles
        }
      : null
  };
}

function buildShareholderRegisterRows(existingShareholders, currentShareCount, investors) {
  const normalizedCurrentShareCount = Number(currentShareCount || 0);
  const rows = [];

  if (Array.isArray(existingShareholders) && existingShareholders.length && normalizedCurrentShareCount > 0) {
    let allocatedShares = 0;
    existingShareholders.forEach((holder, index) => {
      const isLast = index === existingShareholders.length - 1;
      const percentage = Number(holder.ownership_percent || 0);
      let shareCount = Math.floor((normalizedCurrentShareCount * percentage) / 100);

      if (isLast) {
        shareCount = Math.max(normalizedCurrentShareCount - allocatedShares, 0);
      }

      allocatedShares += shareCount;
      rows.push({
        shareholder_name: holder.shareholder_name,
        identifier_value: "",
        digital_address: "",
        residential_address: "",
        share_class: "A",
        share_count: shareCount,
        entry_date: ""
      });
    });
  }

  (investors || []).forEach((investor) => {
    const profile = investor.legal_profile || {};
    rows.push({
      shareholder_name: profile.full_name || investor.investor_name || investor.investor_email || `Investor ${investor.agreement_id}`,
      identifier_value: profile.birth_date || "",
      digital_address: profile.digital_address || investor.investor_email || "",
      residential_address: [profile.residential_address, profile.postal_code, profile.city, profile.country]
        .filter(Boolean)
        .join(", "),
      share_class: "A",
      share_count: Number(investor.conversion_share_count || 0),
      entry_date: investor.entry_date || ""
    });
  });

  const totalShares = rows.reduce((sum, row) => sum + Number(row.share_count || 0), 0);
  let currentNumber = 1;

  return rows.map((row) => {
    const shareCount = Number(row.share_count || 0);
    const rangeStart = shareCount > 0 ? currentNumber : null;
    const rangeEnd = shareCount > 0 ? currentNumber + shareCount - 1 : null;

    if (shareCount > 0) {
      currentNumber = rangeEnd + 1;
    }

    return {
      ...row,
      ownership_percent: totalShares > 0 ? ((shareCount / totalShares) * 100) : 0,
      share_range_label: rangeStart && rangeEnd
        ? `${rangeStart.toLocaleString("no-NO")}–${rangeEnd.toLocaleString("no-NO")}`
        : "",
      entry_date_display: row.entry_date ? formatDateLabel(row.entry_date) : ""
    };
  });
}

function buildExistingShareholderSeedRows(existingShareholders, currentShareCount) {
  const normalizedCurrentShareCount = Number(currentShareCount || 0);
  if (!Array.isArray(existingShareholders) || !existingShareholders.length || normalizedCurrentShareCount <= 0) {
    return [];
  }

  let allocatedShares = 0;

  return existingShareholders.map((holder, index) => {
    const isLast = index === existingShareholders.length - 1;
    const percentage = Number(holder.ownership_percent || 0);
    let shareCount = Math.floor((normalizedCurrentShareCount * percentage) / 100);

    if (isLast) {
      shareCount = Math.max(normalizedCurrentShareCount - allocatedShares, 0);
    }

    allocatedShares += shareCount;

    return {
      emission_shareholder_id: Number(holder.id || 0) || null,
      shareholder_name: holder.shareholder_name || holder.name || `Aksjonær ${index + 1}`,
      share_count: shareCount,
      display_order: index + 1
    };
  });
}

async function ensureExistingShareholderTaskRows(connection, conversionId, roundId, currentShareCount) {
  if (!conversionId || !roundId) {
    return [];
  }

  if (!(await tableExists(connection, "conversion_existing_shareholders"))) {
    return [];
  }

  if (!(await tableExists(connection, "emission_shareholders"))) {
    return [];
  }

  const [existingTaskRows] = await connection.query(
    `
    SELECT id, conversion_event_id, emission_shareholder_id, shareholder_name, birth_date,
           digital_address, residential_address, share_count, share_numbers, share_class,
           display_order, completed_at
    FROM conversion_existing_shareholders
    WHERE conversion_event_id = ?
    ORDER BY display_order ASC, id ASC
    `,
    [conversionId]
  );

  if (existingTaskRows.length) {
    return existingTaskRows;
  }

  const [shareholderRows] = await connection.query(
    `
    SELECT id, shareholder_name, ownership_percent
    FROM emission_shareholders
    WHERE emission_id = ?
    ORDER BY id ASC
    `,
    [roundId]
  );

  const seedRows = buildExistingShareholderSeedRows(shareholderRows, currentShareCount);
  for (const row of seedRows) {
    await connection.query(
      `
      INSERT INTO conversion_existing_shareholders
      (conversion_event_id, emission_shareholder_id, shareholder_name, share_count, share_class, display_order)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [conversionId, row.emission_shareholder_id, row.shareholder_name, row.share_count, "A", row.display_order]
    );
  }

  const [createdRows] = await connection.query(
    `
    SELECT id, conversion_event_id, emission_shareholder_id, shareholder_name, birth_date,
           digital_address, residential_address, share_count, share_numbers, share_class,
           display_order, completed_at
    FROM conversion_existing_shareholders
    WHERE conversion_event_id = ?
    ORDER BY display_order ASC, id ASC
    `,
    [conversionId]
  );

  return createdRows;
}

function isExistingShareholderTaskComplete(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return true;
  }

  return rows.every((row) =>
    String(row.shareholder_name || "").trim() &&
    String(row.birth_date || "").trim() &&
    String(row.digital_address || "").trim() &&
    String(row.residential_address || "").trim() &&
    Number(row.share_count || 0) > 0 &&
    String(row.share_class || "").trim()
  );
}

function buildShareholderRegisterHtml({ companyName, orgnr, date, totalShareCapital, totalShareCount, nominalValue, shareClass, rows }) {
  const templatePath = path.join(templatesDir, "eierregister-template.html");
  let template = fs.readFileSync(templatePath, "utf8");
  const htmlRows = rows.map((row) => `
        <tr>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.shareholder_name)}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.identifier_value)}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.digital_address)}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.residential_address)}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0; text-align:center;">${escapeHtml(row.share_class || "A")}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0; text-align:right;">${escapeHtml(Number(row.share_count || 0).toLocaleString("no-NO"))}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.share_range_label)}</td>
          <td style="padding: 12px 14px; border-top: 1px solid #e6ddd0;">${escapeHtml(row.entry_date_display)}</td>
        </tr>
  `).join("");

  return template
    .replace(/{{company_name}}/g, escapeHtml(companyName))
    .replace(/{{orgnr}}/g, escapeHtml(orgnr))
    .replace(/{{date}}/g, escapeHtml(date))
    .replace(/{{share_capital}}/g, escapeHtml(formatCurrency(totalShareCapital)))
    .replace(/{{share_count}}/g, escapeHtml(Number(totalShareCount || 0).toLocaleString("no-NO")))
    .replace(/{{nominal_value}}/g, escapeHtml(formatCurrency(nominalValue)))
    .replace(/{{share_class}}/g, escapeHtml(shareClass || "A"))
    .replace(/{{rows}}/g, htmlRows);
}

async function createDocument(connection, { type, startupId, roundId, title, html, signers = [] }) {
  const [docResult] = await connection.query(
    `
    INSERT INTO documents (type, startup_id, round_id, title, html_content, status)
    VALUES (?, ?, ?, ?, ?, 'DRAFT')
    `,
    [type, startupId, roundId || null, title, html]
  );

  for (const signer of signers) {
    await connection.query(
      `
      INSERT INTO document_signers (document_id, email, user_id, role, status)
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        docResult.insertId,
        signer.email,
        signer.user_id || null,
        signer.role,
        signer.status || "INVITED"
      ]
    );
  }

  return docResult.insertId;
}

function buildSignUrl(documentType, documentId) {
  if (!documentId || !frontendBase) return "";
  if (["SFC", "GFC", "CONVERSION_CAPITAL_CONFIRMATION"].includes(documentType)) {
    return `${frontendBase}/sign.html?type=conversion&id=${documentId}`;
  }
  return "";
}

async function notifyDocumentSigners({ type, documentId, title, companyName, signers = [] }) {
  const signUrl = buildSignUrl(type, documentId);
  if (!signUrl || !Array.isArray(signers) || !signers.length) return;

  await Promise.all(
    signers
      .filter((signer) => signer?.email)
      .map((signer) =>
        sendDocumentSigningRequestEmail({
          to: signer.email,
          companyName,
          roleLabel: signer.role,
          documentTitle: title,
          signUrl
        })
      )
  );
}

async function findUserByEmail(connection, email) {
  if (!email) return null;
  const [rows] = await connection.query(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    [String(email).trim().toLowerCase()]
  );
  return rows[0] || null;
}

/*
  Once a trigger event has been calculated, that calculation is frozen. Every
  downstream artefact — the par value requests investors are notified about, the
  board proposal, the GF resolution, the updated Articles, the shareholder
  register — must be driven by the same numbers.

  Recalculating on each read would let a later edit to the startup's share
  basis silently change an investor's allocation after they had already been
  told what to pay, and would let two documents generated minutes apart
  disagree. So the frozen snapshot wins whenever one exists.
*/
function readFrozenCalculations(conversion) {
  if (!conversion?.calculations_json) return null;

  try {
    const parsed = JSON.parse(conversion.calculations_json);
    if (!parsed?.frozen_at || !Array.isArray(parsed.investors) || !parsed.investors.length) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function buildConversionCalculations(connection, startupId, round, conversion) {
  const basis = await getConversionBasis(connection, startupId);
  const participants = await getConversionParticipants(connection, round.id);

  const frozen = readFrozenCalculations(conversion);
  if (frozen) {
    return { basis, participants, calculations: frozen, calculationError: null, wasFrozen: true };
  }

  let calculations = null;
  let calculationError = null;

  if (conversion) {
    try {
      // Discount only rewards an EARLY trigger event — if the trigger happens
      // more than 2 years after the round opened, only the valuation cap
      // (if set) applies, not the discount.
      const discountWindowExpired = Boolean(
        round.created_at &&
        conversion.conversion_date &&
        new Date(conversion.conversion_date).getTime() > addDays(new Date(round.created_at), 730).getTime()
      );
      const effectiveDiscountRate = discountWindowExpired ? null : round.discount_rate;

      calculations = {
        trigger_type: conversion.trigger_type,
        priced_round_share_price: conversion.priced_round_share_price == null ? null : Number(conversion.priced_round_share_price),
        capitalization_base_share_count: Number(basis.current_share_count || 0) || null,
        nominal_value_per_share: Number(basis.nominal_value_per_share || 0) || null,
        discount_percent: effectiveDiscountRate == null ? null : Number(effectiveDiscountRate),
        discount_window_expired: discountWindowExpired,
        valuation_cap: round.valuation_cap == null ? null : Number(round.valuation_cap),
        investors: participants.map((agreement) => ({
          agreement_id: agreement.id,
          investor_id: agreement.investor_id,
          investor_name: agreement.investor_name || agreement.investor_email || `Investor ${agreement.id}`,
          investor_email: agreement.investor_email || null,
          investment_amount: Number(agreement.investment_amount || 0),
          ...calculateRcConversion({
            investment_amount: agreement.investment_amount,
            valuation_cap: round.valuation_cap,
            discount_percent: effectiveDiscountRate,
            trigger_type: conversion.trigger_type,
            priced_round_share_price: conversion.priced_round_share_price,
            capitalization_base_share_count: basis.current_share_count,
            nominal_value_per_share: basis.nominal_value_per_share
          })
        }))
      };

      calculations.totals = aggregateRcConversions(calculations.investors);

      // The share basis the whole calculation hangs off, captured alongside it
      // so the snapshot does not depend on startup_profiles staying unchanged.
      calculations.calculation_version = RC_CALCULATION_VERSION;
      calculations.capitalization_denominator = Number(basis.current_share_count || 0) || null;
      calculations.capitalization_basis = "issued_shares_current_articles";
      calculations.par_value_per_share = Number(basis.nominal_value_per_share || 0) || null;
      calculations.pre_share_count = Number(basis.current_share_count || 0) || null;
      calculations.pre_share_capital_amount = Number(basis.current_share_capital_amount || 0) || null;
    } catch (error) {
      calculationError = error.message || "Kunne ikke beregne konverteringen.";
    }
  }

  return {
    basis,
    participants,
    calculations,
    calculationError,
    wasFrozen: false
  };
}

async function syncParValueRequests(connection, conversion, calculations) {
  if (!conversion?.id || !calculations?.investors?.length || !conversion.par_value_due_date) {
    return [];
  }

  for (const item of calculations.investors) {
    await connection.query(
      `
      INSERT INTO conversion_par_value_requests (
        conversion_event_id,
        agreement_id,
        investor_id,
        investor_name,
        investor_email,
        par_value_amount,
        share_count,
        par_value_per_share,
        reference,
        due_date,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_notice')
      ON DUPLICATE KEY UPDATE
        investor_name = VALUES(investor_name),
        investor_email = VALUES(investor_email),
        par_value_amount = IF(conversion_par_value_requests.paid_confirmed_at IS NULL, VALUES(par_value_amount), conversion_par_value_requests.par_value_amount),
        share_count = IF(conversion_par_value_requests.paid_confirmed_at IS NULL, VALUES(share_count), conversion_par_value_requests.share_count),
        par_value_per_share = IF(conversion_par_value_requests.paid_confirmed_at IS NULL, VALUES(par_value_per_share), conversion_par_value_requests.par_value_per_share),
        reference = COALESCE(conversion_par_value_requests.reference, VALUES(reference)),
        due_date = VALUES(due_date)
      `,
      [
        conversion.id,
        item.agreement_id,
        item.investor_id,
        item.investor_name || null,
        item.investor_email || null,
        Number(item.par_amount ?? item.nominal_amount ?? 0),
        Number(item.conversion_share_count || 0),
        Number(item.par_value_per_share ?? item.nominal_value_per_share ?? 0),
        buildParValueReference(item.agreement_id, conversion.id),
        toMysqlDateTime(conversion.par_value_due_date)
      ]
    );
  }

  const [rows] = await connection.query(
    `
    SELECT *
    FROM conversion_par_value_requests
    WHERE conversion_event_id = ?
    ORDER BY id ASC
    `,
    [conversion.id]
  );

  return rows;
}

async function sendParValueNotices(connection, startupContext, conversion, requests) {
  const frontendBase = String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");
  const companyName = startupContext.company?.company_name || "selskapet";
  const noticeDueDate = addDays(new Date(), 7);
  const noticeDueDateSql = toMysqlDateTime(noticeDueDate);
  const bankAccount = startupContext.bank_account || "Legges inn av selskapet";
  let sentAny = false;

  for (const request of requests) {
    if (request.notice_sent_at || !request.investor_email) {
      continue;
    }

    const detailUrl = `${frontendBase}/rc-detail.html?agreement=${encodeURIComponent(request.agreement_id)}`;
    const dueDateLabel = formatDateLabel(noticeDueDate);
    const amountLabel = formatCurrency(request.par_value_amount);
    const referenceLabel = request.reference || buildParValueReference(request.agreement_id, conversion?.id);

    try {
      await sendEmail({
        to: request.investor_email,
        subject: `Paribeløp før konvertering hos ${companyName}`,
        text: `Hei,\n\nKonverteringsprosessen er startet hos ${companyName}. Du må innbetale paribeløpet på ${amountLabel} senest ${dueDateLabel}.\n\nKontonummer: ${bankAccount}\nReferanse: ${referenceLabel}\n\nSe avtalen her: ${detailUrl}`,
        html: `
          <p>Hei,</p>
          <p>Konverteringsprosessen er startet hos <strong>${escapeHtml(companyName)}</strong>.</p>
          <p>Du må innbetale paribeløpet på <strong>${escapeHtml(amountLabel)}</strong> senest <strong>${escapeHtml(dueDateLabel)}</strong>.</p>
          <p><strong>Kontonummer:</strong> ${escapeHtml(bankAccount)}<br><strong>Referanse:</strong> ${escapeHtml(referenceLabel)}</p>
          <p><a href="${detailUrl}">Åpne avtalen og status</a></p>
        `
      });

      await connection.query(
        `
        UPDATE conversion_par_value_requests
        SET notice_sent_at = NOW(), status = 'notice_sent', due_date = ?
        WHERE id = ?
        `,
        [noticeDueDateSql, request.id]
      );
      sentAny = true;
    } catch (error) {
      console.error("Par value notice send failed:", error);
    }
  }

  // Only move the conversion's deadline when a notice actually went out.
  // Updating it unconditionally pushed the payment deadline seven days into the
  // future on every single page load, so it never arrived.
  if (conversion?.id && sentAny) {
    await connection.query(
      `
      UPDATE conversion_events
      SET par_value_due_date = ?
      WHERE id = ?
      `,
      [noticeDueDateSql, conversion.id]
    );
  }
}

async function ensureConversionArtifacts(connection, startupContext, user, round, conversion, basis, calculations) {
  if (!conversion || !basis?.is_complete || !calculations?.investors?.length) {
    return;
  }

  const companyName = startupContext.company?.company_name || user.name || "Startup";
  const orgnr = startupContext.company?.orgnr || "Ikke satt";
  const today = new Date().toLocaleDateString("no-NO", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const [freshRows] = await connection.query(
    "SELECT * FROM conversion_events WHERE id = ? LIMIT 1",
    [conversion.id]
  );
  const freshConversion = freshRows[0];

  if (!freshConversion.board_document_id) {
    /*
      The board proposal names a board chair, so a person must have confirmed
      who that is. Without a confirmation the document would assert a statutory
      office the platform never verified.
    */
    const chairCheck = await requireConfirmedChair(connection, freshConversion.id);
    if (!chairCheck.ok) {
      const error = new Error(chairCheck.error);
      error.code = "BOARD_CHAIR_NOT_CONFIRMED";
      throw error;
    }
    const confirmedChairName = chairCheck.chair.person_name;

    const boardTemplatePath = path.join(templatesDir, "sfc-template.html");
    let boardHtml = fs.readFileSync(boardTemplatePath, "utf8");
    boardHtml = boardHtml
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{trigger_type}}/g, getTriggerLabel(freshConversion.trigger_type))
      .replace(/{{round_id}}/g, String(round.id))
      .replace(/{{date}}/g, today)
      .replace(/{{chair_name}}/g, escapeHtml(confirmedChairName));

    // The signature block is the confirmed chair, not whoever happens to be
    // logged in. One snapshot drives body and signature alike.
    const boardSigners = [{
      email: chairCheck.chair.person_email || user.email,
      user_id: chairCheck.chair.person_user_id || null,
      role: "Styreleder",
      status: chairCheck.chair.person_user_id ? "ACCEPTED" : "INVITED"
    }];

    const boardId = await createDocument(connection, {
      type: "SFC",
      startupId: startupContext.startupUserId,
      roundId: round.id,
      title: `SFC – ${companyName}`,
      html: boardHtml,
      signers: boardSigners
    });

    await notifyDocumentSigners({
      type: "SFC",
      documentId: boardId,
      title: `SFC – ${companyName}`,
      companyName,
      signers: boardSigners
    });

    await connection.query(
      "UPDATE conversion_events SET board_document_id = ?, status = 'board_ready' WHERE id = ?",
      [boardId, freshConversion.id]
    );
    freshConversion.board_document_id = boardId;
  }

  if (!freshConversion.gf_document_id) {
    const [legalRows] = await connection.query(
      `
      SELECT chair_name, secretary_name, secretary_email
      FROM startup_legal_data
      WHERE startup_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [startupContext.startupUserId]
    );

    const legalData = legalRows[0] || {};
    const chairNameCandidate = String(legalData.chair_name || "").trim();
    const resolvedChairName = (() => {
      if (!chairNameCandidate) return user.name || "Møteleder";
      const normalized = chairNameCandidate.toLowerCase();
      if (normalized === "møteleder" || normalized === "moteleder") {
        return user.name || chairNameCandidate;
      }
      return chairNameCandidate;
    })();
    const secretaryName = String(legalData.secretary_name || "").trim() || "Protokollunderskriver";
    const secretaryEmail = String(legalData.secretary_email || "").trim().toLowerCase();
    const secretaryUser = await findUserByEmail(connection, secretaryEmail);

    const gfTemplatePath = path.join(templatesDir, "gfc-template.html");
    let gfHtml = fs.readFileSync(gfTemplatePath, "utf8");
    const preShareCount = Number(basis.current_share_count || 0);
    const nominalValue = Number(basis.nominal_value_per_share || 0);
    const preCapitalAmount = Number(basis.current_share_capital_amount || (preShareCount * nominalValue) || 0);
    const totalInvestmentAmount = Number(calculations.totals?.total_investment_amount || 0);
    const totalNewShares = Number(calculations.totals?.total_conversion_share_count || 0);
    const totalNominalAmount = Number(calculations.totals?.total_nominal_amount || 0);
    const totalSharePremium = Number(calculations.totals?.total_share_premium || 0);
    const postShareCount = preShareCount + totalNewShares;
    const postCapitalAmount = preCapitalAmount + totalNominalAmount;
    // The exercise contribution is the aggregate par value paid in cash, so the
    // subscription price per share is par and no premium arises. The RC
    // Investment Amount was paid at year 0 and is not part of this settlement.
    const subscriptionPrice = nominalValue;
    const sharePremiumPerShare = 0;
    const paymentDueDate = formatDateLabel(freshConversion.par_value_due_date || freshConversion.conversion_date);

    const subscriptionRows = calculations.investors.map((item) => {
      const investorName = escapeHtml(item.investor_name || item.investor_email || "Investor");
      const shareCount = Number(item.conversion_share_count || 0);
      // The subscription is at par, paid in cash. The RC Investment Amount is
      // shown separately because it determined the share count but is not part
      // of this settlement.
      const parAmount = Number(item.par_amount ?? item.nominal_amount ?? 0);
      const investmentAmount = Number(item.investment_amount || 0);
      const ownership = postShareCount > 0 ? ((shareCount / postShareCount) * 100).toFixed(2) : "0.00";
      return `<p style="margin: 0 0 6px;">• ${investorName} tegner ${shareCount.toLocaleString("no-NO")} aksjer à ${formatCurrency(nominalValue)} = ${formatCurrency(parAmount)} innbetalt kontant. Antallet følger av RC-avtalen med investeringsbeløp ${formatCurrency(investmentAmount)}. Dette tilsvarer ${ownership} % eierandel.</p>`;
    }).join("");

    const preemptionRows = calculations.investors.map((item) => {
      const investorName = escapeHtml(item.investor_name || item.investor_email || "Investor");
      const shareCount = Number(item.conversion_share_count || 0);
      return `<p style="margin: 0 0 6px;">• ${investorName} – ${shareCount.toLocaleString("no-NO")} aksjer</p>`;
    }).join("");

    gfHtml = gfHtml
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{trigger_type}}/g, getTriggerLabel(freshConversion.trigger_type))
      .replace(/{{round_id}}/g, String(round.id))
      .replace(/{{date}}/g, today)
      .replace(/{{secretary_name}}/g, secretaryName)
      .replace(/{{pre_capital_amount}}/g, formatCurrency(preCapitalAmount))
      .replace(/{{pre_share_count}}/g, preShareCount.toLocaleString("no-NO"))
      .replace(/{{nominal_value}}/g, formatCurrency(nominalValue))
      .replace(/{{increase_amount}}/g, formatCurrency(totalNominalAmount))
      .replace(/{{new_shares}}/g, totalNewShares.toLocaleString("no-NO"))
      .replace(/{{post_capital_amount}}/g, formatCurrency(postCapitalAmount))
      .replace(/{{post_share_count}}/g, postShareCount.toLocaleString("no-NO"))
      .replace(/{{subscription_price}}/g, formatCurrency(subscriptionPrice))
      .replace(/{{share_premium_per_share}}/g, formatCurrency(sharePremiumPerShare))
      .replace(/{{total_subscription_amount}}/g, formatCurrency(totalInvestmentAmount))
      .replace(/{{total_share_premium}}/g, formatCurrency(totalSharePremium))
      .replace(/{{payment_due_date}}/g, paymentDueDate)
      .replace(/{{subscription_rows}}/g, subscriptionRows || "<p style=\"margin:0;\">Ingen tegning registrert.</p>")
      .replace(/{{preemption_rows}}/g, preemptionRows || "<p style=\"margin:0;\">Ingen tegning registrert.</p>")
      .replace(
        /{{round_raised_amount}}/g,
        `${Number(round.committed_amount ?? round.amount_raised ?? 0).toLocaleString("no-NO")} NOK`
      );

    /*
      The protocol body and the signature block must name the same person.
      Only the authenticated user can actually sign here, so if the company has
      designated a different chair we cannot honestly put that name in the body
      of a document this user signs. One identity, used in both places.
    */
    const signingUserName = String(user.name || "").trim();
    const chairMatchesSigner =
      !signingUserName ||
      resolvedChairName.trim().toLowerCase().replace(/\s+/g, " ") ===
        signingUserName.toLowerCase().replace(/\s+/g, " ");

    const gfChairName = chairMatchesSigner ? resolvedChairName : (signingUserName || resolvedChairName);
    gfHtml = gfHtml.replace(/{{chair_name}}/g, escapeHtml(gfChairName));

    const gfSigners = [
      {
        email: user.email,
        user_id: user.id,
        role: "Møteleder",
        status: "ACCEPTED"
      },
      {
        email: secretaryEmail || user.email,
        user_id: secretaryUser?.id || null,
        role: "Protokollunderskriver",
        status: secretaryUser ? "ACCEPTED" : "INVITED"
      }
    ];

    const gfId = await createDocument(connection, {
      type: "GFC",
      startupId: startupContext.startupUserId,
      roundId: round.id,
      title: `GFC – ${companyName}`,
      html: gfHtml,
      signers: gfSigners
    });

    await notifyDocumentSigners({
      type: "GFC",
      documentId: gfId,
      title: `GFC – ${companyName}`,
      companyName,
      signers: gfSigners
    });

    await connection.query(
      "UPDATE conversion_events SET gf_document_id = ?, status = 'gf_ready' WHERE id = ?",
      [gfId, freshConversion.id]
    );
    freshConversion.gf_document_id = gfId;
  }

  if (!freshConversion.updated_articles_document_id && basis.articles_document?.parsed_fields) {
    const nextShareCount = Number(basis.current_share_count || 0) + Number(calculations.totals?.total_conversion_share_count || 0);
    const nextCapitalAmount = Number(basis.current_share_capital_amount || 0) + Number(calculations.totals?.total_nominal_amount || 0);

    // Fail closed rather than register articles that do not add up. For a
    // company with one uniform par value the new share capital must equal the
    // new share count times par value, and must equal the old capital plus the
    // aggregate par amount actually being contributed.
    const parValue = Number(basis.nominal_value_per_share || 0);
    const expectedFromShares = nextShareCount * parValue;
    const reconciles =
      parValue > 0 &&
      nextShareCount > 0 &&
      Math.abs(expectedFromShares - nextCapitalAmount) <= 0.5 &&
      Math.abs(
        Number(calculations.totals?.total_par_amount || 0) -
        Number(calculations.totals?.total_nominal_amount || 0)
      ) <= 0.5;

    if (!reconciles) {
      throw new Error(
        `Kapitalforhøyelsen stemmer ikke: ${nextShareCount} aksjer × ${parValue} = ${expectedFromShares}, ` +
        `men ny aksjekapital er beregnet til ${nextCapitalAmount}. Vedtektene ble ikke generert.`
      );
    }
    let brregMunicipality = basis.articles_document?.parsed_fields?.municipality || "";
    if (!brregMunicipality && orgnr) {
      try {
        const brregData = await fetchBrregCompany(orgnr);
        brregMunicipality = brregData.municipality || "";
      } catch (_) { /* silent fallback */ }
    }
    const updatedArticles = await buildUpdatedArticlesDraft({
      templatePath: path.join(templatesDir, "vedtekter-template.html"),
      currentArticles: basis.articles_document.parsed_fields,
      fallbackData: {
        company_name: companyName,
        orgnr,
        municipality: brregMunicipality,
        business_purpose: "Selskapets virksomhet følger det som er registrert for selskapet."
      },
      nextCapitalData: {
        share_capital_amount: nextCapitalAmount,
        share_count: nextShareCount,
        nominal_value: basis.nominal_value_per_share,
        last_amended_date: today
      }
    });

    const articlesId = await createDocument(connection, {
      type: "CONVERSION_ARTICLES",
      startupId: startupContext.startupUserId,
      roundId: round.id,
      title: `Vedtekter etter konvertering – ${companyName}`,
      html: updatedArticles.html
    });

    await connection.query(
      "UPDATE conversion_events SET updated_articles_document_id = ? WHERE id = ?",
      [articlesId, freshConversion.id]
    );
    freshConversion.updated_articles_document_id = articlesId;
  }

  const existingShareholderTaskRows = await ensureExistingShareholderTaskRows(
    connection,
    freshConversion.id,
    round.id,
    basis.current_share_count
  );
  const existingShareholderTaskComplete = isExistingShareholderTaskComplete(existingShareholderTaskRows);

  if (!freshConversion.shareholder_register_document_id && existingShareholderTaskComplete) {
    const investorIds = calculations.investors
      .map((item) => Number(item.investor_id || 0))
      .filter(Boolean);
    const [investorLegalRows] = investorIds.length
      ? await connection.query(
          `
          SELECT user_id, full_name, birth_date, digital_address, residential_address, postal_code, city, country, national_id_encrypted
          FROM investor_legal_profiles
          WHERE user_id IN (?)
          `,
          [investorIds]
        )
      : [[]];
    const investorLegalProfiles = new Map(
      investorLegalRows.map((row) => [
        Number(row.user_id),
        {
          full_name: row.full_name || "",
          birth_date: row.birth_date ? formatDateLabel(row.birth_date) : "",
          national_id: row.national_id_encrypted ? decryptNationalId(row.national_id_encrypted) : "",
          digital_address: row.digital_address || "",
          residential_address: row.residential_address || "",
          postal_code: row.postal_code || "",
          city: row.city || "",
          country: row.country || ""
        }
      ])
    );

    const conversionDateLabel = formatDateLabel(freshConversion.conversion_date || new Date());
    const rawExistingRows = existingShareholderTaskRows.map((row) => ({
      shareholder_name: row.shareholder_name,
      identifier_value: row.birth_date ? formatDateLabel(row.birth_date) : "",
      digital_address: row.digital_address || "",
      residential_address: row.residential_address || "",
      share_class: row.share_class || "A",
      share_count: Number(row.share_count || 0),
      entry_date: freshConversion.conversion_date || new Date().toISOString()
    }));

    const rawInvestorRows = (calculations.investors || []).map((investor) => {
      const profile = investorLegalProfiles.get(Number(investor.investor_id)) || {};
      return {
        shareholder_name: profile.full_name || investor.investor_name || investor.investor_email || `Investor ${investor.agreement_id}`,
        identifier_value: profile.national_id || profile.birth_date || "",
        digital_address: profile.digital_address || investor.investor_email || "",
        residential_address: [profile.residential_address, profile.postal_code, profile.city, profile.country].filter(Boolean).join(", "),
        share_class: "A",
        share_count: Number(investor.conversion_share_count || 0),
        entry_date: freshConversion.conversion_date || new Date().toISOString()
      };
    });

    const allRawRows = [...rawExistingRows, ...rawInvestorRows];
    const totalShares = allRawRows.reduce((sum, r) => sum + Number(r.share_count || 0), 0);
    let currentNumber = 1;
    const shareholderRegisterRows = allRawRows.map((row) => {
      const shareCount = Number(row.share_count || 0);
      const rangeStart = shareCount > 0 ? currentNumber : null;
      const rangeEnd = shareCount > 0 ? currentNumber + shareCount - 1 : null;
      if (shareCount > 0) currentNumber = rangeEnd + 1;
      return {
        ...row,
        ownership_percent: totalShares > 0 ? ((shareCount / totalShares) * 100) : 0,
        share_range_label: rangeStart && rangeEnd ? `${rangeStart.toLocaleString("no-NO")}–${rangeEnd.toLocaleString("no-NO")}` : "",
        entry_date_display: row.entry_date ? formatDateLabel(row.entry_date) : conversionDateLabel
      };
    });

    const shareholderRegisterHtml = buildShareholderRegisterHtml({
      companyName,
      orgnr,
      date: today,
      totalShareCapital: (Number(basis.current_share_count || 0) + Number(calculations.totals?.total_conversion_share_count || 0)) * Number(basis.nominal_value_per_share || 0),
      totalShareCount: Number(basis.current_share_count || 0) + Number(calculations.totals?.total_conversion_share_count || 0),
      nominalValue: Number(basis.nominal_value_per_share || 0),
      shareClass: "A",
      rows: shareholderRegisterRows
    });

    const registerId = await createDocument(connection, {
      type: "CONVERSION_SHARE_REGISTER",
      startupId: startupContext.startupUserId,
      roundId: round.id,
      title: `Aksjeeierbok etter konvertering – ${companyName}`,
      html: shareholderRegisterHtml
    });

    await connection.query(
      "UPDATE conversion_events SET shareholder_register_document_id = ? WHERE id = ?",
      [registerId, freshConversion.id]
    );
    freshConversion.shareholder_register_document_id = registerId;
  }

  if (!freshConversion.capital_confirmation_document_id && freshConversion.third_party_email) {
    const thirdPartyUser = await findUserByEmail(connection, freshConversion.third_party_email);
    const templatePath = path.join(templatesDir, "conversion-capital-confirmation-template.html");
    let confirmationHtml = fs.readFileSync(templatePath, "utf8");
    confirmationHtml = confirmationHtml
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{date}}/g, today)
      .replace(/{{third_party_name}}/g, freshConversion.third_party_name || "Revisor registreres før innsending")
      .replace(/{{third_party_email}}/g, freshConversion.third_party_email || "Registreres før innsending")
      .replace(/{{trigger_type}}/g, getTriggerLabel(freshConversion.trigger_type))
      .replace(/{{conversion_date}}/g, formatDateLabel(freshConversion.conversion_date))
      .replace(/{{par_value_due_date}}/g, formatDateLabel(freshConversion.par_value_due_date))
      .replace(/{{total_new_shares}}/g, escapeHtml(Number(calculations.totals?.total_conversion_share_count || 0).toLocaleString("no-NO")))
      .replace(/{{total_nominal_amount}}/g, escapeHtml(formatCurrency(calculations.totals?.total_nominal_amount || 0)))
      .replace(/{{total_share_premium}}/g, escapeHtml(formatCurrency(calculations.totals?.total_share_premium || 0)));

    const confirmationSigners = freshConversion.third_party_email ? [{
      email: freshConversion.third_party_email,
      user_id: thirdPartyUser?.id || null,
      role: "Revisor",
      status: thirdPartyUser ? "ACCEPTED" : "INVITED"
    }] : [];

    const confirmationId = await createDocument(connection, {
      type: "CONVERSION_CAPITAL_CONFIRMATION",
      startupId: startupContext.startupUserId,
      roundId: round.id,
      title: `Bekreftelse på innbetalt aksjekapital – ${companyName}`,
      html: confirmationHtml,
      signers: confirmationSigners
    });

    await notifyDocumentSigners({
      type: "CONVERSION_CAPITAL_CONFIRMATION",
      documentId: confirmationId,
      title: `Bekreftelse på innbetalt aksjekapital – ${companyName}`,
      companyName,
      signers: confirmationSigners
    });

    await connection.query(
      "UPDATE conversion_events SET capital_confirmation_document_id = ? WHERE id = ?",
      [confirmationId, freshConversion.id]
    );
    freshConversion.capital_confirmation_document_id = confirmationId;
  }
}

async function ensureAltinnPackageIfReady(connection, startupContext, round, conversion, calculations) {
  if (
    !conversion?.id ||
    conversion.altinn_package_document_id ||
    !conversion.board_document_id ||
    !conversion.gf_document_id ||
    !conversion.updated_articles_document_id ||
    !conversion.shareholder_register_document_id ||
    !conversion.capital_confirmation_document_id
  ) {
    return;
  }

  const [docs] = await connection.query(
    `
    SELECT id, type, status
    FROM documents
    WHERE id IN (?, ?, ?, ?, ?, ?)
    `,
    [
      conversion.board_document_id,
      conversion.gf_document_id,
      conversion.updated_articles_document_id || 0,
      conversion.shareholder_register_document_id || 0,
      conversion.capital_confirmation_document_id || 0,
      conversion.altinn_package_document_id || 0
    ]
  );

  const byId = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
  const boardLocked = byId[conversion.board_document_id]?.status === "LOCKED";
  const gfLocked = byId[conversion.gf_document_id]?.status === "LOCKED";
  const confirmationLocked = byId[conversion.capital_confirmation_document_id]?.status === "LOCKED";
  const articlesReady = Boolean(byId[conversion.updated_articles_document_id]);
  const registerReady = Boolean(byId[conversion.shareholder_register_document_id]);

  if (!boardLocked || !gfLocked || !confirmationLocked || !articlesReady || !registerReady) {
    return;
  }

  const companyName = startupContext.company?.company_name || "Startup";
  const orgnr = startupContext.company?.orgnr || "Ikke satt";
  const templatePath = path.join(templatesDir, "altinn-package-template.html");
  let packageHtml = fs.readFileSync(templatePath, "utf8");
  packageHtml = packageHtml
    .replace(/{{company_name}}/g, companyName)
    .replace(/{{orgnr}}/g, orgnr)
    .replace(/{{date}}/g, formatDateLabel(new Date()))
    .replace(/{{conversion_date}}/g, formatDateLabel(conversion.conversion_date));

  const packageId = await createDocument(connection, {
    type: "CONVERSION_PACKAGE",
    startupId: startupContext.startupUserId,
    roundId: round.id,
    title: `Altinn-pakke – ${companyName}`,
    html: packageHtml
  });

  await connection.query(
    `
    UPDATE conversion_events
    SET altinn_package_document_id = ?, status = 'package_ready'
    WHERE id = ?
    `,
    [packageId, conversion.id]
  );
}

export async function buildConversionState(connection, startupContext, user) {
  const startupId = startupContext.startupUserId;
  const round = await getLatestRoundForStartup(connection, startupId);
  if (!round) {
    return null;
  }

  if (String(round.closed_reason || "") === "conversion_downloaded") {
    return null;
  }

  const hasConversionEventsTable = await tableExists(connection, "conversion_events");
  const hasParValueRequestsTable = await tableExists(connection, "conversion_par_value_requests");
  const hasConversionExistingShareholdersTable = await tableExists(connection, "conversion_existing_shareholders");

  if (!hasConversionEventsTable) {
    return {
      round,
      approval_gate: {
        required_before_start: false,
        target_reached_at: null,
        blocked_until: null,
        reason: null
      },
      conversion_basis: await getConversionBasis(connection, startupId),
      articles_basis: null,
      conversion: null,
      calculations: null,
      calculation_error: null,
      par_value_requests: [],
      steps: {
        trigger: { status: "pending" },
        par_value: { status: "pending", requests: [] },
        board: { status: "pending", document: null },
        gf: { status: "pending", document: null },
        articles: { status: "pending", document: null },
        shareholder_register: { status: "pending", document: null },
        third_party_confirmation: { status: "pending", document: null },
        package: { status: "pending", document: null }
      }
    };
  }

  let conversion = await getCurrentConversionEvent(connection, startupId, round.id);
  if (!conversion) {
    conversion = await ensureAutoTimeElapsedConversion(connection, startupId, round);
  }

  const conversionData = await buildConversionCalculations(connection, startupId, round, conversion);
  const adminApprovalPending = Boolean(
    conversion?.id &&
    Number(conversion.requires_admin_approval || 0) === 1 &&
    !conversion.admin_approved_at
  );

  if (conversion?.id && conversionData.calculations && !adminApprovalPending) {
    // Freeze once. A snapshot that already exists is authoritative and must not
    // be recomputed, or an investor's allocation could change under them after
    // they have been told what to subscribe for and what to pay.
    if (!conversionData.wasFrozen) {
      conversionData.calculations.frozen_at = new Date().toISOString();
      await connection.query(
        `
        UPDATE conversion_events
        SET calculations_json = ?
        WHERE id = ? AND (calculations_json IS NULL OR JSON_EXTRACT(calculations_json, '$.frozen_at') IS NULL)
        `,
        [JSON.stringify(conversionData.calculations), conversion.id]
      );

      // Another request may have frozen it first; that one wins.
      const [[reread]] = await connection.query(
        "SELECT calculations_json FROM conversion_events WHERE id = ? LIMIT 1",
        [conversion.id]
      );
      const winner = readFrozenCalculations(reread);
      if (winner) {
        conversionData.calculations = winner;
        conversionData.wasFrozen = true;
      }

      await recordAuditEvent(connection, AUDIT_EVENTS.CALCULATION_FROZEN, {
        startupId, roundId: round.id,
        actorUserId: user?.id || null, actorRole: "startup",
        triggerType: conversion.trigger_type,
        calculationVersion: conversionData.calculations?.calculation_version || null,
        metadata: {
          conversion_event_id: conversion.id,
          share_price: conversionData.calculations?.investors?.[0]?.share_price ?? null,
          total_new_shares: conversionData.calculations?.totals?.total_conversion_share_count ?? null,
          total_par_amount: conversionData.calculations?.totals?.total_par_amount ?? null,
          investor_count: conversionData.calculations?.investors?.length ?? 0
        }
      });
    }

    const requests = hasParValueRequestsTable
      ? await syncParValueRequests(connection, conversion, conversionData.calculations)
      : [];
    if (hasParValueRequestsTable) {
      await sendParValueNotices(connection, { ...startupContext, bank_account: round.bank_account || null }, conversion, requests);
    }
    if (hasConversionExistingShareholdersTable) {
      /*
        Document generation can legitimately refuse: the board chair may not be
        confirmed yet, or the capital increase may not reconcile. Neither is a
        server fault, and neither should take down the conversion page — the
        reason is surfaced as a blocker the company can act on.
      */
      try {
        await ensureConversionArtifacts(connection, startupContext, user, round, conversion, conversionData.basis, conversionData.calculations);
      } catch (artifactError) {
        conversionData.artifactError = artifactError.message
          || "Kunne ikke generere konverteringsdokumentene.";
        conversionData.artifactErrorCode = artifactError.code || null;
      }
    }

    const [updatedConversionRows] = await connection.query(
      "SELECT * FROM conversion_events WHERE id = ? LIMIT 1",
      [conversion.id]
    );
    conversion = updatedConversionRows[0];

    if (hasConversionExistingShareholdersTable) {
      await ensureAltinnPackageIfReady(connection, startupContext, round, conversion, conversionData.calculations);
      const [finalConversionRows] = await connection.query(
        "SELECT * FROM conversion_events WHERE id = ? LIMIT 1",
        [conversion.id]
      );
      conversion = finalConversionRows[0];
    }
  }

  const artifactError = conversionData.artifactError || null;
  const artifactErrorCode = conversionData.artifactErrorCode || null;

  const documentIds = [
    conversion?.board_document_id,
    conversion?.gf_document_id,
    conversion?.updated_articles_document_id,
    conversion?.shareholder_register_document_id,
    conversion?.capital_confirmation_document_id,
    conversion?.altinn_package_document_id
  ].filter(Boolean);

  let documentsById = {};
  if (documentIds.length) {
    const [docs] = await connection.query(
      `
      SELECT id, type, title, status, created_at, locked_at
      FROM documents
      WHERE id IN (?)
      `,
      [documentIds]
    );
    documentsById = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
  }

  const [parValueRequests] = (conversion?.id && hasParValueRequestsTable)
    ? await connection.query(
        `
        SELECT id, agreement_id, investor_id, investor_name, investor_email, par_value_amount, share_count, par_value_per_share, reference, due_date, notice_sent_at, paid_confirmed_at, status
        FROM conversion_par_value_requests
        WHERE conversion_event_id = ?
        ORDER BY id ASC
        `,
        [conversion.id]
      )
    : [[]];

  const boardDoc = conversion?.board_document_id ? documentsById[conversion.board_document_id] || null : null;
  const gfDoc = conversion?.gf_document_id ? documentsById[conversion.gf_document_id] || null : null;

  let gfSigners = [];
  if (gfDoc?.id) {
    const [signerRows] = await connection.query(
      `SELECT email, role, signed_at FROM document_signers WHERE document_id = ? ORDER BY id ASC`,
      [gfDoc.id]
    );
    gfSigners = signerRows.map((s) => ({ email: s.email, role: s.role, signed: Boolean(s.signed_at) }));
  }
  const articlesDoc = conversion?.updated_articles_document_id ? documentsById[conversion.updated_articles_document_id] || null : null;
  const shareholderDoc = conversion?.shareholder_register_document_id ? documentsById[conversion.shareholder_register_document_id] || null : null;
  const confirmationDoc = conversion?.capital_confirmation_document_id ? documentsById[conversion.capital_confirmation_document_id] || null : null;
  const packageDoc = conversion?.altinn_package_document_id ? documentsById[conversion.altinn_package_document_id] || null : null;
  const approvalGate = await evaluateTriggerApproval(connection, round, conversion?.trigger_type || "new_priced_round");

  return {
    round,
    approval_gate: {
      required_before_start: Boolean(
        approvalGate.requiresAdminApproval &&
        (!conversion?.id || !conversion.admin_approved_at)
      ),
      target_reached_at: approvalGate.targetReachedAt ? approvalGate.targetReachedAt.toISOString() : null,
      blocked_until: approvalGate.approvalBlockedUntil ? approvalGate.approvalBlockedUntil.toISOString() : null,
      reason: approvalGate.reason || null
    },
    conversion_basis: conversionData.basis,
    articles_basis: conversionData.basis.articles_document,
    conversion: conversion
      ? {
          ...conversion,
          trigger_label: getTriggerLabel(conversion.trigger_type),
          conversion_date_label: formatDateLabel(conversion.conversion_date),
          par_value_due_date_label: formatDateLabel(conversion.par_value_due_date),
          preparation_started_at_label: formatDateTimeLabel(conversion.preparation_started_at),
          admin_approval_pending: adminApprovalPending,
          admin_approved_at_label: formatDateTimeLabel(conversion.admin_approved_at)
        }
      : null,
    calculations: conversionData.calculations,
    calculation_error: conversionData.calculationError,
    document_generation_error: artifactError,
    document_generation_error_code: artifactErrorCode,
    par_value_requests: parValueRequests,
    steps: {
      trigger: { status: adminApprovalPending ? "pending_admin_approval" : (conversion ? "done" : "pending") },
      par_value: {
        status: parValueRequests.length
          ? (parValueRequests.every((item) => item.notice_sent_at) ? "ready" : "pending")
          : "pending",
        requests: parValueRequests
      },
      board: { status: boardDoc?.status === "LOCKED" ? "signed" : (boardDoc ? "ready" : "pending"), document: boardDoc },
      gf: { status: gfDoc?.status === "LOCKED" ? "signed" : (gfDoc ? "ready" : "pending"), document: gfDoc, signers: gfSigners },
      articles: { status: articlesDoc ? "ready" : "pending", document: articlesDoc },
      shareholder_register: { status: shareholderDoc ? "ready" : "pending", document: shareholderDoc },
      third_party_confirmation: {
        status: confirmationDoc?.status === "LOCKED" ? "signed" : (confirmationDoc ? "ready" : "pending"),
        document: confirmationDoc
      },
      package: { status: packageDoc ? "ready" : "pending", document: packageDoc }
    }
  };
}

async function persistConversionContext(connection, conversionId, payload = {}) {
  const updates = [];
  const params = [];

  if (payload.conversionDate !== undefined) {
    const parsed = parseRequestedDate(payload.conversionDate);
    updates.push("conversion_date = ?");
    params.push(parsed ? toMysqlDateTime(parsed) : null);
    updates.push("par_value_due_date = ?");
    params.push(parsed ? toMysqlDateTime(addDays(new Date(), 7)) : null);
  }

  if (payload.thirdPartyName !== undefined) {
    updates.push("third_party_name = ?");
    params.push(String(payload.thirdPartyName || "").trim() || null);
  }

  if (payload.thirdPartyEmail !== undefined) {
    updates.push("third_party_email = ?");
    params.push(String(payload.thirdPartyEmail || "").trim().toLowerCase() || null);
  }

  if (payload.pricedRoundSharePrice !== undefined) {
    const numeric = Number(payload.pricedRoundSharePrice);
    updates.push("priced_round_share_price = ?");
    params.push(Number.isFinite(numeric) && numeric > 0 ? numeric : null);
  }

  if (payload.triggerRequestReason !== undefined) {
    updates.push("trigger_request_reason = ?");
    params.push(String(payload.triggerRequestReason || "").trim() || null);
  }

  if (!updates.length) {
    return;
  }

  params.push(conversionId);
  await connection.query(
    `UPDATE conversion_events SET ${updates.join(", ")} WHERE id = ?`,
    params
  );
}

router.get("/current", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const state = await buildConversionState(pool, startupContext, req.user);
    res.json(state);
  } catch (err) {
    console.error("Get conversion current error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/start", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const triggerType = normalizeTriggerType(req.body.triggerType);

    if (!["new_priced_round", "ownership_change"].includes(triggerType)) {
      return res.status(400).json({ error: "Ugyldig trigger event." });
    }

    const round = await getLatestRoundForStartup(connection, startupId);
    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte konverteringen til." });
    }

    const existing = await getCurrentConversionEvent(connection, startupId, round.id);
    const timeline = resolveConversionTimeline(round, triggerType, req.body.conversionDate);
    const pricedRoundSharePrice = Number(req.body.pricedRoundSharePrice);
    const triggerRequestReason = String(req.body.triggerRequestReason || "").trim();
    const triggerApproval = await evaluateTriggerApproval(connection, round, triggerType);
    const triggerStatus = triggerApproval.requiresAdminApproval ? "pending_admin_approval" : "triggered";

    if (triggerApproval.requiresAdminApproval && !triggerRequestReason) {
      return res.status(400).json({
        error: "Skriv en kort begrunnelse for hvorfor trigger event må registreres før 30 dager."
      });
    }

    if (!existing) {
      await connection.query(
        `
        INSERT INTO conversion_events (
          startup_id, round_id, trigger_type, status, conversion_date, par_value_due_date, preparation_started_at, third_party_name, third_party_email, priced_round_share_price, trigger_request_reason, requires_admin_approval, admin_approval_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)
        `,
        [
          startupId,
          round.id,
          triggerType,
          triggerStatus,
          toMysqlDateTime(timeline.conversionDate),
          toMysqlDateTime(timeline.parValueDueDate),
          String(req.body.thirdPartyName || "").trim() || null,
          String(req.body.thirdPartyEmail || "").trim().toLowerCase() || null,
          Number.isFinite(pricedRoundSharePrice) && pricedRoundSharePrice > 0
            ? pricedRoundSharePrice
            : null,
          triggerRequestReason || null,
          triggerApproval.requiresAdminApproval ? 1 : 0,
          triggerApproval.reason
        ]
      );
    } else {
      if (existing.status === "pending_admin_approval" && Number(existing.requires_admin_approval || 0) === 1 && !existing.admin_approved_at) {
        return res.status(409).json({
          error: existing.admin_approval_reason || "Trigger event venter allerede på godkjenning fra admin."
        });
      }

      /*
        Once the calculation is frozen, the inputs behind it are settled. Letting
        a second call change the trigger type or the round price here would leave
        the event describing one basis while the frozen allocations — which
        investors have already been notified of — rest on another.
      */
      if (readFrozenCalculations(existing)) {
        if (normalizeTriggerType(existing.trigger_type) !== triggerType) {
          return res.status(409).json({
            error:
              "Beregningen for dette trigger event er allerede låst. Trigger-typen kan ikke endres i ettertid. " +
              "Ta kontakt med Raisium hvis registreringen er feil."
          });
        }

        await recordAuditEvent(connection, AUDIT_EVENTS.TRIGGER_ACKNOWLEDGED, {
          startupId, roundId: round.id,
          actorUserId: req.user.id, actorRole: "startup",
          triggerType,
          metadata: { conversion_event_id: existing.id, calculation_already_frozen: true }
        });

        const state = await buildConversionState(connection, startupContext, req.user);
        return res.json(state);
      }

      const updateChunks = [
        "status = ?",
        "requires_admin_approval = ?",
        "admin_approval_reason = ?",
        "trigger_request_reason = ?",
        "admin_approved_at = NULL",
        "admin_approved_by_user_id = NULL"
      ];
      const updateParams = [
        triggerStatus,
        triggerApproval.requiresAdminApproval ? 1 : 0,
        triggerApproval.reason,
        triggerRequestReason || null,
        existing.id
      ];
      await connection.query(
        `UPDATE conversion_events SET ${updateChunks.join(", ")} WHERE id = ?`,
        updateParams
      );

      await persistConversionContext(connection, existing.id, {
        conversionDate: req.body.conversionDate,
        thirdPartyName: req.body.thirdPartyName,
        thirdPartyEmail: req.body.thirdPartyEmail,
        pricedRoundSharePrice: req.body.pricedRoundSharePrice,
        triggerRequestReason
      });
    }

    await recordAuditEvent(connection, AUDIT_EVENTS.TRIGGER_DETECTED, {
      startupId, roundId: round.id,
      actorUserId: req.user.id, actorRole: "startup",
      triggerType, newStatus: triggerStatus,
      ipAddress: getClientIp(req),
      metadata: {
        automatic: false,
        requires_admin_approval: triggerApproval.requiresAdminApproval,
        conversion_date: toMysqlDateTime(timeline.conversionDate)
      }
    });

    const state = await buildConversionState(connection, startupContext, req.user);
    await sendConversionStartedEmail({
      startupEmail: req.user.email,
      startupName: startupContext.company?.company_name || req.user.name || "",
      triggerLabel: getTriggerLabel(triggerType)
    });
    await sendTelegramAdminAlert("Trigger event registrert", [
      `Selskap: ${startupContext.company?.company_name || req.user.name || "-"}`,
      `Orgnr: ${startupContext.company?.orgnr || "-"}`,
      `Trigger: ${getTriggerLabel(triggerType)}`,
      triggerApproval.requiresAdminApproval
        ? `Status: Venter admin-godkjenning`
        : `Status: Startet`
    ]);
    res.status(triggerApproval.requiresAdminApproval ? 202 : 201).json({
      ...state,
      adminApproval: {
        required: triggerApproval.requiresAdminApproval,
        targetReachedAt: triggerApproval.targetReachedAt ? triggerApproval.targetReachedAt.toISOString() : null,
        blockedUntil: triggerApproval.approvalBlockedUntil ? triggerApproval.approvalBlockedUntil.toISOString() : null,
        reason: triggerApproval.reason
      }
    });
  } catch (err) {
    console.error("Start conversion error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/context", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte konverteringen til." });
    }

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion) {
      return res.status(400).json({ error: "Registrer trigger event først." });
    }

    const previousThirdPartyEmail = String(conversion.third_party_email || "").trim().toLowerCase();

    await persistConversionContext(connection, conversion.id, {
      conversionDate: req.body.conversionDate,
      thirdPartyName: req.body.thirdPartyName,
      thirdPartyEmail: req.body.thirdPartyEmail,
      pricedRoundSharePrice: req.body.pricedRoundSharePrice
    });

    const nextThirdPartyEmail = String(req.body.thirdPartyEmail || "").trim().toLowerCase();
    if (nextThirdPartyEmail && nextThirdPartyEmail !== previousThirdPartyEmail) {
      await sendTelegramAdminAlert("Bekreftelse på aksjeinnskudd venter", [
        `Selskap: ${startupContext.company?.company_name || req.user.name || "-"}`,
        `Orgnr: ${startupContext.company?.orgnr || "-"}`,
        `Bekrefter e-post: ${nextThirdPartyEmail}`
      ]);
    }

    const state = await buildConversionState(connection, startupContext, req.user);
    res.json(state);
  } catch (err) {
    console.error("Update conversion context error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/par-value/confirm", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const requestId = Number(req.body.requestId || 0);
    if (!requestId) {
      return res.status(400).json({ error: "Mangler paribeløp-id." });
    }

    const [rows] = await connection.query(
      `
      SELECT pr.id, pr.status, ce.startup_id
      FROM conversion_par_value_requests pr
      JOIN conversion_events ce ON pr.conversion_event_id = ce.id
      WHERE pr.id = ?
      LIMIT 1
      `,
      [requestId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Fant ikke paribeløp-kravet." });
    }

    const request = rows[0];
    if (Number(request.startup_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Ikke tilgang til dette paribeløpet." });
    }

    await connection.query(
      `
      UPDATE conversion_par_value_requests
      SET paid_confirmed_at = NOW(), status = 'paid_confirmed'
      WHERE id = ?
      `,
      [requestId]
    );

    res.json({ message: "Paribeløp bekreftet." });
  } catch (err) {
    console.error("Confirm par value error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/pricing-context", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte konverteringen til." });
    }

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion) {
      return res.status(400).json({ error: "Registrer trigger event først." });
    }

    await persistConversionContext(connection, conversion.id, {
      pricedRoundSharePrice: req.body.priced_round_share_price
    });

    const state = await buildConversionState(connection, startupContext, req.user);
    res.json(state);
  } catch (err) {
    console.error("Set conversion pricing context error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/board/generate", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const state = await buildConversionState(pool, startupContext, req.user);
    if (!state?.steps?.board?.document?.id) {
      if (state?.conversion_basis && !state.conversion_basis.is_complete) {
        const missing = state.conversion_basis.missing_fields || [];
        return res.status(400).json({
          error: `Kunne ikke klargjøre styrets forslag. Mangler: ${missing.join(", ") || "nøkkeldata"}`
        });
      }
      if (!state?.calculations?.investors?.length) {
        return res.status(400).json({ error: "Kunne ikke klargjøre styrets forslag. Ingen investorer er klare for konvertering." });
      }
      return res.status(400).json({ error: "Kunne ikke klargjøre styrets forslag enda." });
    }
    res.status(201).json({ documentId: state.steps.board.document.id });
  } catch (err) {
    console.error("Generate conversion board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/gf/generate", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const state = await buildConversionState(pool, startupContext, req.user);
    if (!state?.steps?.gf?.document?.id) {
      return res.status(400).json({ error: "Kunne ikke klargjøre GF enda." });
    }
    res.status(201).json({ documentId: state.steps.gf.document.id });
  } catch (err) {
    console.error("Generate conversion GF error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/gf/resend-sign-link", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);
    if (!round) return res.status(404).json({ error: "Fant ingen runde." });

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion?.gf_document_id) {
      return res.status(400).json({ error: "GF-dokument er ikke generert ennå." });
    }

    const [docRows] = await connection.query("SELECT status FROM documents WHERE id = ?", [conversion.gf_document_id]);
    if (docRows[0]?.status === "LOCKED") {
      return res.status(400).json({ error: "Dokumentet er allerede signert og låst." });
    }

    const [unsignedSigners] = await connection.query(
      `SELECT email, role FROM document_signers WHERE document_id = ? AND signed_at IS NULL`,
      [conversion.gf_document_id]
    );

    const protocolSigner = unsignedSigners.find(
      (s) => String(s.role || "").toLowerCase().includes("protokoll")
    );

    if (!protocolSigner) {
      return res.status(400).json({ error: "Protokollunderskriver er allerede ferdig eller ikke registrert på dokumentet." });
    }

    const signUrl = buildSignUrl("conversion", conversion.gf_document_id);
    await sendDocumentSigningRequestEmail({
      to: protocolSigner.email,
      companyName: startupContext.company?.company_name || "Selskapet",
      roleLabel: protocolSigner.role || "Protokollunderskriver",
      documentTitle: "Generalforsamlingsprotokoll",
      signUrl
    });

    res.json({ success: true, sign_url: signUrl, email: protocolSigner.email });
  } catch (err) {
    console.error("Resend GF sign link error:", err);
    res.status(500).json({ error: "Intern feil ved utsending." });
  } finally {
    connection.release();
  }
});

/*
  The single authoritative registration-readiness check.

  Everything that must be true before a capital increase may be registered lives
  here, so the download endpoint, the completion endpoint and the UI all consume
  the same decision rather than each carrying their own copy of the rules.
*/
export async function checkRegistrationReadiness(connection, conversion, calculations, basis) {
  const blockers = [];

  if (!conversion?.id) {
    return { ready: false, blockers: ["Fant ingen aktiv konvertering."] };
  }

  // Trigger valid and calculation frozen.
  if (!conversion.trigger_type) {
    blockers.push("Trigger event mangler.");
  }
  if (Number(conversion.requires_admin_approval || 0) === 1 && !conversion.admin_approved_at) {
    blockers.push("Trigger event venter på godkjenning fra Raisium.");
  }
  if (!readFrozenCalculations(conversion)) {
    blockers.push("Beregningen er ikke låst. Konverteringen kan ikke registreres på et bevegelig grunnlag.");
  }

  // Corporate documents generated and signed. The Altinn package is only
  // created once the board proposal, the GF protocol and the share
  // contribution confirmation are all LOCKED, so its presence is the proof.
  if (!conversion.board_document_id) blockers.push("Styrets forslag er ikke generert.");
  if (!conversion.gf_document_id) blockers.push("Generalforsamlingsprotokollen er ikke generert.");
  if (!conversion.updated_articles_document_id) blockers.push("Oppdaterte vedtekter er ikke generert.");
  if (!conversion.shareholder_register_document_id) blockers.push("Oppdatert aksjeeierbok er ikke generert.");
  if (!conversion.capital_confirmation_document_id) {
    blockers.push("Bekreftelsen på innbetalt aksjekapital er ikke generert.");
  }
  if (!conversion.altinn_package_document_id) {
    blockers.push(
      "Dokumentpakken er ikke klar. Styrets forslag, generalforsamlingsprotokollen og bekreftelsen på innbetalt aksjekapital må være signert."
    );
  }

  // The board proposal names a chair; that identity must have been confirmed
  // by a person, not assumed from whoever was logged in.
  const confirmedChair = await getConfirmedBoardRole(connection, conversion.id, "board_chair");
  if (!confirmedChair?.person_name) {
    blockers.push("Styreleder er ikke bekreftet for denne konverteringen.");
  }

  // The cash share contribution must actually be confirmed by an eligible
  // external confirmer before anything is registered.
  if (!conversion.third_party_confirmed_at) {
    blockers.push("Den eksterne bekreftelsen på innbetalt aksjekapital er ikke fullført.");
  }

  // Every par amount received.
  const [unpaidPar] = await connection.query(
    `SELECT id, investor_name FROM conversion_par_value_requests
     WHERE conversion_event_id = ? AND paid_confirmed_at IS NULL`,
    [conversion.id]
  );
  if (unpaidPar.length > 0) {
    blockers.push(
      `Paribeløpet er ikke bekreftet betalt for alle investorer (${unpaidPar.length} gjenstår).`
    );
  }

  // Registration data for the shareholder register.
  const [parRequests] = await connection.query(
    `SELECT DISTINCT investor_id FROM conversion_par_value_requests
     WHERE conversion_event_id = ? AND investor_id IS NOT NULL`,
    [conversion.id]
  );
  const investorIds = parRequests.map((r) => r.investor_id);
  if (investorIds.length > 0) {
    const [incompleteProfiles] = await connection.query(
      `SELECT user_id FROM investor_legal_profiles
       WHERE user_id IN (?) AND (full_name IS NULL OR full_name = '' OR birth_date IS NULL
         OR digital_address IS NULL OR digital_address = ''
         OR residential_address IS NULL OR residential_address = '')`,
      [investorIds]
    );
    const [existingProfiles] = await connection.query(
      `SELECT user_id FROM investor_legal_profiles WHERE user_id IN (?)`,
      [investorIds]
    );
    const existingIds = new Set(existingProfiles.map((p) => p.user_id));
    const missingProfiles = investorIds.filter((id) => !existingIds.has(id));
    if (incompleteProfiles.length > 0 || missingProfiles.length > 0) {
      blockers.push(
        "Én eller flere investorer mangler juridisk informasjon (navn, fødselsdato, adresse) som kreves i aksjeeierbok."
      );
    }
  }

  const [incompleteExisting] = await connection.query(
    `SELECT id FROM conversion_existing_shareholders
     WHERE conversion_event_id = ? AND (
       shareholder_name IS NULL OR shareholder_name = '' OR birth_date IS NULL OR
       digital_address IS NULL OR digital_address = '' OR
       residential_address IS NULL OR residential_address = '' OR
       share_count IS NULL OR share_count <= 0
     )`,
    [conversion.id]
  );
  if (incompleteExisting.length > 0) {
    blockers.push(
      `${incompleteExisting.length} eksisterende aksjonær(er) mangler informasjon i aksjeeierbok.`
    );
  }

  // Values must reconcile before anything is filed.
  if (calculations?.totals && basis) {
    const parValue = Number(basis.nominal_value_per_share || 0);
    const newShares = Number(calculations.totals.total_conversion_share_count || 0);
    const aggregatePar = Number(calculations.totals.total_par_amount || 0);
    const newShareCount = Number(basis.current_share_count || 0) + newShares;
    const newShareCapital = Number(basis.current_share_capital_amount || 0) + aggregatePar;

    if (!(parValue > 0) || Math.abs(newShareCount * parValue - newShareCapital) > 0.5) {
      blockers.push(
        `Tallene stemmer ikke: ${newShareCount} aksjer × ${parValue} er ikke lik ny aksjekapital ${newShareCapital}.`
      );
    }
    if (Math.abs(aggregatePar - Number(calculations.totals.total_share_capital_increase || 0)) > 0.5) {
      blockers.push("Samlet paribeløp er ikke lik den beregnede kapitalforhøyelsen.");
    }
  } else {
    blockers.push("Beregningsgrunnlaget mangler.");
  }

  return { ready: blockers.length === 0, blockers };
}

router.get("/board-chair", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);
    if (!round) return res.status(404).json({ error: "Fant ingen runde." });

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    const orgnr = startupContext.company?.orgnr || null;

    const suggestion = await suggestBoardChair(orgnr);
    const confirmed = conversion?.id
      ? await getConfirmedBoardRole(connection, conversion.id, "board_chair")
      : null;

    res.json({
      conversion_event_id: conversion?.id || null,
      suggested: suggestion.suggested,
      candidates: suggestion.candidates,
      source: suggestion.source,
      confirmed: confirmed
        ? {
            person_name: confirmed.person_name,
            person_email: confirmed.person_email,
            source: confirmed.source,
            confirmed_at: confirmed.confirmed_at
          }
        : null
    });
  } catch (err) {
    console.error("Board chair lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/board-chair/confirm", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);
    if (!round) return res.status(404).json({ error: "Fant ingen runde." });

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion?.id) return res.status(400).json({ error: "Fant ingen aktiv konvertering." });

    const { person_name, person_email, source } = req.body || {};
    const result = await confirmBoardRole(connection, {
      conversionEventId: conversion.id,
      startupId,
      role: "board_chair",
      personName: person_name,
      personEmail: person_email || null,
      personUserId: null,
      source: ["brreg", "manual"].includes(source) ? source : "manual",
      confirmedBy: req.user.id
    });

    if (!result.ok) return res.status(400).json({ error: result.error });

    await recordAuditEvent(connection, AUDIT_EVENTS.BOARD_PROPOSAL_GENERATED, {
      startupId, roundId: round.id,
      actorUserId: req.user.id, actorRole: "startup",
      metadata: { role: "board_chair", person_name: result.personName, source, confirmed: true }
    });

    res.json({ success: true, person_name: result.personName });
  } catch (err) {
    console.error("Board chair confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.get("/registration-readiness", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);
    if (!round) return res.status(404).json({ error: "Fant ingen runde." });

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    const data = await buildConversionCalculations(connection, startupId, round, conversion);
    const readiness = await checkRegistrationReadiness(connection, conversion, data.calculations, data.basis);

    res.json(readiness);
  } catch (err) {
    console.error("Registration readiness error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.get("/package/download", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte pakken til." });
    }

    let conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion) {
      return res.status(400).json({ error: "Fant ingen aktiv konvertering." });
    }

    if (!conversion.altinn_package_document_id) {
      await buildConversionState(connection, startupContext, req.user);
      const [fresh] = await connection.query("SELECT * FROM conversion_events WHERE id = ? LIMIT 1", [conversion.id]);
      conversion = fresh[0] || conversion;
    }

    // One authoritative gate, shared with /registration-readiness and the UI.
    const calcData = await buildConversionCalculations(connection, startupId, round, conversion);
    const readiness = await checkRegistrationReadiness(connection, conversion, calcData.calculations, calcData.basis);
    if (!readiness.ready) {
      return res.status(400).json({
        error: "Konverteringspakken er ikke klar for registrering ennå.",
        blockers: readiness.blockers
      });
    }

    const docIds = [
      conversion.board_document_id,
      conversion.gf_document_id,
      conversion.updated_articles_document_id,
      conversion.shareholder_register_document_id,
      conversion.capital_confirmation_document_id,
      conversion.altinn_package_document_id
    ].filter(Boolean);

    if (!docIds.length) {
      return res.status(404).json({ error: "Fant ingen dokumenter å pakke." });
    }

    const [docs] = await connection.query(
      `
      SELECT id, title, type, html_content
      FROM documents
      WHERE id IN (?)
      `,
      [docIds]
    );

    const docsById = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
    // Rekkefølgen følger saksgangen: styrets forslag, GF-vedtaket, bekreftelsen
    // på innbetalt aksjekapital, og deretter de oppdaterte registrene.
    const orderedDocs = [
      { id: conversion.altinn_package_document_id, prefix: "01", fallback: "altinnpakke-raisium" },
      { id: conversion.board_document_id, prefix: "02", fallback: "styrets-forslag" },
      { id: conversion.gf_document_id, prefix: "03", fallback: "generalforsamling" },
      { id: conversion.capital_confirmation_document_id, prefix: "04", fallback: "bekreftelse-aksjeinnskudd" },
      { id: conversion.updated_articles_document_id, prefix: "05", fallback: "oppdaterte-vedtekter" },
      { id: conversion.shareholder_register_document_id, prefix: "06", fallback: "aksjeeierbok" }
    ].filter((item) => item.id && docsById[item.id]);

    const companyName = startupContext.company?.company_name || "startup";
    const baseName = makeSafeFilename(companyName, "konverteringspakke");
    const dateLabel = formatDateLabel(new Date()).replace(/\s+/g, "-").toLowerCase();
    const zipName = `${baseName}-konverteringspakke-${dateLabel}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Kunne ikke lage zip." });
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    for (const item of orderedDocs) {
      const doc = docsById[item.id];
      const safeTitle = makeSafeFilename(doc?.title, item.fallback);
      const filename = `${item.prefix}-${safeTitle}.pdf`;
      // eslint-disable-next-line no-await-in-loop
      const pdfOptions = doc?.type === "CONVERSION_SHARE_REGISTER"
        ? {
            landscape: true,
            margin: {
              top: "18px",
              right: "18px",
              bottom: "18px",
              left: "18px"
            }
          }
        : {};
      const pdfBuffer = await renderHtmlToPdfBuffer(doc?.html_content || "", pdfOptions);
      archive.append(pdfBuffer, { name: filename });
    }

    archive.finalize();
  } catch (err) {
    console.error("Download conversion package error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.post("/close-round", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å lukke." });
    }

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion?.altinn_package_document_id) {
      await connection.rollback();
      return res.status(400).json({ error: "Runden kan først lukkes etter at konverteringspakken er klargjort." });
    }

    // Same gate as the download. Closing the round is the completion point, so
    // it must not be reachable while anything required for registration is
    // still outstanding.
    const calcData = await buildConversionCalculations(connection, startupId, round, conversion);
    const readiness = await checkRegistrationReadiness(connection, conversion, calcData.calculations, calcData.basis);
    if (!readiness.ready) {
      await connection.rollback();
      return res.status(400).json({
        error: "Konverteringen er ikke klar til å fullføres.",
        blockers: readiness.blockers
      });
    }
    const columns = await getEmissionRoundColumns(connection);
    const roundUpdates = ["open = 0"];
    const roundParams = [];

    if (columns.has("status")) {
      roundUpdates.push("status = ?");
      roundParams.push("CLOSED");
    }

    if (columns.has("closed_reason")) {
      roundUpdates.push("closed_reason = ?");
      roundParams.push("conversion_downloaded");
    }

    if (columns.has("closed_at")) {
      roundUpdates.push("closed_at = NOW()");
    }

    roundParams.push(round.id);
    await connection.query(
      `UPDATE emission_rounds SET ${roundUpdates.join(", ")} WHERE id = ?`,
      roundParams
    );

    await connection.query(
      `
      UPDATE startup_profiles
      SET is_raising = 0
      WHERE user_id = ?
      `,
      [startupId]
    );

    /*
      Mark each RC fulfilled. Idempotent — converted_at is only written where it
      is still NULL, so re-running this cannot double-record a conversion. The
      status column is left as it is so the agreement stays visible in both
      parties' history; converted_at is what says the RC is completed.
    */
    const agreementColumns = await getRcAgreementColumns(connection);
    if (agreementColumns.has("converted_at")) {
      for (const item of (calcData.calculations?.investors || [])) {
        await connection.query(
          `
          UPDATE rc_agreements
          SET conversion_event_id = ?, converted_at = NOW(),
              converted_share_count = ?, converted_par_amount = ?
          WHERE id = ? AND converted_at IS NULL
          `,
          [
            conversion.id,
            Number(item.final_share_count ?? item.conversion_share_count ?? 0),
            Number(item.par_amount ?? 0),
            item.agreement_id
          ]
        );
      }
    }

    const [[updatedRound]] = await connection.query(
      `
      SELECT open, closed_reason
      FROM emission_rounds
      WHERE id = ?
      LIMIT 1
      `,
      [round.id]
    );

    const [[updatedProfile]] = await connection.query(
      `
      SELECT is_raising
      FROM startup_profiles
      WHERE user_id = ?
      LIMIT 1
      `,
      [startupId]
    );

    if (
      !updatedRound ||
      Number(updatedRound.open) !== 0 ||
      String(updatedRound.closed_reason || "") !== "conversion_downloaded" ||
      Number(updatedProfile?.is_raising ?? 1) !== 0
    ) {
      await connection.rollback();
      return res.status(500).json({ error: "Runden ble ikke lukket korrekt. Prøv igjen." });
    }

    await recordAuditEvent(connection, AUDIT_EVENTS.CONVERSION_COMPLETED, {
      startupId, roundId: round.id,
      actorUserId: req.user.id, actorRole: "startup",
      previousStatus: "package_ready", newStatus: "conversion_downloaded",
      triggerType: conversion.trigger_type,
      calculationVersion: calcData.calculations?.calculation_version || null,
      metadata: {
        conversion_event_id: conversion.id,
        total_new_shares: calcData.calculations?.totals?.total_conversion_share_count ?? null,
        total_par_amount: calcData.calculations?.totals?.total_par_amount ?? null,
        new_share_capital: Number(calcData.basis?.current_share_capital_amount || 0)
          + Number(calcData.calculations?.totals?.total_par_amount || 0)
      }
    });

    await connection.commit();

    try {
      await sendRoundClosedEmail({
        startupName: startupContext.company?.company_name || "Startup",
        startupEmail: req.user.email,
        amountRaised: Number(round.amount_raised || round.committed_amount || 0),
        closedReason: "conversion_downloaded"
      });
    } catch (mailErr) {
      console.error("Send close round email error:", mailErr);
    }

    res.json({
      success: true,
      message: "Runden er nå lukket.",
      closed: true
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch {}
    console.error("Close conversion round error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

export default router;
