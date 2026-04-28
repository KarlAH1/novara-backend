import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =========================================================
   INVESTOR INITIATES PAYMENT
========================================================= */

router.post(
  "/initiate/:agreementId",
  auth,
  requireRole(["investor"]),
  async (req, res) => {

    const connection = await pool.getConnection();

    try {
      const agreementId = req.params.agreementId;
      const investorId = req.user.id;

      await connection.beginTransaction();

      /* 1️⃣ Lock agreement */
      const [rows] = await connection.query(
        "SELECT * FROM rc_agreements WHERE id=? FOR UPDATE",
        [agreementId]
      );

      if (rows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Agreement not found" });
      }

      const agreement = rows[0];

      if (agreement.investor_id !== investorId) {
        await connection.rollback();
        return res.status(403).json({ error: "Not your agreement" });
      }

      if (agreement.status !== "Signed" &&
          agreement.status !== "Awaiting Payment") {
        await connection.rollback();
        return res.status(400).json({
          error: "Payment cannot be initiated at this stage"
        });
      }

      /* 2️⃣ Update agreement status */
      await connection.query(
        `
        UPDATE rc_agreements
        SET status = 'Payment Initiated'
        WHERE id = ?
        `,
        [agreementId]
      );

      /* 3️⃣ Create or update payment record */
      const [existingPayment] = await connection.query(
        "SELECT id FROM rc_payments WHERE agreement_id=?",
        [agreementId]
      );

      if (existingPayment.length === 0) {

        await connection.query(
          `
          INSERT INTO rc_payments
          (agreement_id, amount, status, initiated_at)
          VALUES (?, ?, 'Payment Initiated', NOW())
          `,
          [
            agreementId,
            agreement.investment_amount
          ]
        );

      } else {

        await connection.query(
          `
          UPDATE rc_payments
          SET status = 'Payment Initiated',
              initiated_at = NOW()
          WHERE agreement_id = ?
          `,
          [agreementId]
        );

      }

      await connection.commit();

      res.json({ message: "Payment initiated successfully" });

    } catch (err) {
      await connection.rollback();
      console.error("Payment initiation failed:", err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);

/* =========================================================
   STARTUP CONFIRMS PAYMENT
========================================================= */

router.post(
  "/confirm/:agreementId",
  auth,
  requireRole(["startup"]),
  async (req, res) => {

    const connection = await pool.getConnection();

    try {
      const agreementId = req.params.agreementId;
      const startupId = req.user.id;

      await connection.beginTransaction();

      /* 1️⃣ Lock agreement + round */
      const [agreementRows] = await connection.query(
        `
        SELECT a.*, r.startup_id, r.funded_amount, r.rc_pool_amount
        FROM rc_agreements a
        JOIN rc_rounds r ON a.round_id = r.id
        WHERE a.id=? FOR UPDATE
        `,
        [agreementId]
      );

      if (agreementRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Agreement not found" });
      }

      const agreement = agreementRows[0];

      if (agreement.startup_id !== startupId) {
        await connection.rollback();
        return res.status(403).json({ error: "Not your round" });
      }

      if (agreement.status !== "Payment Initiated") {
        await connection.rollback();
        return res.status(400).json({
          error: "Payment must be initiated first"
        });
      }

      /* 2️⃣ Prevent overfunding */
      const newFundedAmount =
        Number(agreement.funded_amount) +
        Number(agreement.investment_amount);

      if (newFundedAmount > Number(agreement.rc_pool_amount)) {
        await connection.rollback();
        return res.status(400).json({
          error: "Funding exceeds round capacity"
        });
      }

      /* 3️⃣ Update agreement */
      await connection.query(
        `
        UPDATE rc_agreements
        SET status = 'Active RC',
            activated_at = NOW()
        WHERE id = ?
        `,
        [agreementId]
      );

      /* 4️⃣ Update round funded_amount */
      await connection.query(
        `
        UPDATE rc_rounds
        SET funded_amount = ?
        WHERE id = ?
        `,
        [newFundedAmount, agreement.round_id]
      );

      /* 5️⃣ Update payment record */
      await connection.query(
        `
        UPDATE rc_payments
        SET status = 'Payment Confirmed',
            confirmed_at = NOW()
        WHERE agreement_id = ?
        `,
        [agreementId]
      );

      await connection.commit();

      res.json({ message: "Payment confirmed. RC is now active." });

    } catch (err) {
      await connection.rollback();
      console.error("Payment confirmation failed:", err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);

export default router;