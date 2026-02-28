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

      // 1️⃣ Hent siste legal data
      const [rows] = await pool.query(
        `SELECT *
         FROM startup_legal_data
         WHERE startup_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(400).json({
          error: "Board proposal must be generated first."
        });
      }

      const data = rows[0];

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

      const [docResult] = await pool.query(
        `INSERT INTO documents
         (type, startup_id, title, html_content, status)
         VALUES ('GF', ?, ?, ?, 'DRAFT')`,
        [req.user.id, `GF – ${data.company_name}`, html]
      );

      const documentId = docResult.insertId;

      // Legg til begge signatører
      // Styreleder
        // Møteleder
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