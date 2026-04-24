import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import fs from "fs";
import { canStartupCreateRaise } from "../utils/startupPlanAccess.js";
import { cleanupLegalDocuments } from "../utils/legalDocumentCleanup.js";
import { resolveCompanyStartupOwner } from "../utils/startupContext.js";

const router = express.Router();
const MAX_EMISSION_AMOUNT = 2147483647;

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

    console.log("BOARD BODY:", req.body);

    try {
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupId = startupContext.startupUserId;

      if (!(await canStartupCreateRaise(req.user.id))) {
        return res.status(403).json({
          error: "Du må ha en aktiv startup-plan for å opprette dokumentgrunnlaget."
        });
      }

      const {
        amount,
        chairName,
        secretaryName,
        secretaryEmail
      } = req.body;
      
      if (!amount || !chairName || !secretaryName || !secretaryEmail) {
        return res.status(400).json({
          error: "Missing required fields"
        });
      }

      const numericAmount = Number(amount);

      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
          error: "Amount must be a valid positive number"
        });
      }

      if (numericAmount > MAX_EMISSION_AMOUNT) {
        return res.status(400).json({
          error: `Amount is too large. Max allowed is ${MAX_EMISSION_AMOUNT.toLocaleString("no-NO")} NOK`
        });
      }

      const [existingLockedDocs] = await pool.query(
        `
        SELECT id
        FROM documents
        WHERE startup_id = ?
          AND type IN ('BOARD', 'GF')
          AND status IN ('SIGNED', 'LOCKED')
        LIMIT 1
        `,
        [startupId]
      );

      if (existingLockedDocs.length > 0) {
        const canRestart = await canRestartLegalFlow(startupId);
        if (!canRestart) {
          return res.status(400).json({
            error: "Dokumentgrunnlaget kan ikke erstattes mens emisjon eller RC-prosess finnes."
          });
        }

        await cleanupLegalDocuments(pool, startupId, ["BOARD", "GF"]);
      }

      if (!startupContext.company) {
        return res.status(400).json({
          error: "Fant ikke selskapsinformasjon for brukeren. Registrer startup først."
        });
      }

      const companyName = String(startupContext.company.company_name || "").trim();
      const orgnr = String(startupContext.company.orgnr || "").trim();

      if (!companyName || !orgnr) {
        return res.status(400).json({
          error: "Selskapsnavn eller organisasjonsnummer mangler."
        });
      }

      const chairEmail = req.user.email;

      // 1️⃣ Lagre legal data
      await pool.query(
          `INSERT INTO startup_legal_data
          (startup_id, company_name, orgnr, amount, chair_name, secretary_name, secretary_email)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [startupId, companyName, orgnr, numericAmount, chairName, secretaryName, secretaryEmail]
        );

      // 2️⃣ Hent template
      const templatePath = new URL("../templates/bp-template.html", import.meta.url);
      let template = fs.readFileSync(templatePath, "utf8");

      const today = new Date().toLocaleDateString("no-NO", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      const rcRoundName = `${companyName} RC-runde`;

      const html = template
        .replace(/{{company_name}}/g, companyName)
        .replace(/{{orgnr}}/g, orgnr)
        .replace(/{{board_date}}/g, today)
        .replace(/{{amount}}/g, numericAmount.toLocaleString("no-NO"))
        .replace(/{{round_target_amount}}/g, `${numericAmount.toLocaleString("no-NO")} NOK`)
        .replace(/{{chair_name}}/g, chairName)
        .replace(/{{rc_round_name}}/g, rcRoundName);

      // 3️⃣ Lag dokument
      const [docResult] = await pool.query(
        `INSERT INTO documents
         (type, startup_id, title, html_content, status)
         VALUES ('BOARD', ?, ?, ?, 'DRAFT')`,
        [startupId, `Styrets forslag – ${companyName}`, html]
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
