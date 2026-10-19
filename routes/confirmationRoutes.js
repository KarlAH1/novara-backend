import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { resolveCompanyStartupOwner, isUserInSameCompany } from "../utils/startupContext.js";
import {
  CONFIRMER_ROLE,
  attachBankEvidence,
  claimRequest,
  describeRequest,
  getRequest,
  listForStartup,
  listQueue,
  requestMoreInformation,
  syncConfirmationRequests
} from "../utils/paymentConfirmations.js";

/*
  The revisor's queue, and the company's side of it: uploading a bank
  statement when some investors paid by bank transfer. See
  utils/paymentConfirmations.js.
*/

const router = express.Router();
const MAX_EVIDENCE_PDF_BYTES = 7 * 1024 * 1024;

async function loadConfirmer(userId) {
  const [[user]] = await pool.query("SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1", [userId]);
  return user || null;
}

async function canSeeRequest(user, request) {
  if (user.role === CONFIRMER_ROLE || user.role === "admin") return true;
  if (Number(request.startup_id) === Number(user.id)) return true;
  return isUserInSameCompany(pool, user.id, request.startup_id);
}

router.get("/queue", auth, requireRole([CONFIRMER_ROLE, "admin"]), async (req, res) => {
  try {
    await syncConfirmationRequests(pool);
    res.json({ requests: await listQueue(pool) });
  } catch (err) {
    console.error("Confirmation queue error:", err);
    res.status(500).json({ error: "Kunne ikke hente bekreftelsene." });
  }
});

router.get("/mine", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const { company, startupUserId } = await resolveCompanyStartupOwner(pool, req.user.id);
    if (!company) return res.json({ requests: [] });
    await syncConfirmationRequests(pool);
    res.json({ requests: await listForStartup(pool, startupUserId) });
  } catch (err) {
    console.error("Startup confirmations error:", err);
    res.status(500).json({ error: "Kunne ikke hente bekreftelsene." });
  }
});

router.get("/:id(\\d+)", auth, async (req, res) => {
  try {
    const request = await getRequest(pool, req.params.id);
    if (!request || !(await canSeeRequest(req.user, request))) {
      return res.status(404).json({ error: "Fant ikke bekreftelsen." });
    }
    res.json(await describeRequest(pool, request));
  } catch (err) {
    console.error("Confirmation detail error:", err);
    res.status(500).json({ error: "Kunne ikke hente bekreftelsen." });
  }
});

router.get("/:id(\\d+)/evidence-file", auth, async (req, res) => {
  try {
    const request = await getRequest(pool, req.params.id);
    if (!request || !request.evidence_document_id || !(await canSeeRequest(req.user, request))) {
      return res.status(404).json({ error: "Fant ingen kontoutskrift." });
    }
    const [[file]] = await pool.query(
      "SELECT filename, mime_type, file_data FROM startup_documents WHERE id = ? LIMIT 1",
      [request.evidence_document_id]
    );
    if (!file?.file_data) return res.status(404).json({ error: "Fant ingen kontoutskrift." });
    const safeName = String(file.filename || "kontoutskrift.pdf").replace(/[^a-z0-9æøå._-]+/gi, "-");
    res.setHeader("Content-Type", file.mime_type || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.send(file.file_data);
  } catch (err) {
    console.error("Confirmation evidence file error:", err);
    res.status(500).json({ error: "Kunne ikke hente filen." });
  }
});

router.post("/:id(\\d+)/evidence", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const request = await getRequest(pool, req.params.id);
    const { company, startupUserId } = await resolveCompanyStartupOwner(pool, req.user.id);
    if (!request || !company || Number(request.startup_id) !== Number(startupUserId)) {
      return res.status(404).json({ error: "Fant ikke bekreftelsen." });
    }
    if (request.status === "confirmed") {
      return res.status(409).json({ error: "Innbetalingene er allerede bekreftet." });
    }

    const fileName = String(req.body?.fileName || "").trim().slice(0, 240);
    const match = String(req.body?.fileData || "").match(/^data:application\/pdf;base64,(.+)$/);
    if (!fileName || !/\.pdf$/i.test(fileName) || !match) {
      return res.status(400).json({ error: "Last opp kontoutskriften som PDF." });
    }
    const buffer = Buffer.from(match[1], "base64");
    if (buffer.length > MAX_EVIDENCE_PDF_BYTES || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return res.status(400).json({ error: "Filen er ikke en gyldig PDF, eller den er større enn 7 MB." });
    }

    const [result] = await pool.query(
      `INSERT INTO startup_documents
       (startup_id, filename, url, document_type, mime_type, uploaded_by_user_id, status,
        visible_in_document_room, used_for_conversion, parse_status, file_data, file_size)
       VALUES (?, ?, NULL, 'payment_evidence', 'application/pdf', ?, 'uploaded', 1, 0, 'not_applicable', ?, ?)`,
      [request.startup_id, fileName, req.user.id, buffer, buffer.length]
    );
    const status = await attachBankEvidence(pool, request, result.insertId);
    res.json({ success: true, status });
  } catch (err) {
    console.error("Confirmation evidence upload error:", err);
    res.status(500).json({ error: "Kunne ikke laste opp kontoutskriften." });
  }
});

router.post("/:id(\\d+)/claim", auth, requireRole([CONFIRMER_ROLE]), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const confirmer = await loadConfirmer(req.user.id);
    const result = await claimRequest(connection, req.params.id, confirmer);
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    res.json({ documentId: result.documentId, signPath: `sign.html?type=conversion&id=${result.documentId}` });
  } catch (err) {
    console.error("Confirmation claim error:", err);
    res.status(500).json({ error: "Kunne ikke klargjøre bekreftelsen." });
  } finally {
    connection.release();
  }
});

router.post("/:id(\\d+)/request-info", auth, requireRole([CONFIRMER_ROLE]), async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (message.length < 5 || message.length > 1000) {
      return res.status(400).json({ error: "Skriv hva som mangler (maks 1000 tegn)." });
    }
    const request = await getRequest(pool, req.params.id);
    if (!request) return res.status(404).json({ error: "Fant ikke bekreftelsen." });
    if (request.status === "confirmed" || request.document_id) {
      return res.status(409).json({ error: "Bekreftelsen er allerede tatt eller fullført." });
    }
    await requestMoreInformation(pool, request, { message, confirmer: await loadConfirmer(req.user.id) });
    res.json({ success: true });
  } catch (err) {
    console.error("Confirmation info request error:", err);
    res.status(500).json({ error: "Kunne ikke sende forespørselen." });
  }
});

export default router;
