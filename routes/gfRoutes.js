import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import fs from "fs";
import { canStartupCreateRaise } from "../utils/startupPlanAccess.js";
import { cleanupLegalDocuments } from "../utils/legalDocumentCleanup.js";
import { resolveCompanyStartupOwner } from "../utils/startupContext.js";
import { sendDocumentSigningRequestEmail } from "../utils/notificationEmailFlow.js";
import { getLegalResetCutoff } from "../utils/legalRoundReset.js";

const router = express.Router();
const frontendBase = String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");

async function canRestartLegalFlow(startupId) {
  const legalResetCutoff = await getLegalResetCutoff(pool, startupId);
  const [emissionRows] = await pool.query(
    `
    SELECT id
    FROM emission_rounds
    WHERE startup_id = ?
      AND (closed_reason IS NULL OR closed_reason = '')
    LIMIT 1
    `,
    [startupId]
  );

  if (emissionRows.length > 0) {
    return false;
  }

  const [agreementRows] = await pool.query(
    `
    SELECT a.id
    FROM rc_agreements a
    JOIN emission_rounds e ON e.id = a.round_id
    WHERE e.startup_id = ?
      AND (
        e.closed_reason IS NULL
        OR e.closed_reason = ''
        OR (? IS NOT NULL AND e.created_at > ?)
      )
    LIMIT 1
    `,
    [startupId, legalResetCutoff, legalResetCutoff]
  );

  return agreementRows.length === 0;
}

router.post(
  "/generate",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupId = startupContext.startupUserId;
      const legalResetCutoff = await getLegalResetCutoff(pool, startupId);

      if (!(await canStartupCreateRaise(startupId))) {
        return res.status(403).json({
          error: "Du må ha en aktiv startup-plan for å opprette dokumentgrunnlaget."
        });
      }

      /* =====================================================
         1️⃣ STOPP hvis GF allerede er signert (LOCKED)
      ===================================================== */

      const [existingLocked] = await pool.query(
        `SELECT id
         FROM documents
         WHERE startup_id = ?
         AND type = 'GF'
         AND status = 'LOCKED'
         AND (? IS NULL OR created_at > ?)
         LIMIT 1`,
        [startupId, legalResetCutoff, legalResetCutoff]
      );

      if (existingLocked.length > 0) {
        return res.status(400).json({
          error: "GF er allerede signert og kan ikke genereres på nytt."
        });
      }

      /* =====================================================
         2️⃣ Hent siste legal data (fra board)
      ===================================================== */

      const [rows] = await pool.query(
        `SELECT *
         FROM startup_legal_data
         WHERE startup_id = ?
         AND (? IS NULL OR created_at > ?)
         ORDER BY created_at DESC
         LIMIT 1`,
        [startupId, legalResetCutoff, legalResetCutoff]
      );

      if (rows.length === 0) {
        return res.status(400).json({
          error: "Board proposal must be generated first."
        });
      }

      const data = rows[0];
      const resolvedChairName = (() => {
        const candidate = String(data.chair_name || "").trim();
        if (!candidate) return req.user.name || "";
        if (candidate.toLowerCase() === "møteleder" || candidate.toLowerCase() === "moteleder") {
          return req.user.name || candidate;
        }
        return candidate;
      })();

      /* =====================================================
         3️⃣ Generer HTML
      ===================================================== */

      const templatePath = new URL("../templates/gf-template.html", import.meta.url);
      let template = fs.readFileSync(templatePath, "utf8");

      const today = new Date().toLocaleDateString("no-NO", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      const rcRoundName = `${data.company_name} RC-runde`;

      const html = template
        .replace(/{{company_name}}/g, data.company_name)
        .replace(/{{orgnr}}/g, data.orgnr)
        .replace(/{{date}}/g, today)
        .replace(/{{amount}}/g, Number(data.amount).toLocaleString("no-NO"))
        .replace(/{{round_target_amount}}/g, `${Number(data.amount).toLocaleString("no-NO")} NOK`)
        .replace(/{{chair_name}}/g, resolvedChairName)
        .replace(/{{secretary_name}}/g, data.secretary_name)
        .replace(/{{rc_round_name}}/g, rcRoundName);

      /* =====================================================
         4️⃣ Opprett dokument
      ===================================================== */

      const [docResult] = await pool.query(
        `INSERT INTO documents
         (type, startup_id, title, html_content, status)
         VALUES ('GF', ?, ?, ?, 'DRAFT')`,
        [startupId, `GF – ${data.company_name}`, html]
      );

      const documentId = docResult.insertId;
      const [secretaryUsers] = await pool.query(
        "SELECT id FROM users WHERE email = ? LIMIT 1",
        [String(data.secretary_email || "").trim().toLowerCase()]
      );
      const secretaryUserId = secretaryUsers[0]?.id || null;
      const secretaryStatus = secretaryUserId ? "ACCEPTED" : "INVITED";

      /* =====================================================
         5️⃣ Legg til signatører
      ===================================================== */

      // Styreleder (møteleder)
      await pool.query(
        `INSERT INTO document_signers
         (document_id, email, user_id, role, status)
         VALUES (?, ?, ?, 'Møteleder', 'ACCEPTED')`,
        [documentId, req.user.email, req.user.id]
      );

      // Protokollunderskriver (invited)
      await pool.query(
        `INSERT INTO document_signers
         (document_id, email, user_id, role, status)
         VALUES (?, ?, ?, 'Protokollunderskriver', ?)`,
        [documentId, data.secretary_email, secretaryUserId, secretaryStatus]
      );

      const signUrl = `${frontendBase}/sign.html?type=gf&id=${documentId}`;
      sendDocumentSigningRequestEmail({
        to: req.user.email,
        companyName: data.company_name,
        roleLabel: "Møteleder",
        documentTitle: `GF – ${data.company_name}`,
        signUrl
      });

      if (data.secretary_email) {
        sendDocumentSigningRequestEmail({
          to: data.secretary_email,
          companyName: data.company_name,
          roleLabel: "Protokollunderskriver",
          documentTitle: `GF – ${data.company_name}`,
          signUrl
        });
      }

      /* =====================================================
         6️⃣ Returner ID
      ===================================================== */

      res.status(201).json({
        success: true,
        documentId
      });

    } catch (err) {
      console.error("GF generate error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
