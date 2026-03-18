import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";
import { getInvite } from "../controllers/rcInviteController.js";
import { validatePasswordRequirements } from "../utils/authSecurity.js";
import { isEmailVerificationRequired, sendVerificationEmail } from "../utils/authEmailFlow.js";

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
        message: "Invite created",
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
        u.name AS company_name
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      JOIN users u ON r.startup_id = u.id
      WHERE i.token = ?
      `,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Invalid invite" });
    }

    const invite = rows[0];

    if (invite.open !== 1) {
      return res.status(400).json({ error: "Emission closed" });
    }

    res.json({
      startup: {
        companyName: invite.company_name
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

    if (!inviteRows.length || inviteRows[0].open !== 1) {
      return res.status(404).json({ error: "Ugyldig eller lukket investorinvitasjon" });
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
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes som investor" });
    } else {
      await connection.rollback();
      return res.status(400).json({ error: "Investor finnes allerede. Logg inn med e-post og passord." });
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
