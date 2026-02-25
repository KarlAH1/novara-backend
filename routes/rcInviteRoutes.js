import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";

const router = express.Router();

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
      const { email, expiresInDays } = req.body;

      await connection.beginTransaction();

      /* Lock round */
      const [roundRows] = await connection.query(
        "SELECT * FROM rc_rounds WHERE id=? FOR UPDATE",
        [roundId]
      );

      if (roundRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Round not found" });
      }

      const round = roundRows[0];

      if (round.startup_id !== req.user.id) {
        await connection.rollback();
        return res.status(403).json({ error: "Not your round" });
      }

      if (round.status !== "OPEN") {
        await connection.rollback();
        return res.status(400).json({ error: "Round not open" });
      }

      const token = generateInviteToken();
      const expiryDays = expiresInDays || 14;

      await connection.query(
        `
        INSERT INTO rc_invites
        (round_id, token, email, expires_at)
        VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
        `,
        [roundId, token, email || null, expiryDays]
      );

      await connection.commit();

      res.status(201).json({
        message: "Invite created",
        inviteLink: `https://raisium.io/invite/${token}`,
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
          i.id AS invite_id,
          i.round_id,
          i.status AS invite_status,
          i.expires_at,
  
          r.name AS round_name,
          r.rc_pool_percent,
          r.rc_pool_amount,
          r.funded_amount,
          r.trigger_amount,
          r.optional_conversion,
          r.maturation_date,
          r.discount_percent,
          r.valuation_cap,
          r.status AS round_status,
  
          u.name AS company_name,
          u.email AS startup_email
  
        FROM rc_invites i
        JOIN rc_rounds r ON i.round_id = r.id
        JOIN users u ON r.startup_id = u.id
        WHERE i.token = ?
        `,
        [token]
      );
  
      if (rows.length === 0) {
        return res.status(404).json({ error: "Invalid invite" });
      }
  
      const invite = rows[0];
  
      if (invite.invite_status !== "ACTIVE") {
        return res.status(400).json({ error: "Invite not active" });
      }
  
      if (invite.round_status !== "OPEN") {
        return res.status(400).json({ error: "Round not open" });
      }
  
      if (new Date(invite.expires_at) < new Date()) {
        await pool.query(
          "UPDATE rc_invites SET status='EXPIRED' WHERE id=?",
          [invite.invite_id]
        );
        return res.status(400).json({ error: "Invite expired" });
      }
  
      const remainingCapacity =
        Number(invite.rc_pool_amount) - Number(invite.funded_amount);
  
      if (remainingCapacity <= 0) {
        return res.status(400).json({ error: "Round fully funded" });
      }
  
      res.json({
        roundId: invite.round_id,
        roundName: invite.round_name,
  
        startup: {
          companyName: invite.company_name,
          contactEmail: invite.startup_email
        },
  
        terms: {
          poolPercent: invite.rc_pool_percent,
          poolAmount: invite.rc_pool_amount,
          fundedAmount: invite.funded_amount,
          remainingCapacity,
          triggerAmount: invite.trigger_amount,
          optionalConversion: invite.optional_conversion === 1,
          maturationDate: invite.maturation_date,
          discountPercent: invite.discount_percent,
          valuationCap: invite.valuation_cap
        },
  
        riskAcknowledgementRequired: true
      });
  
    } catch (err) {
      console.error("Validate invite failed:", err);
      res.status(500).json({ error: "Internal server error" });
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
        JOIN rc_rounds r ON i.round_id = r.id
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
        "UPDATE rc_invites SET status='REVOKED' WHERE id=?",
        [inviteId]
      );

      res.json({ message: "Invite revoked" });

    } catch (err) {
      console.error("Revoke invite failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;