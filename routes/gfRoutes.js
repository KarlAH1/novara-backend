import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import fs from "fs";
import path from "path";

const router = express.Router();

router.post(
  "/generate",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {

      const startupId = req.user.id;

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

      const templatePath = path.resolve("templates/gf-template.html");
      let template = fs.readFileSync(templatePath, "utf8");

      const today = new Date().toLocaleDateString("no-NO", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      const html = template
        .replace(/{{company_name}}/g, data.company_name)
        .replace(/{{orgnr}}/g, data.orgnr)
        .replace(/{{date}}/g, today)
        .replace(/{{amount}}/g, Number(data.amount).toLocaleString("no-NO"))
        .replace(/{{chair_name}}/g, data.chair_name)
        .replace(/{{secretary_name}}/g, data.secretary_name);

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