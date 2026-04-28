import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =====================================================
   CREATE RC ROUND (Startup Only)
===================================================== */

router.post(
  "/",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {
      const {
        name,
        rcPoolPercent,
        rcPoolAmount,
        triggerAmount,
        optionalConversion,
        maturationDate,
        discountPercent,
        valuationCap
      } = req.body;

      if (!name || !rcPoolPercent || !rcPoolAmount || !triggerAmount || !maturationDate) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      /* =========================================
         HENT NYESTE GF-RAMME
      ========================================= */

      const [gfRows] = await pool.query(
        `
        SELECT *
        FROM startup_gf_approvals
        WHERE startup_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [req.user.id]
      );

      if (gfRows.length === 0) {
        return res.status(400).json({
          error: "No GF approval found. Register GF approval before starting a round."
        });
      }

      const gfApproval = gfRows[0];

      if (Number(rcPoolAmount) > Number(gfApproval.approved_amount)) {
        return res.status(400).json({
          error: "Amount exceeds approved GF framework"
        });
      }

              /* =========================================
          LEGAL VALIDATION
        ========================================= */

      const [legalRows] = await pool.query(
        `
        SELECT
          SUM(CASE WHEN type='BOARD' AND status='SIGNED' THEN 1 ELSE 0 END) AS board_signed,
          SUM(CASE WHEN type='GF' AND status='SIGNED' THEN 1 ELSE 0 END) AS gf_signed
        FROM documents
        WHERE startup_id = ?
        `,
        [req.user.id]
      );

      const legalStatus = legalRows[0];

      if (!legalStatus.board_signed || !legalStatus.gf_signed) {
        return res.status(400).json({
          error: "Styrets forslag og Generalforsamling må være signert før emisjon kan startes."
        });
      }

      /* =========================================
         CREATE ROUND
      ========================================= */

      const [result] = await pool.query(
        `
        INSERT INTO rc_rounds
        (startup_id, name, rc_pool_percent, rc_pool_amount, trigger_amount,
        optional_conversion, maturation_date, discount_percent,
        valuation_cap, status, gf_approval_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
        `,
        [
          req.user.id,
          name,
          rcPoolPercent,
          rcPoolAmount,
          triggerAmount,
          optionalConversion || false,
          maturationDate,
          discountPercent || null,
          valuationCap || null,
          gfApproval.id
        ]
      );

      res.status(201).json({
        message: "RC round created",
        roundId: result.insertId
      });

    } catch (err) {
      console.error("Create round error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* =====================================================
   GET SINGLE ROUND
===================================================== */

router.get("/:id", auth, async (req, res) => {
  try {
    const roundId = req.params.id;

    const [rows] = await pool.query(
      "SELECT * FROM rc_rounds WHERE id=?",
      [roundId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Round not found" });
    }

    const round = rows[0];

    // Access control
    if (req.user.role === "startup" && round.startup_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(round);

  } catch (err) {
    console.error("Get round error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =====================================================
   GET AGREEMENTS FOR ROUND (Startup Only)
===================================================== */

router.get(
  "/:id/agreements",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {
      const roundId = req.params.id;

      const [roundRows] = await pool.query(
        "SELECT * FROM rc_rounds WHERE id=?",
        [roundId]
      );

      if (roundRows.length === 0) {
        return res.status(404).json({ error: "Round not found" });
      }

      const round = roundRows[0];

      if (round.startup_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const [agreements] = await pool.query(
        `
        SELECT id, rc_id, investor_id, investment_amount, status, created_at
        FROM rc_agreements
        WHERE round_id = ?
        ORDER BY created_at DESC
        `,
        [roundId]
      );

      res.json(agreements);

    } catch (err) {
      console.error("Get agreements error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* =====================================================
   AUTO CLOSE ROUND IF FULLY FUNDED
   (Call internally after payment confirmation)
===================================================== */

export const autoCloseRoundIfFull = async (connection, roundId) => {
  const [rows] = await connection.query(
    "SELECT funded_amount, rc_pool_amount FROM rc_rounds WHERE id=?",
    [roundId]
  );

  const round = rows[0];

  if (Number(round.funded_amount) >= Number(round.rc_pool_amount)) {
    await connection.query(
      "UPDATE rc_rounds SET status='CLOSED' WHERE id=?",
      [roundId]
    );
  }
};

/* =====================================================
   GET MY ROUNDS (Startup)
===================================================== */

router.get(
    "/my/list",
    auth,
    requireRole(["startup"]),
    async (req, res) => {
      try {
        const startupId = req.user.id;
  
        const [rows] = await pool.query(
          `
          SELECT
            id,
            name,
            rc_pool_amount,
            signed_amount,
            funded_amount,
            status,
            created_at
          FROM rc_rounds
          WHERE startup_id = ?
          ORDER BY created_at DESC
          `,
          [startupId]
        );
  
        res.json(rows);
  
      } catch (err) {
        console.error("Get my rounds failed:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

export default router;