import express from "express";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import {
  buildRcDocumentHtml,
  buildRcTemplateData,
  investViaInvite,
  resolveRcPaymentDeadline
} from "../controllers/rcAgreementController.js";
import { getCapacityExceededMessage, syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import { renderHtmlToPdfBuffer } from "../utils/pdfRenderer.js";
import { applySignatureBlockToHtml } from "../utils/documentSigning.js";
import { sendRcPaymentConfirmedEmail } from "../utils/notificationEmailFlow.js";

const router = express.Router();

const getRcPaymentColumns = async (connection) => {
  const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_payments");
  return new Set(columnRows.map((column) => column.Field));
};

const formatDateOnly = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const getInvestorLegalProfile = async (connection, userId, fallback = {}) => {
  const [rows] = await connection.query(
    `
    SELECT full_name, birth_date, digital_address, residential_address, postal_code, city, country, completed_at
    FROM investor_legal_profiles
    WHERE user_id = ?
    LIMIT 1
    `,
    [userId]
  );

  const row = rows[0] || {};
  const profile = {
    full_name: row.full_name || fallback.name || "",
    birth_date: formatDateOnly(row.birth_date),
    digital_address: row.digital_address || fallback.email || "",
    residential_address: row.residential_address || "",
    postal_code: row.postal_code || "",
    city: row.city || "",
    country: row.country || "Norge"
  };

  const complete = Boolean(
    profile.full_name &&
    profile.birth_date &&
    profile.digital_address &&
    profile.residential_address &&
    profile.postal_code &&
    profile.city &&
    profile.country
  );

  return {
    ...profile,
    complete,
    completed_at: row.completed_at || null
  };
};

const getDocumentSigners = async (connection, documentId) => {
  if (!documentId) return [];
  const [rows] = await connection.query(
    `
    SELECT ds.role, ds.email, ds.signed_at, COALESCE(u.name, ds.email) AS signer_name
    FROM document_signers ds
    LEFT JOIN users u ON u.id = ds.user_id
    WHERE ds.document_id = ?
    ORDER BY ds.id ASC
    `,
    [documentId]
  );
  return rows;
};

let rcAgreementColumnsPromise;

const getRcAgreementColumns = async () => {
  if (!rcAgreementColumnsPromise) {
    rcAgreementColumnsPromise = pool
      .query("SHOW COLUMNS FROM rc_agreements")
      .then(([columnRows]) => new Set(columnRows.map((column) => column.Field)));
  }

  return rcAgreementColumnsPromise;
};

const rcDocumentJoin = `
  LEFT JOIN documents d
    ON d.id = (
      SELECT doc.id
      FROM documents doc
      WHERE doc.type = 'RC'
        AND doc.startup_id = a.startup_id
        AND doc.html_content LIKE CONCAT('%rc_agreement_id:', a.id, '%')
      ORDER BY doc.id DESC
      LIMIT 1
    )
`;

const getRcAgreementViewState = (agreement = {}) => {
  const paymentConfirmed = !!agreement.payment_confirmed_by_startup_at || agreement.status === "Active RC";
  const investorSigned = !!agreement.investor_signed_at || agreement.status === "Awaiting Payment" || paymentConfirmed;
  const startupPreApproved = agreement.round_open === 1 || !!agreement.round_activated_at;

  if (paymentConfirmed) {
    return {
      flow_status: "Avtale aktiv / nedlastbar",
      flow_message: "Betaling er bekreftet av selskapet. Den endelige avtalen kan lastes ned.",
      final_document_status: "Avtale aktiv",
      is_downloadable: true,
      payment_status: "Betaling bekreftet av selskapet"
    };
  }

  if (investorSigned) {
    return {
      flow_status: "Signert / venter på betaling",
      flow_message: "Avtaleparten har signert. Avtalen blir endelig og nedlastbar når betaling er bekreftet av selskapet.",
      final_document_status: "Signert, venter på betaling",
      is_downloadable: false,
      payment_status: "Venter på betaling til selskapet"
    };
  }

  if (startupPreApproved) {
    return {
      flow_status: "Klargjort av selskapet",
      flow_message: "Selskapet har klargjort standardavtalen i sin private rundeportal. Avtaleparten må signere for å gå videre.",
      final_document_status: "Klargjort av selskapet",
      is_downloadable: false,
      payment_status: "Ikke startet"
    };
  }

  return {
    flow_status: "Utkast",
    flow_message: "Avtalen er fortsatt i utkaststadiet.",
    final_document_status: "Utkast",
    is_downloadable: false,
    payment_status: "Ikke startet"
  };
};

/* =====================================================
   CREATE RC AGREEMENT (Investor invests via invite)
===================================================== */
router.post("/invest/:token", auth, investViaInvite);

/* =====================================================
   GET AGREEMENT (Investor or Startup)
===================================================== */

router.get("/:id(\\d+)", auth, async (req, res) => {
  try {
    const agreementId = req.params.id;
    const userId = req.user.id;
    const rcAgreementColumns = await getRcAgreementColumns();
    const investorSignedAtSelect = rcAgreementColumns.has("investor_signed_at")
      ? "a.investor_signed_at"
      : rcAgreementColumns.has("signed_at")
        ? "a.signed_at AS investor_signed_at"
        : "NULL AS investor_signed_at";
    const paymentConfirmedAtSelect = rcAgreementColumns.has("payment_confirmed_by_startup_at")
      ? "a.payment_confirmed_by_startup_at"
      : "NULL AS payment_confirmed_by_startup_at";

    const [rows] = await pool.query(
      `
      SELECT
        a.*,
        ${investorSignedAtSelect},
        ${paymentConfirmedAtSelect},
        e.startup_id,
        e.open AS round_open,
        e.created_at AS round_created_at,
        CONCAT('Emisjon #', a.round_id) AS round_name,
        e.target_amount,
        e.amount_raised,
        e.committed_amount,
        e.closed_reason,
        e.discount_rate,
        e.valuation_cap,
        e.conversion_years,
        e.bank_account,
        e.deadline,
        COALESCE(c.company_name, sp.company_name, u.name) AS startup_name,
        COALESCE(c.company_name, sp.company_name, u.name) AS company_legal_name,
        investor.name AS investor_name,
        investor.email AS investor_email,
        pr.par_value_amount,
        pr.reference AS par_value_reference,
        pr.due_date AS par_value_due_date,
        pr.status AS par_value_status,
        d.id AS document_id,
        d.title AS document_title,
        d.status AS document_status,
        d.locked_at AS document_locked_at
      FROM rc_agreements a
      JOIN emission_rounds e ON a.round_id = e.id
      JOIN users u ON e.startup_id = u.id
      JOIN users investor ON a.investor_id = investor.id
      LEFT JOIN company_memberships cm ON cm.user_id = u.id
      LEFT JOIN companies c ON c.id = cm.company_id
      LEFT JOIN startup_profiles sp ON sp.user_id = e.startup_id
      LEFT JOIN conversion_par_value_requests pr
        ON pr.id = (
          SELECT req.id
          FROM conversion_par_value_requests req
          WHERE req.agreement_id = a.id
          ORDER BY req.id DESC
          LIMIT 1
        )
      ${rcDocumentJoin}
      WHERE a.id = ?
      `,
      [agreementId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    const agreement = rows[0];
    const availability = await syncEmissionRoundAvailability(pool, agreement.round_id);

    if (agreement.investor_id !== userId && agreement.startup_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const investorLegalProfile = await getInvestorLegalProfile(pool, agreement.investor_id, {
      name: agreement.investor_name,
      email: agreement.investor_email
    });

    res.json({
      ...agreement,
      investor_legal_profile: investorLegalProfile,
      payment_deadline: resolveRcPaymentDeadline(agreement),
      round_status: availability?.status || null,
      round_closed_reason: availability?.closedReason || null,
      round_remaining_capacity: availability?.remainingCapacity ?? null,
      round_committed_amount: availability?.committedAmount ?? null,
      ...getRcAgreementViewState(agreement)
    });

  } catch (err) {
    console.error("Get agreement error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id(\\d+)/shareholder-profile", auth, async (req, res) => {
  try {
    const agreementId = Number(req.params.id || 0);
    const userId = req.user.id;

    const [rows] = await pool.query(
      `
      SELECT a.id, a.investor_id, a.startup_id, a.status, investor.name AS investor_name, investor.email AS investor_email
      FROM rc_agreements a
      JOIN users investor ON investor.id = a.investor_id
      WHERE a.id = ?
      LIMIT 1
      `,
      [agreementId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    const agreement = rows[0];
    if (agreement.investor_id !== userId && agreement.startup_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const profile = await getInvestorLegalProfile(pool, agreement.investor_id, {
      name: agreement.investor_name,
      email: agreement.investor_email
    });

    res.json(profile);
  } catch (err) {
    console.error("Get shareholder profile error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id(\\d+)/shareholder-profile", auth, requireRole(["investor"]), async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const agreementId = Number(req.params.id || 0);
    const userId = req.user.id;

    const [rows] = await connection.query(
      `
      SELECT a.id, a.investor_id, a.status, u.name AS investor_name, u.email AS investor_email
      FROM rc_agreements a
      JOIN users u ON u.id = a.investor_id
      WHERE a.id = ?
      LIMIT 1
      `,
      [agreementId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Agreement not found" });
    }

    const agreement = rows[0];
    if (agreement.investor_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const agreementStatus = String(agreement.status || "");
    if (!["Awaiting Payment", "Active RC"].includes(agreementStatus)) {
      return res.status(400).json({ error: "Opplysningene kan fylles inn etter at avtalen er signert." });
    }

    const payload = {
      full_name: String(req.body.full_name || "").trim(),
      birth_date: String(req.body.birth_date || "").trim(),
      digital_address: String(req.body.digital_address || "").trim(),
      residential_address: String(req.body.residential_address || "").trim(),
      postal_code: String(req.body.postal_code || "").trim(),
      city: String(req.body.city || "").trim(),
      country: String(req.body.country || "").trim() || "Norge"
    };

    if (!payload.full_name || !payload.birth_date || !payload.digital_address || !payload.residential_address || !payload.postal_code || !payload.city || !payload.country) {
      return res.status(400).json({ error: "Fyll inn alle opplysninger som kreves for aksjeeierboken." });
    }

    const birthDate = new Date(payload.birth_date);
    if (Number.isNaN(birthDate.getTime())) {
      return res.status(400).json({ error: "Ugyldig fødselsdato." });
    }

    await connection.query(
      `
      INSERT INTO investor_legal_profiles (
        user_id, full_name, birth_date, digital_address, residential_address, postal_code, city, country, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        full_name = VALUES(full_name),
        birth_date = VALUES(birth_date),
        digital_address = VALUES(digital_address),
        residential_address = VALUES(residential_address),
        postal_code = VALUES(postal_code),
        city = VALUES(city),
        country = VALUES(country),
        completed_at = NOW()
      `,
      [
        userId,
        payload.full_name,
        payload.birth_date,
        payload.digital_address,
        payload.residential_address,
        payload.postal_code,
        payload.city,
        payload.country
      ]
    );

    res.json({
      success: true,
      message: "Opplysninger for aksjeeierboken er lagret.",
      profile: {
        ...payload,
        complete: true
      }
    });
  } catch (err) {
    console.error("Save shareholder profile error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    connection.release();
  }
});

router.get("/:id(\\d+)/document", auth, async (req, res) => {
  try {
    const agreementId = req.params.id;
    const userId = req.user.id;
    const rcAgreementColumns = await getRcAgreementColumns();
    const investorSignedAtSelect = rcAgreementColumns.has("investor_signed_at")
      ? "a.investor_signed_at"
      : rcAgreementColumns.has("signed_at")
        ? "a.signed_at AS investor_signed_at"
        : "NULL AS investor_signed_at";
    const paymentConfirmedAtSelect = rcAgreementColumns.has("payment_confirmed_by_startup_at")
      ? "a.payment_confirmed_by_startup_at"
      : "NULL AS payment_confirmed_by_startup_at";

    const [rows] = await pool.query(
      `
      SELECT
        a.investor_id,
        a.startup_id,
        a.round_id,
        a.rc_id,
        a.investment_amount,
        a.status AS agreement_status,
        a.created_at,
        ${investorSignedAtSelect},
        ${paymentConfirmedAtSelect},
        e.target_amount,
        e.amount_raised,
        e.discount_rate,
        e.valuation_cap,
        e.conversion_years,
        e.bank_account,
        e.deadline,
        e.open AS round_open,
        e.created_at AS round_created_at,
        COALESCE(c.company_name, sp.company_name, u.name) AS startup_name,
        u.email AS startup_email,
        investor.name AS investor_name,
        investor.email AS investor_email,
        COALESCE(c.company_name, sp.company_name, u.name) AS company_legal_name,
        c.orgnr AS company_org_no,
        d.id,
        d.title,
        d.type,
        d.status,
        d.document_hash,
        d.locked_at,
        d.html_content,
        d.created_at AS document_generated_at
      FROM rc_agreements a
      JOIN emission_rounds e ON a.round_id = e.id
      JOIN users u ON a.startup_id = u.id
      JOIN users investor ON a.investor_id = investor.id
      LEFT JOIN company_memberships cm ON cm.user_id = u.id
      LEFT JOIN companies c ON c.id = cm.company_id
      LEFT JOIN startup_profiles sp ON sp.user_id = a.startup_id
      ${rcDocumentJoin}
      WHERE a.id = ?
      `,
      [agreementId]
    );

    if (!rows.length || !rows[0].id) {
      return res.status(404).json({ error: "Document not found" });
    }

    const document = rows[0];

    if (document.investor_id !== userId && document.startup_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const viewState = getRcAgreementViewState(document);

    if (!viewState.is_downloadable) {
      return res.status(400).json({
        error: viewState.flow_message
      });
    }

    const baseHtml = document.html_content || buildRcDocumentHtml(buildRcTemplateData({
      agreement_id: agreementId,
      rc_id: document.rc_id,
      round_id: document.round_id,
      startup_name: document.startup_name,
      startup_email: document.startup_email,
      company_legal_name: document.company_legal_name,
      company_org_no: document.company_org_no,
      investor_name: document.investor_name,
      investor_email: document.investor_email,
      investor_identifier: document.investor_email,
      investment_amount: document.investment_amount,
      target_amount: document.target_amount,
      amount_raised: document.amount_raised,
      discount_rate: document.discount_rate,
      valuation_cap: document.valuation_cap,
      conversion_years: document.conversion_years,
      bank_account: document.bank_account,
      deadline: document.deadline,
      payment_deadline: resolveRcPaymentDeadline(document),
      round_open: document.round_open,
      round_created_at: document.round_created_at,
      created_at: document.created_at,
      investor_signed_at: document.investor_signed_at,
      payment_confirmed_by_startup_at: document.payment_confirmed_by_startup_at,
      document_hash: document.document_hash,
      agreement_document_hash: document.document_hash,
      document_locked_at: document.locked_at,
      document_generated_at: document.document_generated_at,
      payment_status: viewState.payment_status,
      payment_confirmed_by: document.startup_name,
      document_final_status: viewState.final_document_status,
      status: document.agreement_status
    }));
    const signers = await getDocumentSigners(pool, document.id);
    const htmlContent = applySignatureBlockToHtml(baseHtml, signers);

    res.json({
      id: document.id,
      title: document.title,
      type: document.type,
      status: viewState.final_document_status,
      document_hash: document.document_hash,
      payment_deadline: resolveRcPaymentDeadline(document),
      locked_at: document.locked_at,
      html_content: htmlContent
    });

  } catch (err) {
    console.error("Get RC document error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id(\\d+)/document/pdf", auth, async (req, res) => {
  try {
    const agreementId = req.params.id;
    const userId = req.user.id;
    const rcAgreementColumns = await getRcAgreementColumns();
    const investorSignedAtSelect = rcAgreementColumns.has("investor_signed_at")
      ? "a.investor_signed_at"
      : rcAgreementColumns.has("signed_at")
        ? "a.signed_at AS investor_signed_at"
        : "NULL AS investor_signed_at";
    const paymentConfirmedAtSelect = rcAgreementColumns.has("payment_confirmed_by_startup_at")
      ? "a.payment_confirmed_by_startup_at"
      : "NULL AS payment_confirmed_by_startup_at";

    const [rows] = await pool.query(
      `
      SELECT
        a.investor_id,
        a.startup_id,
        a.round_id,
        a.rc_id,
        a.investment_amount,
        a.status AS agreement_status,
        a.created_at,
        ${investorSignedAtSelect},
        ${paymentConfirmedAtSelect},
        e.target_amount,
        e.amount_raised,
        e.discount_rate,
        e.valuation_cap,
        e.conversion_years,
        e.bank_account,
        e.deadline,
        e.open AS round_open,
        e.created_at AS round_created_at,
        COALESCE(c.company_name, sp.company_name, u.name) AS startup_name,
        u.email AS startup_email,
        investor.name AS investor_name,
        investor.email AS investor_email,
        COALESCE(c.company_name, sp.company_name, u.name) AS company_legal_name,
        c.orgnr AS company_org_no,
        d.id,
        d.title,
        d.type,
        d.status,
        d.document_hash,
        d.locked_at,
        d.html_content,
        d.created_at AS document_generated_at
      FROM rc_agreements a
      JOIN emission_rounds e ON a.round_id = e.id
      JOIN users u ON a.startup_id = u.id
      JOIN users investor ON a.investor_id = investor.id
      LEFT JOIN company_memberships cm ON cm.user_id = u.id
      LEFT JOIN companies c ON c.id = cm.company_id
      LEFT JOIN startup_profiles sp ON sp.user_id = a.startup_id
      ${rcDocumentJoin}
      WHERE a.id = ?
      `,
      [agreementId]
    );

    if (!rows.length || !rows[0].id) {
      return res.status(404).json({ error: "Document not found" });
    }

    const document = rows[0];

    if (document.investor_id !== userId && document.startup_id !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const viewState = getRcAgreementViewState(document);
    if (!viewState.is_downloadable) {
      return res.status(400).json({
        error: viewState.flow_message
      });
    }

    const baseHtml = document.html_content || buildRcDocumentHtml(buildRcTemplateData({
      agreement_id: agreementId,
      rc_id: document.rc_id,
      round_id: document.round_id,
      startup_name: document.startup_name,
      startup_email: document.startup_email,
      company_legal_name: document.company_legal_name,
      company_org_no: document.company_org_no,
      investor_name: document.investor_name,
      investor_email: document.investor_email,
      investor_identifier: document.investor_email,
      investment_amount: document.investment_amount,
      target_amount: document.target_amount,
      amount_raised: document.amount_raised,
      discount_rate: document.discount_rate,
      valuation_cap: document.valuation_cap,
      conversion_years: document.conversion_years,
      bank_account: document.bank_account,
      deadline: document.deadline,
      round_open: document.round_open,
      round_created_at: document.round_created_at,
      created_at: document.created_at,
      investor_signed_at: document.investor_signed_at,
      payment_confirmed_by_startup_at: document.payment_confirmed_by_startup_at,
      document_hash: document.document_hash,
      agreement_document_hash: document.document_hash,
      document_locked_at: document.locked_at,
      document_generated_at: document.document_generated_at,
      payment_status: viewState.payment_status,
      payment_confirmed_by: document.startup_name,
      document_final_status: viewState.final_document_status,
      status: document.agreement_status
    }));
    const signers = await getDocumentSigners(pool, document.id);
    const htmlContent = applySignatureBlockToHtml(baseHtml, signers);

    const pdfBuffer = await renderHtmlToPdfBuffer(htmlContent || "");
    const safeTitle = String(document.title || `rc-avtale-${agreementId}`)
      .toLowerCase()
      .replace(/[^a-z0-9æøå\-]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    const filename = `${safeTitle || `rc-avtale-${agreementId}`}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Get RC document pdf error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* =====================================================
   SIGN AGREEMENT (Investor or Startup)
===================================================== */

router.post(
  "/:id(\\d+)/sign",
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
router.post("/:id(\\d+)/confirm", auth, async (req, res) => {
  const connection = await pool.getConnection();

  try {

    const agreementId = req.params.id;
    const userId = req.user.id;

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT a.*, e.amount_raised, investor.email AS investor_email, COALESCE(investor.name, investor.email) AS investor_name
      FROM rc_agreements a
      JOIN emission_rounds e ON a.round_id = e.id
      LEFT JOIN users investor ON investor.id = a.investor_id
      WHERE a.id=? AND a.startup_id=?
      FOR UPDATE
      `,
      [agreementId, userId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        error: "Agreement not found"
      });
    }

    const agreement = rows[0];
    const availability = await syncEmissionRoundAvailability(connection, agreement.round_id, { lock: true });

    if (agreement.status !== "Awaiting Payment") {
      await connection.rollback();
      return res.status(400).json({
        error: "Agreement not ready for activation"
      });
    }

    if (!availability?.canInvest || agreement.investment_amount > (availability?.remainingCapacity ?? 0)) {
      await connection.rollback();
      return res.status(400).json({
        error: getCapacityExceededMessage(availability?.remainingCapacity ?? 0),
        max_available_amount: availability?.remainingCapacity ?? 0,
        remainingCapacity: availability?.remainingCapacity ?? 0
      });
    }

    await connection.query(
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

    await connection.query(
      `
      UPDATE emission_rounds
      SET amount_raised = amount_raised + ?
      WHERE id = ?
      `,
      [agreement.investment_amount, agreement.round_id]
    );

    await syncEmissionRoundAvailability(connection, agreement.round_id, { lock: true });

    const [paymentRows] = await connection.query(
      "SELECT id FROM rc_payments WHERE agreement_id = ?",
      [agreementId]
    );

    const rcPaymentColumns = await getRcPaymentColumns(connection);

    if (paymentRows.length === 0) {
      const insertColumns = ["agreement_id", "amount", "status"];
      const insertValues = ["?", "?", "'Payment Confirmed'"];

      if (rcPaymentColumns.has("reference")) {
        insertColumns.push("reference");
        insertValues.push("?");
      }

      if (rcPaymentColumns.has("initiated_at")) {
        insertColumns.push("initiated_at");
        insertValues.push("NOW()");
      }

      if (rcPaymentColumns.has("confirmed_at")) {
        insertColumns.push("confirmed_at");
        insertValues.push("NOW()");
      }

      await connection.query(
        `
        INSERT INTO rc_payments
        (${insertColumns.join(", ")})
        VALUES (${insertValues.join(", ")})
        `,
        rcPaymentColumns.has("reference")
          ? [agreementId, agreement.investment_amount, agreement.rc_id || `RC-${agreementId}`]
          : [agreementId, agreement.investment_amount]
      );
    } else {
      const updateClauses = ["status='Payment Confirmed'"];

      if (rcPaymentColumns.has("confirmed_at")) {
        updateClauses.push("confirmed_at=NOW()");
      }

      await connection.query(
        `
        UPDATE rc_payments
        SET ${updateClauses.join(", ")}
        WHERE agreement_id = ?
        `,
        [agreementId]
      );
    }

    await connection.commit();

    sendRcPaymentConfirmedEmail({
      investorEmail: agreement.investor_email,
      startupName: req.user.name || "selskapet",
      amount: agreement.investment_amount,
      agreementId
    });

    res.json({
      success: true,
      newStatus: "Active RC"
    });

  } catch (err) {
    await connection.rollback();
    console.error("Confirm payment failed:", err);
    res.status(500).json({
      error: "Internal server error"
    });
  } finally {
    connection.release();
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
            a.round_id,
            a.investment_amount,
            a.status,
            a.created_at,
            a.activated_at,
            a.payment_confirmed_by_startup_at,
            CONCAT('Emisjon #', a.round_id) AS round_name,
            e.deadline,
            e.discount_rate,
            e.valuation_cap,
            e.conversion_years,
            e.bank_account,
            e.open AS round_open,
            e.closed_at AS round_closed_at,
            e.closed_reason AS round_closed_reason,
            pr.reference AS par_value_reference,
            pr.due_date AS par_value_due_date,
            pr.status AS par_value_status,
            COALESCE(c.company_name, sp.company_name, u.name) AS startup_name,
            d.id AS document_id,
            d.status AS document_status
          FROM rc_agreements a
          JOIN emission_rounds e ON a.round_id = e.id
          JOIN users u ON a.startup_id = u.id
          LEFT JOIN conversion_par_value_requests pr
            ON pr.id = (
              SELECT req.id
              FROM conversion_par_value_requests req
              WHERE req.agreement_id = a.id
              ORDER BY req.id DESC
              LIMIT 1
            )
          LEFT JOIN company_memberships cm ON cm.user_id = u.id
          LEFT JOIN companies c ON c.id = cm.company_id
          LEFT JOIN startup_profiles sp ON sp.user_id = a.startup_id
          ${rcDocumentJoin}
          WHERE a.investor_id = ?
          ORDER BY a.created_at DESC
          `,
          [investorId]
        );
  
        res.json(rows.map((row) => ({
          ...row,
          payment_deadline: resolveRcPaymentDeadline(row),
          ...getRcAgreementViewState(row)
        })));
  
      } catch (err) {
        console.error("Get my agreements failed:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

router.get(
  "/startup/list",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {
      const startupId = req.user.id;

      const [rows] = await pool.query(
        `
        SELECT
          a.id,
          a.rc_id,
          a.round_id,
          a.investment_amount,
          a.status,
          a.created_at,
          a.activated_at,
          a.payment_confirmed_by_startup_at,
          u.name AS investor_name,
          u.email AS investor_email,
          CONCAT('Emisjon #', a.round_id) AS round_name,
          e.deadline,
          e.discount_rate,
          e.valuation_cap,
          e.conversion_years,
          e.bank_account,
          e.target_amount,
          e.amount_raised,
          e.committed_amount,
          e.closed_reason,
          rp.reference AS payment_reference,
          d.id AS document_id,
          d.status AS document_status
        FROM rc_agreements a
        JOIN users u ON a.investor_id = u.id
        JOIN emission_rounds e ON a.round_id = e.id
        LEFT JOIN rc_payments rp ON rp.agreement_id = a.id
        ${rcDocumentJoin}
        WHERE a.startup_id = ?
        ORDER BY
          CASE
            WHEN a.status = 'Awaiting Payment' THEN 0
            WHEN a.status = 'Active RC' THEN 1
            ELSE 2
          END,
          a.created_at DESC
        `,
        [startupId]
      );

      res.json(rows.map((row) => ({
        ...row,
        payment_deadline: resolveRcPaymentDeadline(row),
        ...getRcAgreementViewState(row)
      })));

    } catch (err) {
      console.error("Get startup agreements failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);


export default router;
