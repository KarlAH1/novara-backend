import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { sendEmail } from "../utils/emailService.js";
import { renderEmail, frontendBase } from "../utils/emailLayout.js";
import { escapeHtml } from "../utils/html.js";
import {
  findCompanyForUser,
  loadInvestorFeed,
  loadUpdateReaders,
  normalizeUpdateInput
} from "../utils/startupUpdates.js";

const router = express.Router();

const postLimiter = createRateLimiter({
  keyPrefix: "startup-update",
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  message: "Du har publisert mange oppdateringer på kort tid. Vent litt og prøv igjen."
});

/* The company's own updates, newest first, with how many can read them. */
router.get("/mine", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const company = await findCompanyForUser(pool, req.user.id);
    if (!company) return res.json({ updates: [], readerCount: 0 });
    const [updates] = await pool.query(
      `SELECT id, title, body, created_at, emailed_at
       FROM startup_updates WHERE company_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 50`,
      [company.id]
    );
    const readers = await loadUpdateReaders(pool, company.id);
    res.json({ updates, readerCount: readers.length });
  } catch (err) {
    console.error("Load own updates failed:", err);
    res.status(500).json({ error: "Kunne ikke hente oppdateringene." });
  }
});

/* Publish an update to everyone who has signed. */
router.post("/", auth, requireRole(["startup"]), postLimiter, async (req, res) => {
  try {
    const input = normalizeUpdateInput(req.body || {});
    if (!input.ok) return res.status(400).json({ error: input.error });

    const company = await findCompanyForUser(pool, req.user.id);
    if (!company) {
      return res.status(400).json({ error: "Kontoen er ikke koblet til et selskap ennå." });
    }

    const readers = await loadUpdateReaders(pool, company.id);
    if (!readers.length) {
      return res.status(400).json({ error: "Ingen har signert ennå. Oppdateringer går til dem som har investert." });
    }

    const [result] = await pool.query(
      "INSERT INTO startup_updates (company_id, author_user_id, title, body) VALUES (?, ?, ?, ?)",
      [company.id, req.user.id, input.title, input.body]
    );

    let emailed = 0;
    if (input.sendEmail) {
      const [[author]] = await pool.query("SELECT name FROM users WHERE id = ? LIMIT 1", [req.user.id]);
      const authorName = String(author?.name || "").trim() || company.company_name;
      const link = `${frontendBase()}/profile.html#oppdateringer`;
      const results = await Promise.allSettled(readers.filter((r) => r.email).map((reader) => sendEmail({
        to: reader.email,
        subject: `${company.company_name}: ${input.title}`,
        text: `${input.title}\n\n${input.body}\n\n– ${authorName}\n\nSe alle oppdateringer:\n${link}`,
        html: renderEmail({
          heading: input.title,
          introHtml: `En oppdatering fra <strong>${escapeHtml(company.company_name)}</strong>, til dere som har investert.`,
          box: { linesHtml: `${escapeHtml(input.body).replace(/\n/g, "<br>")}<br><br>– ${escapeHtml(authorName)}` },
          button: { label: "Se alle oppdateringer", url: link },
          after: "Du får denne fordi du har en avtale med selskapet.",
          preheader: input.body.slice(0, 120),
          accent: "investor"
        })
      })));
      emailed = results.filter((r) => r.status === "fulfilled").length;
      if (emailed) {
        await pool.query("UPDATE startup_updates SET emailed_at = NOW() WHERE id = ?", [result.insertId]);
      }
    }

    res.status(201).json({
      id: result.insertId,
      readerCount: readers.length,
      emailed,
      message: input.sendEmail
        ? `Oppdateringen er publisert og sendt til ${emailed} ${emailed === 1 ? "investor" : "investorer"}.`
        : "Oppdateringen er publisert."
    });
  } catch (err) {
    console.error("Publish update failed:", err);
    res.status(500).json({ error: "Kunne ikke publisere oppdateringen. Prøv igjen." });
  }
});

router.delete("/:id", auth, requireRole(["startup"]), async (req, res) => {
  try {
    const company = await findCompanyForUser(pool, req.user.id);
    const [result] = await pool.query(
      "DELETE FROM startup_updates WHERE id = ? AND company_id = ?",
      [Number(req.params.id), company?.id || 0]
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Fant ikke oppdateringen." });
    res.json({ message: "Oppdateringen er slettet." });
  } catch (err) {
    console.error("Delete update failed:", err);
    res.status(500).json({ error: "Kunne ikke slette oppdateringen." });
  }
});

/* An investor's feed: updates from the companies they have signed with. */
router.get("/feed", auth, requireRole(["investor"]), async (req, res) => {
  try {
    res.json({ updates: await loadInvestorFeed(pool, req.user.id) });
  } catch (err) {
    console.error("Load investor feed failed:", err);
    res.status(500).json({ error: "Kunne ikke hente oppdateringene." });
  }
});

export default router;
