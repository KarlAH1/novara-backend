import express from "express";
import fs from "fs";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { resolveCompanyStartupOwner } from "../utils/startupContext.js";
import {
  aggregateRcConversions,
  calculateRcConversion
} from "../utils/rcConversionCalculator.js";

const router = express.Router();

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

async function getLatestRoundForStartup(startupId) {
  const [rows] = await pool.query(
    `
    SELECT id, startup_id, target_amount, amount_raised, committed_amount, conversion_years, trigger_period, discount_rate, valuation_cap, deadline, closed_reason
    FROM emission_rounds
    WHERE startup_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [startupId]
  );

  return rows[0] || null;
}

async function getCurrentConversionEvent(startupId, roundId) {
  const [rows] = await pool.query(
    `
    SELECT *
    FROM conversion_events
    WHERE startup_id = ? AND round_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [startupId, roundId]
  );

  return rows[0] || null;
}

async function ensureAutoTimeElapsedConversion(startupId, round) {
  if (!round?.deadline) {
    return null;
  }

  const deadline = new Date(round.deadline);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() > Date.now()) {
    return null;
  }

  const existing = await getCurrentConversionEvent(startupId, round.id);
  if (existing) {
    return existing;
  }

  const [result] = await pool.query(
    `
    INSERT INTO conversion_events (startup_id, round_id, trigger_type, status)
    VALUES (?, ?, 'time_elapsed', 'triggered')
    `,
    [startupId, round.id]
  );

  return {
    id: result.insertId,
    startup_id: startupId,
    round_id: round.id,
    trigger_type: "time_elapsed",
    status: "triggered",
    board_document_id: null,
    gf_document_id: null
  };
}

async function ensureAutoTargetReachedConversion(startupId, round) {
  if (round?.closed_reason !== "target_reached") {
    return null;
  }

  const existing = await getCurrentConversionEvent(startupId, round.id);
  if (existing) {
    return existing;
  }

  const [result] = await pool.query(
    `
    INSERT INTO conversion_events (startup_id, round_id, trigger_type, status)
    VALUES (?, ?, 'target_reached', 'triggered')
    `,
    [startupId, round.id]
  );

  return {
    id: result.insertId,
    startup_id: startupId,
    round_id: round.id,
    trigger_type: "target_reached",
    status: "triggered",
    board_document_id: null,
    gf_document_id: null
  };
}

async function buildConversionState(startupId) {
  const round = await getLatestRoundForStartup(startupId);
  if (!round) {
    return null;
  }

  let conversion = await getCurrentConversionEvent(startupId, round.id);
  if (!conversion) {
    conversion = await ensureAutoTargetReachedConversion(startupId, round);
  }
  if (!conversion) {
    conversion = await ensureAutoTimeElapsedConversion(startupId, round);
  }

  const documentIds = [conversion?.board_document_id, conversion?.gf_document_id].filter(Boolean);
  let documentsById = {};

  if (documentIds.length) {
    const [docs] = await pool.query(
      `
      SELECT id, type, title, status, created_at
      FROM documents
      WHERE id IN (?)
      `,
      [documentIds]
    );

    documentsById = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
  }

  const boardDoc = conversion?.board_document_id ? documentsById[conversion.board_document_id] || null : null;
  const gfDoc = conversion?.gf_document_id ? documentsById[conversion.gf_document_id] || null : null;
  const boardLocked = boardDoc?.status === "LOCKED";
  const gfLocked = gfDoc?.status === "LOCKED";
  const [profileRows] = await pool.query(
    `
    SELECT nominal_value_per_share, current_share_count, share_basis_temporary
    FROM startup_profiles
    WHERE user_id = ?
    LIMIT 1
    `,
    [startupId]
  );
  const [articlesRows] = await pool.query(
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
  const articlesBasisRow = articlesRows[0] || null;
  const profileBasis = profileRows[0] || null;
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
  const missingConversionBasis = [];

  if (!Number(resolvedNominalValue || 0)) {
    missingConversionBasis.push("pålydende per aksje");
  }
  if (!Number(resolvedCurrentShareCount || 0)) {
    missingConversionBasis.push("gjeldende antall aksjer");
  }
  if (!articlesBasisRow) {
    missingConversionBasis.push("gjeldende vedtekter");
  }
  if (Boolean(Number(profileBasis?.share_basis_temporary || 0))) {
    missingConversionBasis.push("foreløpig aksjegrunnlag");
  }

  let conversionCalculations = null;
  let conversionCalculationError = null;

  if (conversion) {
    const [agreementRows] = await pool.query(
      `
      SELECT
        a.id,
        a.investment_amount,
        a.investor_id,
        COALESCE(u.name, u.email) AS investor_name,
        u.email AS investor_email
      FROM rc_agreements a
      LEFT JOIN users u ON u.id = a.investor_id
      WHERE a.round_id = ?
        AND a.status IN ('Awaiting Payment', 'Active RC')
      ORDER BY a.id ASC
      `,
      [round.id]
    );

    try {
      const calculations = agreementRows.map((agreement) => ({
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
          capitalization_base_share_count: resolvedCurrentShareCount,
          nominal_value_per_share: resolvedNominalValue
        })
      }));

      conversionCalculations = {
        trigger_type: conversion.trigger_type,
        priced_round_share_price: conversion.priced_round_share_price == null ? null : Number(conversion.priced_round_share_price),
        capitalization_base_share_count: Number(resolvedCurrentShareCount || 0) || null,
        nominal_value_per_share: Number(resolvedNominalValue || 0) || null,
        discount_percent: round.discount_rate == null ? null : Number(round.discount_rate),
        valuation_cap: round.valuation_cap == null ? null : Number(round.valuation_cap),
        investors: calculations,
        totals: aggregateRcConversions(calculations)
      };
    } catch (err) {
      conversionCalculationError = err.message || "Kunne ikke beregne konverteringen.";
    }
  }

  return {
    round,
    conversion_basis: {
      nominal_value_per_share: resolvedNominalValue,
      current_share_count: resolvedCurrentShareCount,
      share_basis_temporary: Boolean(Number(profileBasis?.share_basis_temporary || 0)),
      missing_fields: missingConversionBasis,
      is_complete: missingConversionBasis.length === 0
    },
    articles_basis: articlesBasisRow
      ? {
          id: articlesBasisRow.id,
          filename: articlesBasisRow.filename,
          url: articlesBasisRow.url,
          parse_status: articlesBasisRow.parse_status,
          parsed_fields: (() => {
            try {
              return JSON.parse(articlesBasisRow.parsed_fields_json || "{}");
            } catch {
              return {};
            }
          })()
        }
      : null,
    conversion: conversion
      ? {
          ...conversion,
          trigger_label: getTriggerLabel(conversion.trigger_type)
        }
      : null,
    calculations: conversionCalculations,
    calculation_error: conversionCalculationError,
    steps: {
      trigger: {
        status: conversion ? "done" : "pending"
      },
      board: {
        status: boardLocked ? "signed" : (boardDoc ? "ready" : "pending"),
        document: boardDoc
      },
      gf: {
        status: gfLocked ? "signed" : (gfDoc ? "ready" : "pending"),
        document: gfDoc
      },
      documents: {
        status: gfLocked ? "ready" : "pending"
      }
    }
  };
}

router.get("/current", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const state = await buildConversionState(startupContext.startupUserId);
    res.json(state);
  } catch (err) {
    console.error("Get conversion current error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/start", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const startupId = startupContext.startupUserId;
    const triggerType = String(req.body.triggerType || "").trim();

    if (!["new_round", "new_priced_round", "ownership_change"].includes(triggerType)) {
      return res.status(400).json({ error: "Ugyldig trigger event." });
    }

    const round = await getLatestRoundForStartup(startupId);
    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte konverteringen til." });
    }

    const existing = await getCurrentConversionEvent(startupId, round.id);
    if (existing) {
      const state = await buildConversionState(startupId);
      return res.json(state);
    }

    await pool.query(
      `
      INSERT INTO conversion_events (startup_id, round_id, trigger_type, status)
      VALUES (?, ?, ?, 'triggered')
      `,
      [startupId, round.id, triggerType === "new_round" ? "new_priced_round" : triggerType]
    );

    const state = await buildConversionState(startupId);
    res.status(201).json(state);
  } catch (err) {
    console.error("Start conversion error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/pricing-context", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const startupId = startupContext.startupUserId;
    const round = await getLatestRoundForStartup(startupId);

    if (!round) {
      return res.status(404).json({ error: "Fant ingen runde å knytte konverteringen til." });
    }

    const conversion = await getCurrentConversionEvent(startupId, round.id);
    if (!conversion) {
      return res.status(400).json({ error: "Registrer trigger event først." });
    }

    const pricedRoundSharePrice = Number(req.body.priced_round_share_price);
    if (conversion.trigger_type === "new_priced_round" && (!Number.isFinite(pricedRoundSharePrice) || pricedRoundSharePrice <= 0)) {
      return res.status(400).json({ error: "priced_round_share_price må være større enn 0." });
    }

    await pool.query(
      `
      UPDATE conversion_events
      SET priced_round_share_price = ?
      WHERE id = ?
      `,
      [Number.isFinite(pricedRoundSharePrice) ? pricedRoundSharePrice : null, conversion.id]
    );

    const state = await buildConversionState(startupId);
    res.json(state);
  } catch (err) {
    console.error("Set conversion pricing context error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/board/generate", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const startupId = startupContext.startupUserId;
    const state = await buildConversionState(startupId);

    if (!state?.conversion) {
      return res.status(400).json({ error: "Registrer trigger event først." });
    }

    if (state.steps.board.document?.id) {
      return res.json({ documentId: state.steps.board.document.id });
    }

    const companyName = startupContext.company?.company_name || req.user.name || "Startup";
    const templatePath = new URL("../templates/sfc-template.html", import.meta.url);
    let template = fs.readFileSync(templatePath, "utf8");
    const orgnr = startupContext.company?.orgnr || "Ikke satt";
    const today = new Date().toLocaleDateString("no-NO", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    template = template
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{trigger_type}}/g, state.conversion.trigger_label)
      .replace(/{{round_id}}/g, String(state.round.id))
      .replace(/{{date}}/g, today)
      .replace(/{{chair_name}}/g, req.user.name || "Styreleder");

    const [docResult] = await pool.query(
      `
      INSERT INTO documents (type, startup_id, title, html_content, status)
      VALUES ('SFC', ?, ?, ?, 'DRAFT')
      `,
      [startupId, `SFC – ${companyName}`, template]
    );

    await pool.query(
      `
      INSERT INTO document_signers (document_id, email, user_id, role, status)
      VALUES (?, ?, ?, 'Styreleder', 'ACCEPTED')
      `,
      [docResult.insertId, req.user.email, req.user.id]
    );

    await pool.query(
      "UPDATE conversion_events SET board_document_id = ?, status = 'board_ready' WHERE id = ?",
      [docResult.insertId, state.conversion.id]
    );

    res.status(201).json({ documentId: docResult.insertId });
  } catch (err) {
    console.error("Generate conversion board error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/gf/generate", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
    const startupId = startupContext.startupUserId;
    const state = await buildConversionState(startupId);

    if (!state?.conversion) {
      return res.status(400).json({ error: "Registrer trigger event først." });
    }

    if (!state.steps.board.document?.id) {
      return res.status(400).json({ error: "Generer styrets forslag først." });
    }

    if (state.steps.board.status !== "signed") {
      return res.status(400).json({ error: "Styrets forslag må være signert før GF kan genereres." });
    }

    if (state.steps.gf.document?.id) {
      return res.json({ documentId: state.steps.gf.document.id });
    }

    const [legalRows] = await pool.query(
      `
      SELECT secretary_name, secretary_email
      FROM startup_legal_data
      WHERE startup_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [startupId]
    );

    if (legalRows.length === 0) {
      return res.status(400).json({ error: "Fant ikke tidligere signeringsdata for GF." });
    }

    const legalData = legalRows[0];
    const secretaryName = String(legalData.secretary_name || "").trim();
    const secretaryEmail = String(legalData.secretary_email || "").trim().toLowerCase();

    if (!secretaryName || !secretaryEmail) {
      return res.status(400).json({ error: "Mangler protokollunderskriver fra tidligere GF-flyt." });
    }

    const [secretaryUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [secretaryEmail]
    );
    const secretaryUserId = secretaryUsers[0]?.id || null;
    const secretaryStatus = secretaryUserId ? "ACCEPTED" : "INVITED";

    const companyName = startupContext.company?.company_name || req.user.name || "Startup";
    const templatePath = new URL("../templates/gfc-template.html", import.meta.url);
    let template = fs.readFileSync(templatePath, "utf8");
    const orgnr = startupContext.company?.orgnr || "Ikke satt";
    const today = new Date().toLocaleDateString("no-NO", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    template = template
      .replace(/{{company_name}}/g, companyName)
      .replace(/{{orgnr}}/g, orgnr)
      .replace(/{{trigger_type}}/g, state.conversion.trigger_label)
      .replace(/{{round_id}}/g, String(state.round.id))
      .replace(/{{date}}/g, today)
      .replace(/{{chair_name}}/g, req.user.name || "Møteleder")
      .replace(/{{secretary_name}}/g, secretaryName);

    const [docResult] = await pool.query(
      `
      INSERT INTO documents (type, startup_id, title, html_content, status)
      VALUES ('GFC', ?, ?, ?, 'DRAFT')
      `,
      [startupId, `GFC – ${companyName}`, template]
    );

    await pool.query(
      `
      INSERT INTO document_signers (document_id, email, user_id, role, status)
      VALUES (?, ?, ?, 'Møteleder', 'ACCEPTED')
      `,
      [docResult.insertId, req.user.email, req.user.id]
    );

    await pool.query(
      `
      INSERT INTO document_signers (document_id, email, user_id, role, status)
      VALUES (?, ?, ?, 'Protokollunderskriver', ?)
      `,
      [docResult.insertId, secretaryEmail, secretaryUserId, secretaryStatus]
    );

    await pool.query(
      "UPDATE conversion_events SET gf_document_id = ?, status = 'gf_ready' WHERE id = ?",
      [docResult.insertId, state.conversion.id]
    );

    res.status(201).json({ documentId: docResult.insertId });
  } catch (err) {
    console.error("Generate conversion GF error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
