import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateHash } from "../utils/hash.js";
import { investViaInvite } from "../controllers/rcAgreementController.js";

const router = express.Router();

/* =====================================================
   CREATE RC AGREEMENT (Investor invests in round)
   Transaction-safe
===================================================== */
router.post("/invest/:token", auth, investViaInvite);

router.post(
  "/",
  auth,
  requireRole(["investor"]),
  async (req, res) => {
    const connection = await pool.getConnection();

    try {
      const { roundId, investmentAmount } = req.body;
      const investorId = req.user.id;

      if (!roundId || !investmentAmount) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      await connection.beginTransaction();

      /* 1️⃣ Lock round row */
      const [roundRows] = await connection.query(
        "SELECT * FROM rc_rounds WHERE id=? AND status='Open' FOR UPDATE",
        [roundId]
      );

      if (roundRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Round not found or closed" });
      }

      const round = roundRows[0];

      /* 2️⃣ Prevent duplicate agreement */
      const [existing] = await connection.query(
        "SELECT id FROM rc_agreements WHERE round_id=? AND investor_id=?",
        [roundId, investorId]
      );

      if (existing.length > 0) {
        await connection.rollback();
        return res.status(400).json({ error: "Investor already in this round" });
      }

      /* 3️⃣ Check pool capacity */
      const newSignedAmount =
        Number(round.signed_amount) + Number(investmentAmount);

      if (newSignedAmount > Number(round.rc_pool_amount)) {
        await connection.rollback();
        return res.status(400).json({
          error: "Investment exceeds remaining round capacity"
        });
      }

      /* 4️⃣ Create Snapshot */
      const snapshot = {
        investmentAmount,
        rcPoolPercent: round.rc_pool_percent,
        rcPoolAmount: round.rc_pool_amount,
        triggerAmount: round.trigger_amount,
        optionalConversion: round.optional_conversion,
        maturationDate: round.maturation_date,
        discountPercent: round.discount_percent,
        valuationCap: round.valuation_cap,
        createdAt: new Date().toISOString()
      };

      const snapshotHash = generateHash(snapshot);

      /* 5️⃣ Create RC Agreement */
      const rcId = `RC-${Date.now()}-${investorId}`;

      const [agreementResult] = await connection.query(
        `
        INSERT INTO rc_agreements
        (rc_id, round_id, investor_id, investment_amount, status, snapshot_hash)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          rcId,
          roundId,
          investorId,
          investmentAmount,
          "Pending Signatures",
          snapshotHash
        ]
      );

      const agreementId = agreementResult.insertId;

      /* 6️⃣ Store Snapshot */
      await connection.query(
        `
        INSERT INTO rc_snapshots
        (agreement_id, snapshot_data, hash)
        VALUES (?, ?, ?)
        `,
        [
          agreementId,
          JSON.stringify(snapshot),
          snapshotHash
        ]
      );

      /* 7️⃣ Update signed_amount */
      await connection.query(
        `
        UPDATE rc_rounds
        SET signed_amount = ?
        WHERE id = ?
        `,
        [newSignedAmount, roundId]
      );

      await connection.commit();

      res.status(201).json({
        message: "RC agreement created",
        agreementId,
        rcId,
        snapshotHash
      });

    } catch (err) {
      await connection.rollback();
      console.error("RC Agreement creation failed:", err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);

/* =====================================================
   GET AGREEMENT (Investor or Startup)
===================================================== */

router.get("/:id", auth, async (req, res) => {
  try {
    const agreementId = req.params.id;
    const userId = req.user.id;
    const role = req.user.role;

    const [rows] = await pool.query(
      `
      SELECT a.*, r.startup_id, r.name AS round_name
      FROM rc_agreements a
      JOIN rc_rounds r ON a.round_id = r.id
      WHERE a.id = ?
      `,
      [agreementId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    const agreement = rows[0];

    if (
      (role === "investor" && agreement.investor_id !== userId) ||
      (role === "startup" && agreement.startup_id !== userId)
    ) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(agreement);

  } catch (err) {
    console.error("Get agreement error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =====================================================
   SIGN AGREEMENT (Investor or Startup)
===================================================== */

router.post(
  "/:id/sign",
  auth,
  async (req, res) => {

    const connection = await pool.getConnection();

    try {
      const agreementId = req.params.id;
      const userId = req.user.id;
      const role = req.user.role;

      await connection.beginTransaction();

      // Lock agreement
      const [rows] = await connection.query(
        `
        SELECT a.*, r.startup_id
        FROM rc_agreements a
        JOIN rc_rounds r ON a.round_id = r.id
        WHERE a.id = ?
        FOR UPDATE
        `,
        [agreementId]
      );

      if (rows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Agreement not found" });
      }

      const agreement = rows[0];

      // Access control
      if (
        (role === "investor" && agreement.investor_id !== userId) ||
        (role === "startup" && agreement.startup_id !== userId)
      ) {
        await connection.rollback();
        return res.status(403).json({ error: "Access denied" });
      }

      if (agreement.status === "Active RC") {
        await connection.rollback();
        return res.status(400).json({ error: "Agreement already active" });
      }

      // Record signature
      if (role === "investor") {
        await connection.query(
          "UPDATE rc_agreements SET investor_signed_at = NOW() WHERE id=?",
          [agreementId]
        );
      }

      if (role === "startup") {
        await connection.query(
          "UPDATE rc_agreements SET startup_signed_at = NOW() WHERE id=?",
          [agreementId]
        );
      }

      // Reload signature state
      const [updatedRows] = await connection.query(
        `
        SELECT investor_signed_at, startup_signed_at
        FROM rc_agreements
        WHERE id=?
        `,
        [agreementId]
      );

      const updated = updatedRows[0];

      // If both signed → move to Awaiting Payment
      if (updated.investor_signed_at && updated.startup_signed_at) {
        await connection.query(
          `
          UPDATE rc_agreements
          SET status='Awaiting Payment'
          WHERE id=?
          `,
          [agreementId]
        );
      } else {
        // If only one signed → Pending Signatures
        await connection.query(
          `
          UPDATE rc_agreements
          SET status='Pending Signatures'
          WHERE id=?
          `,
          [agreementId]
        );
      }

      await connection.commit();

      res.json({
        message: "Signature recorded",
        investorSigned: !!updated.investor_signed_at,
        startupSigned: !!updated.startup_signed_at,
        newStatus:
          updated.investor_signed_at && updated.startup_signed_at
            ? "Awaiting Payment"
            : "Pending Signatures"
      });

    } catch (err) {
      await connection.rollback();
      console.error("Signing failed:", err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);

/* CONFIRM PAYMENT */
router.post("/:id/confirm", auth, async (req, res) => {
  try {

    const agreementId = req.params.id;
    const userId = req.user.id;

    const [rows] = await pool.query(
      `
      SELECT *
      FROM rc_agreements
      WHERE id=? AND startup_id=?
      `,
      [agreementId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: "Agreement not found"
      });
    }

    const agreement = rows[0];

    if (agreement.status !== "Awaiting Payment") {
      return res.status(400).json({
        error: "Agreement not ready for activation"
      });
    }

    await pool.query(
      `
      UPDATE rc_agreements
      SET
        status='Active RC',
        activated_at=NOW(),
        payment_confirmed_by_startup_at=NOW()
      WHERE id=?
      `,
      [agreementId]
    );

    res.json({
      success: true,
      newStatus: "Active RC"
    });

  } catch (err) {
    console.error("Confirm payment failed:", err);
    res.status(500).json({
      error: "Internal server error"
    });
  }
});

  /* =====================================================
   GET MY AGREEMENTS (Investor)
===================================================== */

router.get(
    "/my/list",
    auth,
    requireRole(["investor"]),
    async (req, res) => {
      try {
        const investorId = req.user.id;
  
        const [rows] = await pool.query(
          `
          SELECT 
            a.id,
            a.rc_id,
            a.investment_amount,
            a.status,
            a.created_at,
            r.name AS round_name
          FROM rc_agreements a
          JOIN rc_rounds r ON a.round_id = r.id
          WHERE a.investor_id = ?
          ORDER BY a.created_at DESC
          `,
          [investorId]
        );
  
        res.json(rows);
  
      } catch (err) {
        console.error("Get my agreements failed:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );


export default router;