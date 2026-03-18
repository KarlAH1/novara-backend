import pool from "../config/db.js";
import { canStartupCreateRaise } from "../utils/startupPlanAccess.js";
const MAX_EMISSION_AMOUNT = 2147483647;

const emissionShareholderTableName = "emission_shareholders";

const hasEmissionShareholderTable = async () => {
  const [rows] = await pool.query("SHOW TABLES LIKE ?", [emissionShareholderTableName]);
  return rows.length > 0;
};

const getEmissionShareholders = async (emissionId) => {
  if (!(await hasEmissionShareholderTable())) {
    return [];
  }

  const [rows] = await pool.query(
    `
    SELECT id, shareholder_name, ownership_percent
    FROM emission_shareholders
    WHERE emission_id = ?
    ORDER BY id ASC
    `,
    [emissionId]
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.shareholder_name,
    ownership_percent: Number(row.ownership_percent)
  }));
};

const normalizeShareholders = (rawShareholders) => {
  if (!Array.isArray(rawShareholders)) {
    return [];
  }

  return rawShareholders
    .map((item) => ({
      name: String(item?.name || "").trim(),
      ownership_percent: Number(item?.ownership_percent)
    }))
    .filter((item) => item.name && Number.isFinite(item.ownership_percent) && item.ownership_percent > 0);
};
export const startEmission = async (req, res) => {
    try {
  
      const startup_id = req.user.id;

      if (!(await canStartupCreateRaise(startup_id))) {
        return res.status(403).json({
          message: "Du må ha en aktiv startup-plan for å opprette emisjonen."
        });
      }
  
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
        SELECT id, approved_amount
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
  
      let approvedAmount = Number(capitalRows[0].approved_amount);

      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        const [legalRows] = await pool.query(`
          SELECT amount
          FROM startup_legal_data
          WHERE startup_id=?
          ORDER BY created_at DESC
          LIMIT 1
        `, [startup_id]);

        approvedAmount = Number(legalRows[0]?.amount);

        if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
          return res.status(400).json({
            message: "Approved amount is invalid. Regenerate and re-sign Board/GF."
          });
        }

        await pool.query(`
          UPDATE capital_decisions
          SET approved_amount=?
          WHERE id=?
        `, [approvedAmount, capitalRows[0].id]);
      }

      if (approvedAmount > MAX_EMISSION_AMOUNT) {
        return res.status(400).json({
          message: `Approved amount is too large (${approvedAmount.toLocaleString("no-NO")} NOK). Update the legal amount and regenerate Board/GF.`
        });
      }
  
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

        const emissionId  = req.params.id;
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

        const shareholders = await getEmissionShareholders(emissionId);

        res.json({
            ...emission,
            shareholders
        });

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
  
      let {
        conversion_years,
        discount_rate,
        valuation_cap,
        bank_account,
        shareholders
      } = req.body;

       //  tom streng → null
       if (valuation_cap === "" || valuation_cap === undefined) {
        valuation_cap = null;
      }
  
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

      const normalizedShareholders = normalizeShareholders(shareholders);

      if (await hasEmissionShareholderTable()) {
        const totalOwnership = normalizedShareholders.reduce(
          (sum, item) => sum + Number(item.ownership_percent || 0),
          0
        );

        if (totalOwnership > 100.0001) {
          return res.status(400).json({
            message: "Eierandelene kan ikke overstige 100% totalt"
          });
        }

        await pool.query(
          "DELETE FROM emission_shareholders WHERE emission_id = ?",
          [emissionId]
        );

        for (const shareholder of normalizedShareholders) {
          await pool.query(
            `
            INSERT INTO emission_shareholders
            (emission_id, shareholder_name, ownership_percent)
            VALUES (?, ?, ?)
            `,
            [emissionId, shareholder.name, shareholder.ownership_percent]
          );
        }
      }
  
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

      const emissionId = req.params.id;
      const startupId = req.user.id;

      console.log("ACTIVATE PARAMS:", req.params);
      console.log("ACTIVATE USER:", startupId);
      console.log("Checking DB for:", emissionId, startupId);

      const [rows] = await pool.query(
          `
          SELECT * FROM emission_rounds
          WHERE id = ? AND startup_id = ?
          `,
          [emissionId, startupId]
      );

      console.log("Rows found:", rows.length);

      if (!rows.length) {
          return res.status(404).json({ message: "Emission not found" });
      }

      await pool.query(
          `
          UPDATE emission_rounds
          SET open = 1
          WHERE id = ? AND startup_id = ?
          `,
          [emissionId, startupId]
      );

      res.json({ success: true });

  } catch (err) {
      console.error("Activate error:", err);
      res.status(500).json({ message: "Server error" });
  }
};

export const getActiveEmission = async (req, res) => {
  try {

      const startupId = req.user.id;

      const [rows] = await pool.query(`
          SELECT *
          FROM emission_rounds
          WHERE startup_id = ?
          ORDER BY id DESC
          LIMIT 1
      `, [startupId]);

      if (!rows.length) {
          return res.json(null);
      }

      res.json(rows[0]);

  } catch (err) {
      console.error("GET ACTIVE EMISSION ERROR:", err);
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

export const deleteEmissionByStartup = async (req, res) => {
  const connection = await pool.getConnection();
  let transactionStarted = false;

  try {
    const emissionId = Number(req.params.id);
    const startupId = req.user.id;

    const [emissionRows] = await connection.query(
      `
      SELECT id, startup_id
      FROM emission_rounds
      WHERE id = ?
      LIMIT 1
      `,
      [emissionId]
    );

    if (!emissionRows.length) {
      return res.status(404).json({ message: "Emission not found" });
    }

    if (Number(emissionRows[0].startup_id) !== Number(startupId)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const [agreementRows] = await connection.query(
      `
      SELECT id
      FROM rc_agreements
      WHERE round_id = ?
      LIMIT 1
      `,
      [emissionId]
    );

    if (agreementRows.length > 0) {
      return res.status(400).json({
        message: "Emisjonen kan ikke slettes etter at investoravtaler er opprettet"
      });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    await connection.query("DELETE FROM emission_invites WHERE emission_id = ?", [emissionId]);
    await connection.query("DELETE FROM rc_invites WHERE round_id = ?", [emissionId]);

    if (await hasEmissionShareholderTable()) {
      await connection.query("DELETE FROM emission_shareholders WHERE emission_id = ?", [emissionId]);
    }

    await connection.query(
      `
      UPDATE documents
      SET status = 'ARCHIVED'
      WHERE startup_id = ?
        AND type IN ('BOARD', 'GF')
        AND status IN ('DRAFT', 'SIGNED', 'LOCKED')
      `,
      [startupId]
    );

    await connection.query("DELETE FROM admin_issues WHERE emission_id = ?", [emissionId]);
    await connection.query("DELETE FROM emission_rounds WHERE id = ? AND startup_id = ?", [emissionId, startupId]);

    await connection.commit();

    res.json({ success: true, message: "Emisjon slettet" });
  } catch (err) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("Delete emission error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    connection.release();
  }
};

export const reportEmissionIssue = async (req, res) => {
  try {
    const emissionId = Number(req.params.id);
    const startupId = req.user.id;
    const message = String(req.body.message || "").trim();
    const issueType = String(req.body.issueType || "general").trim().slice(0, 64) || "general";

    if (!message) {
      return res.status(400).json({ message: "Beskrivelse av problemet mangler" });
    }

    const [emissionRows] = await pool.query(
      `
      SELECT id, startup_id
      FROM emission_rounds
      WHERE id = ?
      LIMIT 1
      `,
      [emissionId]
    );

    if (!emissionRows.length) {
      return res.status(404).json({ message: "Emission not found" });
    }

    if (Number(emissionRows[0].startup_id) !== Number(startupId)) {
      return res.status(403).json({ message: "Access denied" });
    }

    await pool.query(
      `
      INSERT INTO admin_issues (user_id, startup_id, emission_id, source, issue_type, message, status)
      VALUES (?, ?, ?, 'dashboard', ?, ?, 'OPEN')
      `,
      [req.user.id, startupId, emissionId, issueType, message]
    );

    res.status(201).json({
      success: true,
      message: "Varsel sendt til Raisium"
    });
  } catch (err) {
    console.error("Report emission issue error:", err);
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
