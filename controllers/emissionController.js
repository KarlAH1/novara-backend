import pool from "../config/db.js";
import { canStartupCreateRaise } from "../utils/startupPlanAccess.js";
import { cleanupLegalDocuments } from "../utils/legalDocumentCleanup.js";
import {
  isUserInSameCompany,
  resolveCompanyStartupOwner
} from "../utils/startupContext.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import { sendRoundActivatedEmail } from "../utils/notificationEmailFlow.js";
import { getLegalResetCutoff } from "../utils/legalRoundReset.js";
const MAX_EMISSION_AMOUNT = 2147483647;

const emissionShareholderTableName = "emission_shareholders";
const emissionInviteTableName = "emission_invites";

const hasEmissionShareholderTable = async () => {
  const [rows] = await pool.query("SHOW TABLES LIKE ?", [emissionShareholderTableName]);
  return rows.length > 0;
};

const hasEmissionInviteTable = async () => {
  const [rows] = await pool.query("SHOW TABLES LIKE ?", [emissionInviteTableName]);
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
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startup_id = startupContext.startupUserId;
      const legalResetCutoff = await getLegalResetCutoff(pool, startup_id);

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
          AND (? IS NULL OR created_at > ?)
        ORDER BY id DESC LIMIT 1
      `, [startup_id, legalResetCutoff, legalResetCutoff]);
  
      const [gf] = await pool.query(`
        SELECT id
        FROM documents
        WHERE startup_id=? AND type='GF' AND status='LOCKED'
          AND (? IS NULL OR created_at > ?)
        ORDER BY id DESC LIMIT 1
      `, [startup_id, legalResetCutoff, legalResetCutoff]);
  
      if (!board.length || !gf.length) {
        return res.status(403).json({
          message: "Board and GF must be signed"
        });
      }
  
      /* =========================
         GET APPROVED AMOUNT
      ========================= */
  
      const [capitalRows] = await pool.query(`
        SELECT id, approved_amount, created_at
        FROM capital_decisions
        WHERE startup_id=?
          AND (? IS NULL OR created_at > ?)
        ORDER BY id DESC
        LIMIT 1
      `, [startup_id, legalResetCutoff, legalResetCutoff]);
  
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
            AND (? IS NULL OR created_at > ?)
          ORDER BY created_at DESC
          LIMIT 1
        `, [startup_id, legalResetCutoff, legalResetCutoff]);

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

      const [latestRounds] = await pool.query(`
        SELECT id, closed_reason
        FROM emission_rounds
        WHERE startup_id=?
        ORDER BY id DESC
        LIMIT 1
      `, [startup_id]);

      const latestClosedReason = String(latestRounds[0]?.closed_reason || "");
      if (latestClosedReason && latestClosedReason !== "conversion_downloaded") {
        return res.status(400).json({
          message: "Forrige runde må ferdigstilles før ny runde kan opprettes.",
          emissionId: latestRounds[0].id
        });
      }
  
      const [existing] = await pool.query(`
        SELECT
          e.id,
          e.open,
          e.closed_reason,
          e.created_at,
          COUNT(a.id) AS agreement_count
        FROM emission_rounds e
        LEFT JOIN rc_agreements a ON a.round_id = e.id
        WHERE e.startup_id=?
          AND (e.closed_reason IS NULL OR e.closed_reason = '')
        GROUP BY e.id, e.open, e.closed_reason, e.created_at
        ORDER BY e.id DESC
        LIMIT 1
      `, [startup_id]);
  
      if (existing.length > 0) {
        const existingRound = existing[0];
        const existingCreatedAt = existingRound.created_at ? new Date(existingRound.created_at) : null;
        const decisionCreatedAt = capitalRows[0]?.created_at ? new Date(capitalRows[0].created_at) : null;
        const hasFresherDecision =
          existingCreatedAt &&
          decisionCreatedAt &&
          Number.isFinite(existingCreatedAt.getTime()) &&
          Number.isFinite(decisionCreatedAt.getTime()) &&
          decisionCreatedAt > existingCreatedAt;

        if (Number(existingRound.open || 0) === 0 && Number(existingRound.agreement_count || 0) === 0 && hasFresherDecision) {
          await pool.query(
            "DELETE FROM emission_rounds WHERE id = ? AND startup_id = ? AND open = 0",
            [existingRound.id, startup_id]
          );
        } else {
          return res.status(400).json({
            message: "Startupen har allerede en runde. Fullfør eller lukk eksisterende runde før ny opprettes.",
            emissionId: existingRound.id
          });
        }
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
        if (req.user.role === "startup") {
            const hasStartupAccess = await isUserInSameCompany(pool, userId, emission.startup_id);
            if (!hasStartupAccess) {
                return res.status(403).json({
                    message: "Access denied"
                });
            }
        }

        const shareholders = await getEmissionShareholders(emissionId);

      let emissionWithAvailability = null;
      try {
        emissionWithAvailability = await syncEmissionRoundAvailability(pool, emissionId);
      } catch (availabilityError) {
        console.error("Emission availability sync error:", availabilityError);
      }

      res.json({
        ...(emissionWithAvailability || emission),
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
   GET PREVIOUS EMISSIONS FOR STARTUP
===================================================== */
export const getPreviousEmissions = async (req, res) => {
    try {
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;

        const [rounds] = await pool.query(`
            SELECT
                e.id,
                e.startup_id,
                e.target_amount,
                e.amount_raised,
                e.committed_amount,
                e.discount_rate,
                e.valuation_cap,
                e.conversion_years,
                e.trigger_period,
                e.deadline,
                e.open,
                e.status,
                e.closed_at,
                e.closed_reason,
                e.created_at,
                (
                    SELECT COUNT(*)
                    FROM rc_agreements a
                    WHERE a.round_id = e.id
                ) AS agreement_count,
                (
                    SELECT COUNT(*)
                    FROM rc_agreements a
                    WHERE a.round_id = e.id AND a.status = 'Active RC'
                ) AS active_agreement_count,
                (
                    SELECT COALESCE(SUM(a.investment_amount), 0)
                    FROM rc_agreements a
                    WHERE a.round_id = e.id
                ) AS total_investment_amount
            FROM emission_rounds e
            WHERE e.startup_id = ?
              AND (
                (e.closed_reason IS NOT NULL AND e.closed_reason <> '')
                OR e.closed_at IS NOT NULL
                OR (
                    e.open = 0
                    AND EXISTS (
                        SELECT 1
                        FROM rc_agreements historic_a
                        WHERE historic_a.round_id = e.id
                    )
                )
              )
            ORDER BY COALESCE(e.closed_at, e.created_at) DESC, e.id DESC
        `, [startupId]);

        if (!rounds.length) {
            return res.json({ rounds: [] });
        }

        const roundIds = rounds.map((round) => round.id);
        const placeholders = roundIds.map(() => "?").join(",");
        const [agreements] = await pool.query(`
            SELECT
                a.id,
                a.rc_id,
                a.round_id,
                a.investor_id,
                a.investment_amount,
                a.status,
                a.investor_signed_at,
                a.startup_signed_at,
                a.activated_at,
                a.payment_confirmed_by_startup_at,
                a.created_at,
                investor.name AS investor_name,
                investor.email AS investor_email
            FROM rc_agreements a
            LEFT JOIN users investor ON investor.id = a.investor_id
            WHERE a.round_id IN (${placeholders})
            ORDER BY a.created_at DESC, a.id DESC
        `, roundIds);

        const agreementsByRound = new Map();
        agreements.forEach((agreement) => {
            const current = agreementsByRound.get(agreement.round_id) || [];
            current.push(agreement);
            agreementsByRound.set(agreement.round_id, current);
        });

        res.json({
            rounds: rounds.map((round) => ({
                ...round,
                agreement_count: Number(round.agreement_count || 0),
                active_agreement_count: Number(round.active_agreement_count || 0),
                total_investment_amount: Number(round.total_investment_amount || 0),
                agreements: agreementsByRound.get(round.id) || []
            }))
        });
    } catch (err) {
        console.error("GET PREVIOUS EMISSIONS ERROR:", err);
        res.status(500).json({ message: "Server error" });
    }
};

/* =====================================================
   UPDATE EMISSION CONFIG (DRAFT ONLY)
===================================================== */
export const updateEmissionConfig = async (req, res) => {
    try {
  
      const emissionId = req.params.id;
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupId = startupContext.startupUserId;
  
      let {
        conversion_years,
        trigger_period,
        discount_rate,
        valuation_cap,
        bank_account,
        shareholders
      } = req.body;

      const normalizedTriggerPeriod = Number(trigger_period || conversion_years || 0) || null;
      conversion_years = normalizedTriggerPeriod;
      discount_rate = discount_rate === "" || discount_rate == null ? 0 : Number(discount_rate);
      valuation_cap = valuation_cap === "" || valuation_cap === undefined ? null : Number(valuation_cap);
      bank_account = String(bank_account || "").trim();

       if (!Number.isFinite(normalizedTriggerPeriod) || normalizedTriggerPeriod <= 0) {
        return res.status(400).json({
          message: "Triggerperiode må være satt."
        });
      }

      if (!Number.isFinite(valuation_cap) || valuation_cap <= 0) {
        return res.status(400).json({
          message: "Valuation cap må være satt."
        });
      }

      if (!bank_account) {
        return res.status(400).json({
          message: "Kontonummer må være satt."
        });
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
  
      if (!(await isUserInSameCompany(pool, req.user.id, rows[0].startup_id))) {
        return res.status(403).json({
          message: "Access denied"
        });
      }

      const deadlineBaseDate = rows[0].created_at ? new Date(rows[0].created_at) : new Date();
      if (Number.isNaN(deadlineBaseDate.getTime())) {
        return res.status(400).json({
          message: "Kunne ikke beregne oppfølgingsdato."
        });
      }
      deadlineBaseDate.setFullYear(deadlineBaseDate.getFullYear() + normalizedTriggerPeriod);
  
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
          trigger_period = ?,
          deadline = ?,
          discount_rate = ?,
          valuation_cap = ?,
          bank_account = ?
        WHERE id = ?
      `, [
        conversion_years,
        normalizedTriggerPeriod,
        deadlineBaseDate,
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
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupId = startupContext.startupUserId;

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

      await sendRoundActivatedEmail({
        startupEmail: req.user.email,
        startupName: startupContext.company?.company_name || req.user.name || "",
        roundId: emissionId
      });

      res.json({ success: true });

  } catch (err) {
      console.error("Activate error:", err);
      res.status(500).json({ message: "Server error" });
  }
};

export const getActiveEmission = async (req, res) => {
  try {

      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupId = startupContext.startupUserId;

      const [rows] = await pool.query(`
          SELECT *
          FROM emission_rounds
          WHERE startup_id = ?
            AND open = 1
            AND (closed_reason IS NULL OR closed_reason = '')
          ORDER BY id DESC
          LIMIT 1
      `, [startupId]);

      if (!rows.length) {
          return res.json(null);
      }

      let emission = null;
      try {
        emission = await syncEmissionRoundAvailability(pool, rows[0].id);
      } catch (availabilityError) {
        console.error("Active emission availability sync error:", availabilityError);
      }

      res.json(emission || rows[0]);

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
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;

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
    const startupContext = await resolveCompanyStartupOwner(connection, req.user.id);
    const startupId = startupContext.startupUserId;

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

    if (!(await isUserInSameCompany(connection, req.user.id, emissionRows[0].startup_id))) {
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

    const inviteTableExists = await hasEmissionInviteTable();
    if (inviteTableExists) {
      await connection.query("DELETE FROM emission_invites WHERE emission_id = ?", [emissionId]);
    }
    await connection.query("DELETE FROM rc_invites WHERE round_id = ?", [emissionId]);

    if (await hasEmissionShareholderTable()) {
      await connection.query("DELETE FROM emission_shareholders WHERE emission_id = ?", [emissionId]);
    }

    await cleanupLegalDocuments(connection, emissionRows[0].startup_id, ["BOARD", "GF"]);

    await connection.query("DELETE FROM admin_issues WHERE emission_id = ?", [emissionId]);
    await connection.query("DELETE FROM emission_rounds WHERE id = ? AND startup_id = ?", [emissionId, emissionRows[0].startup_id]);

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
    const userId = req.user.id;
    const userRole = String(req.user.role || "");
    const message = String(req.body.message || "").trim();
    const issueType = String(req.body.issueType || "general").trim().slice(0, 64) || "general";
    const source = String(req.body.source || "dashboard").trim().slice(0, 64) || "dashboard";

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

    const startupId = Number(emissionRows[0].startup_id);
    let hasAccess = false;

    if (userRole === "startup" && await isUserInSameCompany(pool, userId, startupId)) {
      hasAccess = true;
    }

    if (!hasAccess && userRole === "investor") {
      const [agreementRows] = await pool.query(
        `
        SELECT id
        FROM rc_agreements
        WHERE round_id = ? AND investor_id = ?
        LIMIT 1
        `,
        [emissionId, userId]
      );

      hasAccess = agreementRows.length > 0;
    }

    if (!hasAccess) {
      return res.status(403).json({ message: "Access denied" });
    }

    const [issueResult] = await pool.query(
      `
      INSERT INTO admin_issues (user_id, startup_id, emission_id, source, issue_type, message, status)
      VALUES (?, ?, ?, ?, ?, ?, 'OPEN')
      `,
      [userId, startupId, emissionId, source, issueType, message]
    );

    await pool.query(
      `
      INSERT INTO admin_issue_messages (issue_id, sender_user_id, sender_role, message)
      VALUES (?, ?, ?, ?)
      `,
      [issueResult.insertId, userId, userRole || "user", message]
    );

    res.status(201).json({
      success: true,
      message: "Varsel sendt til support"
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
    return res.status(410).json({
        message: "Direkte investering i åpne runder er deaktivert. Bruk startupens private invitasjonslenke og RC-avtaleflyten."
    });
};
