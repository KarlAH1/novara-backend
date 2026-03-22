import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import fs from "fs";
import { canStartupCreateRaise } from "../utils/startupPlanAccess.js";
import { cleanupLegalDocuments } from "../utils/legalDocumentCleanup.js";

const router = express.Router();

async function canRestartLegalFlow(startupId) {
  const [emissionRows] = await pool.query(
    `
    SELECT id
    FROM emission_rounds
    WHERE startup_id = ?
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
    LIMIT 1
    `,
    [startupId]
  );

  return agreementRows.length === 0;
}

router.post(
  "/generate",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {

      const startupId = req.user.id;

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
         LIMIT 1`,
        [startupId]
      );

      if (existingLocked.length > 0) {
        const canRestart = await canRestartLegalFlow(startupId);

        if (!canRestart) {
          return res.status(400).json({
            error: "GF er allerede signert og kan ikke genereres på nytt."
          });
        }

        await cleanupLegalDocuments(pool, startupId, ["GF"]);
      }

      /* =====================================================
         2️⃣ Hent siste legal data (fra board)
      ===================================================== */

      const [rows] = await pool.query(
        `SELECT *
         FROM startup_legal_data
         WHERE startup_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [startupId]
      );

      if (rows.length === 0) {
        return res.status(400).json({
          error: "Board proposal must be generated first."
        });
      }

      const data = rows[0];

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
      const rcConversionPeriodYears = "3";

      const html = template
        .replace(/{{company_name}}/g, data.company_name)
        .replace(/{{orgnr}}/g, data.orgnr)
        .replace(/{{date}}/g, today)
        .replace(/{{amount}}/g, Number(data.amount).toLocaleString("no-NO"))
        .replace(/{{chair_name}}/g, data.chair_name)
        .replace(/{{secretary_name}}/g, data.secretary_name)
        .replace(/{{rc_round_name}}/g, rcRoundName)
        .replace(/{{rc_conversion_period_years}}/g, rcConversionPeriodYears);

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
         (document_id, email, role, status)
         VALUES (?, ?, 'Protokollunderskriver', 'INVITED')`,
        [documentId, data.secretary_email]
      );

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
