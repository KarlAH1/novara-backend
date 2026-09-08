import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";
import { getInvite } from "../controllers/rcInviteController.js";
import { createExpiry, hashToken, validatePasswordRequirements } from "../utils/authSecurity.js";
import { sendInvestorInviteAccessCodeEmail } from "../utils/authEmailFlow.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import { buildParPreview } from "../utils/roundActivationReadiness.js";
import {
  INVITE_TAKEN_ERROR,
  claimInviteForUser,
  getOptionalUserFromRequest,
  inviteIsAvailableTo,
  loadInviteClaim
} from "../utils/inviteClaim.js";
import { createAuthToken } from "../utils/authToken.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = express.Router();
const inviteAccessLimiter = createRateLimiter({
  keyPrefix: "invite-access-code",
  windowMs: 10 * 60 * 1000,
  maxRequests: 8,
  message: "For mange kodeforsøk. Vent litt og prøv igjen."
});

function createSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

router.get("/:token", getInvite);
/* =====================================================
   CREATE INVITE (Startup Only)
===================================================== */

router.post(
  "/create/:roundId",
  auth,
  requireRole(["startup"]),
  async (req, res) => {

    const connection = await pool.getConnection();

    try {
      const roundId = req.params.roundId;

      await connection.beginTransaction();

      const [roundRows] = await connection.query(
        "SELECT * FROM emission_rounds WHERE id=? FOR UPDATE",
        [roundId]
      );

      if (roundRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Emission not found" });
      }

      const round = roundRows[0];

      if (round.startup_id !== req.user.id) {
        await connection.rollback();
        return res.status(403).json({ error: "Not your emission" });
      }

      if (round.open !== 1) {
        await connection.rollback();
        return res.status(400).json({ error: "Emission not open" });
      }

      const token = generateInviteToken();

      await connection.query(
        "INSERT INTO rc_invites (round_id, token) VALUES (?, ?)",
        [roundId, token]
      );

      await connection.commit();

      res.status(201).json({
        message: "Privat invitasjonslenke opprettet",
        token
      });

    } catch (err) {
      await connection.rollback();
      console.error("Create invite failed:", err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);

/* =====================================================
   VALIDATE INVITE (Public access)
===================================================== */

/* =====================================================
   VALIDATE INVITE (Public)
   Returns full round + startup summary
===================================================== */

/*
  Illustrative par amount for an invited investor, using the long-stop scenario:
  no discount, price set by the valuation cap over the company's issued shares.
  Returns null whenever the share basis is not yet confirmed, rather than
  guessing — a wrong estimate here is worse than none.
*/
async function buildInviteParEstimate(connection, invite) {
  try {
    const cap = Number(invite.valuation_cap || 0);
    const target = Number(invite.target_amount || 0);
    if (!cap || !target) return null;

    const [[profile]] = await connection.query(
      `SELECT nominal_value_per_share, current_share_count
       FROM startup_profiles WHERE user_id = ? LIMIT 1`,
      [invite.startup_id]
    );

    const preview = buildParPreview({
      valuationCap: cap,
      shareCount: Number(profile?.current_share_count || 0),
      parValue: Number(profile?.nominal_value_per_share || 0),
      // A typical single investment: one tenth of the round, so the figure is
      // recognisable rather than the whole round's aggregate.
      exampleInvestment: Math.max(Math.round(target / 10), 1)
    });

    return preview && !preview.blocked ? preview : null;
  } catch {
    return null;
  }
}

/*
  What this investor's own amount would mean at conversion.

  The generic example on the terms page is not enough: the second payment is the
  most surprising part of the model, and someone deciding to put in NOK 5,000
  needs to see the figure for NOK 5,000, next to the field where they type it.

  Calculated here, by the same calculator that will later produce the binding
  allocation. The browser never derives an allocation of its own.
*/
router.get("/:token/par-estimate", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const token = String(req.params.token || "").trim();
    const amount = Number(req.query.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.json({ estimate: null });
    }

    const [rows] = await connection.query(
      `SELECT r.startup_id, r.valuation_cap
       FROM rc_invites i
       JOIN emission_rounds r ON i.round_id = r.id
       WHERE i.token = ? LIMIT 1`,
      [token]
    );
    const round = rows[0];
    if (!round) return res.status(404).json({ error: "Fant ikke invitasjonen." });

    const [[profile]] = await connection.query(
      `SELECT nominal_value_per_share, current_share_count
       FROM startup_profiles WHERE user_id = ? LIMIT 1`,
      [round.startup_id]
    );

    const preview = buildParPreview({
      valuationCap: Number(round.valuation_cap || 0),
      shareCount: Number(profile?.current_share_count || 0),
      parValue: Number(profile?.nominal_value_per_share || 0),
      exampleInvestment: amount
    });

    res.json({ estimate: preview && !preview.blocked ? preview : null });
  } catch (err) {
    console.error("Par estimate error:", err);
    res.json({ estimate: null });
  } finally {
    connection.release();
  }
});

router.get("/validate/:token", async (req, res) => {
  try {

    const token = req.params.token;

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteClaim) {
      return res.status(404).json({ error: "Ugyldig invitasjon." });
    }

    if (!inviteIsAvailableTo(inviteClaim, getOptionalUserFromRequest(req)?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const [rows] = await pool.query(
      `
      SELECT 
        i.round_id,
        r.startup_id,
        r.target_amount,
        r.amount_raised,
        r.discount_rate,
        r.valuation_cap,
        r.conversion_years,
        r.open,
        COALESCE(c.company_name, sp.company_name, u.name) AS company_name,
        sp.sector AS what_offers,
        sp.pitch AS use_of_funds,
        sp.vision AS description,
        sd.filename AS pitch_deck_filename,
        sd.url AS pitch_deck_url
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      JOIN users u ON r.startup_id = u.id
      LEFT JOIN company_memberships cm ON cm.user_id = r.startup_id
      LEFT JOIN companies c ON c.id = cm.company_id
      LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
      LEFT JOIN startup_documents sd ON sd.id = (
        SELECT sd2.id
        FROM startup_documents sd2
        WHERE sd2.startup_id = r.startup_id
          AND sd2.document_type = 'pitch_deck'
        ORDER BY sd2.uploaded_at DESC, sd2.id DESC
        LIMIT 1
      )
      WHERE i.token = ?
      `,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Ugyldig invitasjon til privat runde" });
    }

    const invite = rows[0];
    const availability = await syncEmissionRoundAvailability(pool, invite.round_id);

    res.json({
      startup: {
        companyName: invite.company_name,
        portalTitle: `${invite.company_name} sin private rundeportal`,
        portalIntro: `Denne siden brukes av ${invite.company_name} for avtaler, dokumenter og status. Raisium leverer programvaren.`,
        whatOffers: invite.what_offers || "",
        useOfFunds: invite.use_of_funds || "",
        description: invite.description || "",
        pitchDeck: invite.pitch_deck_url
          ? {
              filename: invite.pitch_deck_filename || "Åpne PDF",
              url: invite.pitch_deck_url
            }
          : null
      },
      round: {
        id: invite.round_id,
        status: availability?.status || (invite.open === 1 ? "LIVE" : "DRAFT"),
        targetAmount: availability?.targetAmount ?? Number(invite.target_amount || 0),
        committedAmount: availability?.committedAmount ?? availability?.committed_amount ?? null,
        amountRaised: availability?.confirmedPaidAmount ?? availability?.amount_raised ?? invite.amount_raised ?? null,
        closedReason: availability?.closedReason || null,
        canInvest: availability?.canInvest ?? false,
        message: availability?.message || null
      },
      terms: {
        targetAmount: invite.target_amount,
        amountRaised: invite.amount_raised,
        discountRate: invite.discount_rate,
        valuationCap: invite.valuation_cap,
        conversionYears: invite.conversion_years
      },
      // Deterministic only for the long-stop scenario, where the valuation cap
      // alone sets the price. Calculated here so the browser never derives a
      // legal allocation of its own.
      par_estimate: await buildInviteParEstimate(connection, invite)
    });

  } catch (err) {
    console.error("Validate invite failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/access-code/send/:token", inviteAccessLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email) {
      return res.status(400).json({ error: "Navn og e-post er påkrevd." });
    }

    if (password) {
      const passwordError = validatePasswordRequirements(password);
      if (passwordError) {
        return res.status(400).json({ error: passwordError });
      }
    }

    const [inviteRows] = await pool.query(
      `
      SELECT r.id
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      WHERE i.token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!inviteRows.length) {
      return res.status(404).json({ error: "Ugyldig eller lukket invitasjon til privat runde" });
    }

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteIsAvailableTo(inviteClaim, getOptionalUserFromRequest(req)?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const availability = await syncEmissionRoundAvailability(pool, inviteRows[0].id);
    if (!availability?.canInvest) {
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }

    const [userRows] = await pool.query(
      "SELECT id, role FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (userRows.length) {
      const existingRole = String(userRows[0].role || "").toLowerCase();
      if (existingRole === "investor") {
        return res.status(400).json({ error: "Brukeren finnes allerede. Logg inn med e-post og passord." });
      }
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes i denne private investorflyten." });
    }

    const code = createSixDigitCode();
    const expiresAt = createExpiry(0.25);

    await pool.query(
      `
      INSERT INTO startup_email_verifications (email, code_hash, verification_token_hash, expires_at)
      VALUES (?, ?, NULL, ?)
      `,
      [email, hashToken(code), expiresAt]
    );

    await sendInvestorInviteAccessCodeEmail({ email, code });

    res.json({
      success: true,
      message: "Vi har sendt en kode til e-posten din.",
      expiresAt
    });
  } catch (err) {
    console.error("Send investor invite access code failed:", {
      message: err?.message || String(err),
      email: String(req.body?.email || "").trim().toLowerCase(),
      hasResendKey: Boolean(String(process.env.RESEND_API_KEY || process.env.RESEND_KEY || "").trim()),
      hasEmailFrom: Boolean(String(process.env.EMAIL_FROM || process.env.RESEND_FROM || process.env.FROM_EMAIL || process.env.MAIL_FROM || "").trim()),
      environment: process.env.NODE_ENV || "development"
    });
    res.status(500).json({ error: "Kunne ikke sende kode akkurat nå." });
  }
});

router.post("/access-code/verify/:token", inviteAccessLimiter, async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const code = String(req.body.code || "").trim();

    if (!name || !email || !password || !code) {
      return res.status(400).json({ error: "Navn, e-post, passord og kode er påkrevd." });
    }

    const passwordError = validatePasswordRequirements(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const [inviteRows] = await pool.query(
      `
      SELECT r.id
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      WHERE i.token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!inviteRows.length) {
      return res.status(404).json({ error: "Ugyldig eller lukket invitasjon til privat runde" });
    }

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteIsAvailableTo(inviteClaim, getOptionalUserFromRequest(req)?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const availability = await syncEmissionRoundAvailability(pool, inviteRows[0].id);
    if (!availability?.canInvest) {
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }

    const [verificationRows] = await pool.query(
      `
      SELECT id, code_hash, expires_at, attempts
      FROM startup_email_verifications
      WHERE email = ?
        AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1
      `,
      [email]
    );

    const record = verificationRows[0];
    if (!record) {
      return res.status(400).json({ error: "Fant ingen aktiv kode. Be om en ny kode." });
    }

    const expiresAt = new Date(record.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Koden har utløpt. Be om en ny kode." });
    }

    if (Number(record.attempts || 0) >= 5) {
      return res.status(429).json({ error: "For mange kodeforsøk. Be om en ny kode." });
    }

    if (hashToken(code) !== record.code_hash) {
      await pool.query(
        `
        UPDATE startup_email_verifications
        SET attempts = attempts + 1,
            consumed_at = IF(attempts + 1 >= 5, NOW(), consumed_at)
        WHERE id = ? AND consumed_at IS NULL AND attempts < 5
        `,
        [record.id]
      );
      return res.status(400).json({ error: "Koden er ugyldig." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [userRows] = await connection.query(
      "SELECT id, role FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (userRows.length) {
      await connection.rollback();
      transactionStarted = false;
      const existingRole = String(userRows[0].role || "").toLowerCase();
      if (existingRole === "investor") {
        return res.status(400).json({ error: "Brukeren finnes allerede. Logg inn med e-post og passord." });
      }
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes i denne private investorflyten." });
    }

    const [result] = await connection.query(
      "INSERT INTO users (name, email, password, role, email_verified, email_verification_token, email_verification_expires) VALUES (?, ?, ?, 'investor', 1, NULL, NULL)",
      [name, email, passwordHash]
    );

    const [verificationUpdate] = await connection.query(
      `
      UPDATE startup_email_verifications
      SET verified_at = NOW(),
          consumed_at = NOW()
      WHERE id = ? AND consumed_at IS NULL AND attempts < 5
      `,
      [record.id]
    );

    if (verificationUpdate.affectedRows !== 1) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ error: "Koden er allerede brukt eller låst." });
    }

    // Bind the invite to this investor — anyone else with the link is now locked out.
    if (!(await claimInviteForUser(connection, token, result.insertId))) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    await connection.commit();
    transactionStarted = false;

    const user = {
      id: result.insertId,
      name,
      email,
      role: "investor"
    };

    res.json({
      success: true,
      message: "E-posten er verifisert. Du kan fortsette.",
      token: createAuthToken(user),
      user
    });
  } catch (err) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("Verify investor invite access code failed:", err);
    res.status(500).json({ error: "Kunne ikke verifisere koden." });
  } finally {
    connection?.release();
  }
});

router.post("/access/:token", async (req, res) => {
  res.status(410).json({
    success: false,
    error: "Bruk kodeverifisering for å opprette investortilgang."
  });
});

/* =====================================================
   REVOKE INVITE
===================================================== */

router.post(
  "/revoke/:inviteId",
  auth,
  requireRole(["startup"]),
  async (req, res) => {

    try {
      const inviteId = req.params.inviteId;

      const [rows] = await pool.query(
        `
        SELECT i.*, r.startup_id
        FROM rc_invites i
        JOIN emission_rounds r ON i.round_id = r.id
        WHERE i.id = ?
        `,
        [inviteId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Invite not found" });
      }

      const invite = rows[0];

      if (invite.startup_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      await pool.query(
        "DELETE FROM rc_invites WHERE id=?",
        [inviteId]
      );

      res.json({ message: "Invite removed" });

    } catch (err) {
      console.error("Revoke invite failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
