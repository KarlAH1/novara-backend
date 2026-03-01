import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";
import { getInvite } from "../controllers/rcInviteController.js";

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