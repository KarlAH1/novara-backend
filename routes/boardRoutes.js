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

    console.log("BOARD BODY:", req.body);

    try {

      const {
        companyName,
        orgnr,
        amount,
        chairName,
        secretaryName,
        secretaryEmail
      } = req.body;
      
      if (!companyName || !orgnr || !amount || !chairName || !secretaryName || !secretaryEmail) {
        return res.status(400).json({
          error: "Missing required fields"
        });
      }
      
      const chairEmail = req.user.email;

      // 1️⃣ Lagre legal data
      await pool.query(
          `INSERT INTO startup_legal_data
          (startup_id, company_name, orgnr, amount, chair_name, secretary_name, secretary_email)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, companyName, orgnr, amount, chairName, secretaryName, secretaryEmail]
        );

      // 2️⃣ Hent template
      const templatePath = path.resolve("templates/bp-template.html");
      let template = fs.readFileSync(templatePath, "utf8");

      const today = new Date().toLocaleDateString("no-NO", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      const html = template
        .replace(/{{company_name}}/g, companyName)
        .replace(/{{orgnr}}/g, orgnr)
        .replace(/{{board_date}}/g, today)
        .replace(/{{amount}}/g, Number(amount).toLocaleString("no-NO"))
        .replace(/{{chair_name}}/g, chairName);

      // 3️⃣ Lag dokument
      const [docResult] = await pool.query(
        `INSERT INTO documents
         (type, startup_id, title, html_content, status)
         VALUES ('BOARD', ?, ?, ?, 'DRAFT')`,
        [req.user.id, `Styrets forslag – ${companyName}`, html]
      );

      const documentId = docResult.insertId;

      // 4️⃣ Opprett signatør
      await pool.query(
        `INSERT INTO document_signers
         (document_id, email, user_id, role, status)
         VALUES (?, ?, ?, 'Styreleder', 'ACCEPTED')`,
        [documentId, chairEmail, req.user.id]
      );

      res.status(201).json({
        success: true,
        documentId
      });

    } catch (err) {
      console.error("Board generate error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;