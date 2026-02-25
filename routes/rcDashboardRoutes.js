import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =====================================================
   GET DASHBOARD DATA (Investor or Startup)
===================================================== */

router.get("/:agreementId", auth, async (req, res) => {
  try {
    const agreementId = req.params.agreementId;
    const userId = req.user.id;
    const role = req.user.role;

    const [rows] = await pool.query(
      `
      SELECT 
        a.*,
        r.name AS round_name,
        r.rc_pool_amount,
        r.rc_pool_percent,
        r.funded_amount,
        r.signed_amount,
        r.maturation_date,
        r.optional_conversion,
        r.trigger_amount,
        r.startup_id,
        p.status AS payment_status,
        p.initiated_at,
        p.confirmed_at
      FROM rc_agreements a
      JOIN rc_rounds r ON a.round_id = r.id
      LEFT JOIN rc_payments p ON p.agreement_id = a.id
      WHERE a.id = ?
      `,
      [agreementId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    const data = rows[0];

    // Access control
    if (
      (role === "investor" && data.investor_id !== userId) ||
      (role === "startup" && data.startup_id !== userId)
    ) {
      return res.status(403).json({ error: "Access denied" });
    }

    const progress =
      data.rc_pool_amount > 0
        ? Math.round((data.funded_amount / data.rc_pool_amount) * 100)
        : 0;

    const remaining =
      Number(data.rc_pool_amount) - Number(data.funded_amount);

    res.json({
      userRole: role,
      agreement: {
        id: data.id,
        rcId: data.rc_id,
        investmentAmount: data.investment_amount,
        status: data.status,
        snapshotHash: data.snapshot_hash,
        signedAt: data.signed_at,
        activatedAt: data.activated_at
      },
      round: {
        id: data.round_id,
        name: data.round_name,
        poolAmount: data.rc_pool_amount,
        poolPercent: data.rc_pool_percent,
        fundedAmount: data.funded_amount,
        signedAmount: data.signed_amount,
        remainingCapacity: remaining,
        maturationDate: data.maturation_date,
        optionalConversion: data.optional_conversion,
        triggerAmount: data.trigger_amount
      },
      payment: {
        status: data.payment_status || "Awaiting Payment",
        initiatedAt: data.initiated_at,
        confirmedAt: data.confirmed_at
      },
      progress
    });

  } catch (err) {
    console.error("Dashboard fetch failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;