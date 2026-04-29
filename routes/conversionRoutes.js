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
  calculateRcConversion
} from "../utils/rcConversionCalculator.js";
import { ensureStartupArticlesParsed } from "../utils/startupArticlesBasis.js";
import { buildUpdatedArticlesDraft } from "../utils/updatedArticlesBuilder.js";
import { sendEmail } from "../utils/emailService.js";
import {
  sendConversionStartedEmail,
  sendDocumentSigningRequestEmail,
  sendRoundClosedEmail
} from "../utils/notificationEmailFlow.js";
import { sendTelegramAdminAlert } from "../utils/telegramNotifier.js";
import { getEmissionRoundColumns } from "../utils/emissionRoundState.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templatesDir = path.resolve(__dirname, "../templates");
const frontendBase = String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");

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
    SELECT id, startup_id, target_amount, amount_raised, committed_amount, conversion_years, trigger_period, discount_rate, valuation_cap, deadline, closed_reason, bank_account
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

  const [articlesRows] = await connection.query(
    `
    SELECT id, filename, url, mime_type, parse_status, parsed_fields_json, extracted_text, uploaded_at
    FROM startup_documents
    WHERE startup_id = ?
      AND document_type = 'current_articles_of_association'
    ORDER BY uploaded_at DESC, id DESC
    LIMIT 1
    `,
    [startupId]
  );

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

async function createDocument(connection, { type, startupId, title, html, signers = [] }) {
  const [docResult] = await connection.query(
    `
    INSERT INTO documents (type, startup_id, title, html_content, status)
    VALUES (?, ?, ?, ?, 'DRAFT')
    `,
    [type, startupId, title, html]
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

async function buildConversionCalculations(connection, startupId, round, conversion) {
  const basis = await getConversionBasis(connection, startupId);
  const participants = await getConversionParticipants(connection, round.id);

  let calculations = null;
  let calculationError = null;

  if (conversion) {
    try {
      calculations = {
        trigger_type: conversion.trigger_type,
        priced_round_share_price: conversion.priced_round_share_price == null ? null : Number(conversion.priced_round_share_price),
        capitalization_base_share_count: Number(basis.current_share_count || 0) || null,
        nominal_value_per_share: Number(basis.nominal_value_per_share || 0) || null,
        discount_percent: round.discount_rate == null ? null : Number(round.discount_rate),
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
            discount_percent: round.discount_rate,
            trigger_type: conversion.trigger_type,
            priced_round_share_price: conversion.priced_round_share_price,
            capitalization_base_share_count: basis.current_share_count,
            nominal_value_per_share: basis.nominal_value_per_share
          })
        }))
      };

      calculations.totals = aggregateRcConversions(calculations.investors);
    } catch (error) {
      calculationError = error.message || "Kunne ikke beregne konverteringen.";
    }
  }

  return {
    basis,
    participants,
    calculations,
    calculationError
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
        reference,
        due_date,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_notice')
      ON DUPLICATE KEY UPDATE
        investor_name = VALUES(investor_name),
        investor_email = VALUES(investor_email),
        par_value_amount = VALUES(par_value_amount),
        reference = COALESCE(conversion_par_value_requests.reference, VALUES(reference)),
        due_date = VALUES(due_date)
      `,
      [
        conversion.id,
        item.agreement_id,
        item.investor_id,
        item.investor_name || null,
        item.investor_email || null,
        Number(item.nominal_amount || 0),
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
  const frontendBase = String(process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const companyName = startupContext.company?.company_name || "selskapet";
  const noticeDueDate = addDays(new Date(), 7);
  const noticeDueDateSql = toMysqlDateTime(noticeDueDate);
  const bankAccount = startupContext.bank_account || "Legges inn av selskapet";

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
    } catch (error) {
      console.error("Par value notice send failed:", error);
    }
  }

  if (conversion?.id) {
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
    const boardTemplatePath = path.join(templatesDir, "sfc-template.html");
    let boardHtml = fs.readFileSync(boardTemplatePath, "utf8");
    boardHtml = boardHtml
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{trigger_type}}/g, getTriggerLabel(freshConversion.trigger_type))
      .replace(/{{round_id}}/g, String(round.id))
      .replace(/{{date}}/g, today)
      .replace(/{{chair_name}}/g, user.name || "Styreleder");

    const boardSigners = [{
      email: user.email,
      user_id: user.id,
      role: "Styreleder",
      status: "ACCEPTED"
    }];

    const boardId = await createDocument(connection, {
      type: "SFC",
      startupId: startupContext.startupUserId,
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
    const subscriptionPrice = totalNewShares > 0 ? totalInvestmentAmount / totalNewShares : 0;
    const sharePremiumPerShare = subscriptionPrice > 0 && nominalValue > 0
      ? subscriptionPrice - nominalValue
      : 0;
    const paymentDueDate = formatDateLabel(freshConversion.par_value_due_date || freshConversion.conversion_date);

    const subscriptionRows = calculations.investors.map((item) => {
      const investorName = escapeHtml(item.investor_name || item.investor_email || "Investor");
      const shareCount = Number(item.conversion_share_count || 0);
      const pricePerShare = Number(item.chosen_conversion_price || 0);
      const amount = Number(item.investment_amount || 0);
      const ownership = postShareCount > 0 ? ((shareCount / postShareCount) * 100).toFixed(2) : "0.00";
      return `<p style="margin: 0 0 6px;">• ${investorName} tegner ${shareCount.toLocaleString("no-NO")} aksjer à ${formatCurrency(pricePerShare)} = ${formatCurrency(amount)}. Dette tilsvarer ${ownership} % eierandel.</p>`;
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
      .replace(/{{chair_name}}/g, resolvedChairName)
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
    const updatedArticles = await buildUpdatedArticlesDraft({
      templatePath: path.join(templatesDir, "vedtekter-template.html"),
      currentArticles: basis.articles_document.parsed_fields,
      fallbackData: {
        company_name: companyName,
        orgnr,
        municipality: basis.articles_document?.parsed_fields?.municipality || "",
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
          SELECT user_id, full_name, birth_date, digital_address, residential_address, postal_code, city, country
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
          digital_address: row.digital_address || "",
          residential_address: row.residential_address || "",
          postal_code: row.postal_code || "",
          city: row.city || "",
          country: row.country || ""
        }
      ])
    );

    const seededExistingRows = existingShareholderTaskRows.map((row) => ({
      shareholder_name: row.shareholder_name,
      identifier_value: row.birth_date ? formatDateLabel(row.birth_date) : "",
      digital_address: row.digital_address || "",
      residential_address: row.residential_address || "",
      share_class: row.share_class || "A",
      share_count: Number(row.share_count || 0),
      share_range_label: row.share_numbers || "Fastsettes ved ferdigstillelse",
      entry_date_display: ""
    }));

    const investorRows = buildShareholderRegisterRows(
      [],
      0,
      calculations.investors.map((investor) => ({
        ...investor,
        legal_profile: investorLegalProfiles.get(Number(investor.investor_id)) || null,
        entry_date: freshConversion.conversion_date || new Date().toISOString()
      }))
    );
    const shareholderRegisterRows = [...seededExistingRows, ...investorRows];

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
      title: `Aksjeeierbok etter konvertering – ${companyName}`,
      html: shareholderRegisterHtml
    });

    await connection.query(
      "UPDATE conversion_events SET shareholder_register_document_id = ? WHERE id = ?",
      [registerId, freshConversion.id]
    );
    freshConversion.shareholder_register_document_id = registerId;
  }

  if (!freshConversion.capital_confirmation_document_id) {
    const thirdPartyUser = freshConversion.third_party_email
      ? await findUserByEmail(connection, freshConversion.third_party_email)
      : null;
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
      title: `Revisorbekreftelse – ${companyName}`,
      html: confirmationHtml,
      signers: confirmationSigners
    });

    await notifyDocumentSigners({
      type: "CONVERSION_CAPITAL_CONFIRMATION",
      documentId: confirmationId,
      title: `Revisorbekreftelse – ${companyName}`,
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

  if (!boardLocked || !gfLocked || !confirmationLocked) {
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
    await connection.query(
      `
      UPDATE conversion_events
      SET calculations_json = ?
      WHERE id = ?
      `,
      [JSON.stringify(conversionData.calculations), conversion.id]
    );

    const requests = await syncParValueRequests(connection, conversion, conversionData.calculations);
    await sendParValueNotices(connection, { ...startupContext, bank_account: round.bank_account || null }, conversion, requests);
    await ensureConversionArtifacts(connection, startupContext, user, round, conversion, conversionData.basis, conversionData.calculations);

    const [updatedConversionRows] = await connection.query(
      "SELECT * FROM conversion_events WHERE id = ? LIMIT 1",
      [conversion.id]
    );
    conversion = updatedConversionRows[0];

    await ensureAltinnPackageIfReady(connection, startupContext, round, conversion, conversionData.calculations);
    const [finalConversionRows] = await connection.query(
      "SELECT * FROM conversion_events WHERE id = ? LIMIT 1",
      [conversion.id]
    );
    conversion = finalConversionRows[0];
  }

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

  const [parValueRequests] = conversion?.id
    ? await connection.query(
        `
        SELECT id, agreement_id, investor_id, investor_name, investor_email, par_value_amount, reference, due_date, notice_sent_at, paid_confirmed_at, status
        FROM conversion_par_value_requests
        WHERE conversion_event_id = ?
        ORDER BY id ASC
        `,
        [conversion.id]
      )
    : [[]];

  const boardDoc = conversion?.board_document_id ? documentsById[conversion.board_document_id] || null : null;
  const gfDoc = conversion?.gf_document_id ? documentsById[conversion.gf_document_id] || null : null;
  const articlesDoc = conversion?.updated_articles_document_id ? documentsById[conversion.updated_articles_document_id] || null : null;
  const shareholderDoc = conversion?.shareholder_register_document_id ? documentsById[conversion.shareholder_register_document_id] || null : null;
  const confirmationDoc = conversion?.capital_confirmation_document_id ? documentsById[conversion.capital_confirmation_document_id] || null : null;
  const packageDoc = conversion?.altinn_package_document_id ? documentsById[conversion.altinn_package_document_id] || null : null;
  const approvalGate = await evaluateTriggerApproval(connection, round, "new_priced_round");

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
      gf: { status: gfDoc?.status === "LOCKED" ? "signed" : (gfDoc ? "ready" : "pending"), document: gfDoc },
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
      await sendTelegramAdminAlert("Revisorbekreftelse venter", [
        `Selskap: ${startupContext.company?.company_name || req.user.name || "-"}`,
        `Orgnr: ${startupContext.company?.orgnr || "-"}`,
        `Revisor e-post: ${nextThirdPartyEmail}`
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

router.get("/package/download", auth, requireRole(["startup"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(connection, startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte pakken til." });
    }

    const conversion = await getCurrentConversionEvent(connection, startupId, round.id);
    if (!conversion || !conversion.altinn_package_document_id) {
      return res.status(400).json({ error: "Konverteringspakken er ikke klar ennå." });
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
    const orderedDocs = [
      { id: conversion.altinn_package_document_id, prefix: "01", fallback: "altinnpakke-raisium" },
      { id: conversion.board_document_id, prefix: "02", fallback: "styrets-forslag" },
      { id: conversion.gf_document_id, prefix: "03", fallback: "generalforsamling" },
      { id: conversion.updated_articles_document_id, prefix: "04", fallback: "oppdaterte-vedtekter" },
      { id: conversion.shareholder_register_document_id, prefix: "05", fallback: "aksjeeierbok" },
      { id: conversion.capital_confirmation_document_id, prefix: "06", fallback: "revisorbekreftelse" }
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
