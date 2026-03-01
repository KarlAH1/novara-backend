import pool from "../config/db.js";
export const startEmission = async (req, res) => {
    try {
  
      const startup_id = req.user.id;
  
      /* =========================
         VERIFY LEGAL SIGNED
      ========================= */
  
      const [board] = await pool.query(`
        SELECT id
        FROM documents
        WHERE startup_id=? AND type='BOARD' AND status='LOCKED'
        ORDER BY id DESC LIMIT 1
      `, [startup_id]);
  
      const [gf] = await pool.query(`
        SELECT id
        FROM documents
        WHERE startup_id=? AND type='GF' AND status='LOCKED'
        ORDER BY id DESC LIMIT 1
      `, [startup_id]);
  
      if (!board.length || !gf.length) {
        return res.status(403).json({
          message: "Board and GF must be signed"
        });
      }
  
      /* =========================
         GET APPROVED AMOUNT
      ========================= */
  
      const [capitalRows] = await pool.query(`
        SELECT approved_amount
        FROM capital_decisions
        WHERE startup_id=?
        ORDER BY id DESC
        LIMIT 1
      `, [startup_id]);
  
      if (!capitalRows.length) {
        return res.status(400).json({
          message: "No approved capital decision found"
        });
      }
  
      const approvedAmount = capitalRows[0].approved_amount;
  
      /* =========================
         PREVENT DUPLICATE ROUND
      ========================= */
  
      const [existing] = await pool.query(`
        SELECT id FROM emission_rounds
        WHERE startup_id=? AND open=1
      `, [startup_id]);
  
      if (existing.length > 0) {
        return res.status(400).json({
          message: "Emission already active"
        });
      }
  
      /* =========================
         CREATE EMISSION ROUND
      ========================= */
  
      const deadline = new Date();
      deadline.setFullYear(deadline.getFullYear() + 3);
  
      const [result] = await pool.query(`
        INSERT INTO emission_rounds
        (startup_id, target_amount, deadline, open)
        VALUES (?, ?, ?, 0)
      `, [startup_id, approvedAmount, deadline]);
  
      res.json({
        emissionId: result.insertId
      });
  
    } catch (err) {
      console.error("START EMISSION ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  };

/* =====================================================
   GET EMISSION BY ID
===================================================== */
export const getEmissionById = async (req, res) => {
    try {

        const { emissionId } = req.params;
        const userId = req.user.id;

        const [rows] = await pool.query(`
            SELECT *
            FROM emission_rounds
            WHERE id=?
        `, [emissionId]);

        if (!rows.length) {
            return res.status(404).json({
                message: "Emission not found"
            });
        }

        const emission = rows[0];

        // Access control (startup owner OR investor)
        if (
            req.user.role === "startup" &&
            emission.startup_id !== userId
        ) {
            return res.status(403).json({
                message: "Access denied"
            });
        }

        res.json(emission);

    } catch (err) {
        console.error("GET EMISSION ERROR:", err);
        res.status(500).json({
            message: "Server error"
        });
    }
};

/* =====================================================
   UPDATE EMISSION CONFIG (DRAFT ONLY)
===================================================== */
export const updateEmissionConfig = async (req, res) => {
    try {
  
      const emissionId = req.params.id;
      const startupId = req.user.id;
  
      const {
        conversion_years,
        discount_rate,
        valuation_cap,
        bank_account
      } = req.body;
  
      // Sjekk at emission tilhører startup
      const [rows] = await pool.query(`
        SELECT id, startup_id
        FROM emission_rounds
        WHERE id = ?
      `, [emissionId]);
  
      if (!rows.length) {
        return res.status(404).json({
          message: "Emission not found"
        });
      }
  
      if (rows[0].startup_id !== startupId) {
        return res.status(403).json({
          message: "Access denied"
        });
      }
  
      // Lås config hvis det finnes investeringer
      const [investments] = await pool.query(`
        SELECT id
        FROM rc_agreements
        WHERE round_id = ?
        LIMIT 1
      `, [emissionId]);
  
      if (investments.length > 0) {
        return res.status(400).json({
          message: "Configuration locked after first investment"
        });
      }
  
      // Oppdater vilkår
      await pool.query(`
        UPDATE emission_rounds
        SET
          conversion_years = ?,
          discount_rate = ?,
          valuation_cap = ?,
          bank_account = ?
        WHERE id = ?
      `, [
        conversion_years,
        discount_rate,
        valuation_cap,
        bank_account,
        emissionId
      ]);
  
      res.json({ success: true });
  
    } catch (err) {
      console.error("Update config error:", err);
      res.status(500).json({ message: "Server error" });
    }
  };


/* =====================================================
   ACTIVATE EMISSION
===================================================== */
export const activateEmission = async (req, res) => {
    try {

        const { emissionId } = req.params;
        const startupId = req.user.id;

        const [rows] = await pool.query(`
            SELECT * FROM emission_rounds
            WHERE id=? AND startup_id=?
        `, [emissionId, startupId]);

        if (!rows.length) {
            return res.status(404).json({ message: "Emission not found" });
        }

        await pool.query(`
            UPDATE emission_rounds
            SET open = 0
            WHERE id = ? AND startup_id = ?
        `, [emissionId, startupId]);

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
};

export const getActiveEmission = async (req, res) => {
    try {

        const { startupId } = req.params;

        const [rows] = await pool.query(`
            SELECT *
            FROM emission_rounds
            WHERE startup_id=?
            AND status='OPEN'
            ORDER BY id DESC
            LIMIT 1
        `, [startupId]);

        if (!rows.length) {
            return res.json(null);
        }

        res.json(rows[0]);

    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
};

/* =====================================================
   GENERATE INVITE
===================================================== */
export const generateInvite = async (req, res) => {
    try {

        const { emissionId } = req.params;
        const startupId = req.user.id;

        const [rows] = await pool.query(`
            SELECT id FROM emission_rounds
            WHERE id=? AND startup_id=? AND status='OPEN'
        `, [emissionId, startupId]);

        if (!rows.length) {
            return res.status(403).json({
                message: "Emission not open"
            });
        }

        const crypto = await import("crypto");
        const token = crypto.randomUUID();

        await pool.query(`
            INSERT INTO emission_invites
            (emission_id, token, created_by)
            VALUES (?, ?, ?)
        `, [emissionId, token, startupId]);

        res.json({
            inviteLink: `${process.env.FRONTEND_URL}/invite.html?token=${token}`
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};


/* =====================================================
   INVEST
===================================================== */
export const investInEmission = async (req, res) => {
    try {

        const { emissionId } = req.params;
        const { amount } = req.body;
        const investorId = req.user.id;

        if (!amount) {
            return res.status(400).json({
                message: "Amount required"
            });
        }

        await pool.query(`
            INSERT INTO emission_investments
            (emission_id, investor_id, amount)
            VALUES (?, ?, ?)
        `, [emissionId, investorId, amount]);

        await pool.query(`
            UPDATE emission_rounds
            SET amount_raised = amount_raised + ?
            WHERE id=?
        `, [amount, emissionId]);

        res.json({ success: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};

