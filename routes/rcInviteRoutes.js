import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";
import { getInvite } from "../controllers/rcInviteController.js";
import { validatePasswordRequirements } from "../utils/authSecurity.js";
import { isEmailVerificationRequired, sendVerificationEmail } from "../utils/authEmailFlow.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";

const router = express.Router();

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

router.get("/validate/:token", async (req, res) => {
  try {

    const token = req.params.token;

    const [rows] = await pool.query(
      `
      SELECT 
        i.round_id,
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
      }
    });

  } catch (err) {
    console.error("Validate invite failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/access/:token", async (req, res) => {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  const requireEmailVerification = isEmailVerificationRequired();

  try {
    const token = req.params.token;
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email) {
      return res.status(400).json({ error: "Navn og e-post er påkrevd" });
    }

    const [inviteRows] = await connection.query(
      `
      SELECT r.id, r.open
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

    const availability = await syncEmissionRoundAvailability(connection, inviteRows[0].id);
    if (!availability?.canInvest) {
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed",
        remainingCapacity: availability?.remainingCapacity || 0
      });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [userRows] = await connection.query(
      "SELECT * FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    let user = userRows[0];

    if (!user) {
      const passwordError = validatePasswordRequirements(password);
      if (passwordError) {
        await connection.rollback();
        return res.status(400).json({ error: passwordError });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await connection.query(
        "INSERT INTO users (name, email, password, role, email_verified) VALUES (?, ?, ?, 'investor', ?)",
        [name, email, passwordHash, requireEmailVerification ? 0 : 1]
      );

      user = {
        id: result.insertId,
        name,
        email,
        role: "investor"
      };

      if (requireEmailVerification) {
        await sendVerificationEmail(connection, {
          userId: user.id,
          email: user.email,
          name: user.name
        });
      }
    } else if (user.role.toLowerCase() !== "investor") {
      await connection.rollback();
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes i denne private investorflyten" });
    } else {
      await connection.rollback();
      return res.status(400).json({ error: "Brukeren finnes allerede. Logg inn med e-post og passord." });
    }

    await connection.commit();

    const authToken = jwt.sign(
      {
        id: user.id,
        role: "investor",
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: requireEmailVerification
        ? "Investor-tilgang opprettet. Bekreft e-posten din for fremtidige innlogginger."
        : "Investor-tilgang opprettet. Du kan logge inn med en gang i dev.",
      requiresEmailVerification: requireEmailVerification,
      token: authToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: "investor"
      }
    });
  } catch (err) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("Invite access failed:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
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
