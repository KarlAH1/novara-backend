import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { createAuthToken } from "../utils/authToken.js";
import { frontendBase } from "../utils/emailLayout.js";
import { CURRENT_TERMS_VERSION } from "../utils/legalTerms.js";
import { claimInviteForUser, inviteIsAvailableTo, loadInviteClaim } from "../utils/inviteClaim.js";
import { vippsLoginEnabled, vippsPaymentEnabled } from "../utils/featureFlags.js";
import { activateRcAgreementPayment } from "../utils/rcPaymentActivation.js";
import { holdCapacityForCheckout } from "../utils/stripePayments.js";
import { syncConfirmationRequestsLater } from "../utils/paymentConfirmations.js";
import {
  captureVippsPayment,
  completeVippsLogin,
  consumeLoginState,
  createVippsPayment,
  getVippsPayment,
  isValidMsn,
  issueLoginCode,
  redeemLoginCode,
  startVippsLogin
} from "../utils/vipps.js";

const router = express.Router();

const loginLimiter = createRateLimiter({
  keyPrefix: "vipps-login",
  windowMs: 10 * 60 * 1000,
  maxRequests: 30,
  message: "For mange forsøk. Vent litt og prøv igjen."
});

// Back to the browser with an error code the page turns into plain words.
function returnWithError(res, code, inviteToken = "") {
  const params = new URLSearchParams({ error: code });
  if (inviteToken) params.set("invite", inviteToken);
  return res.redirect(302, `${frontendBase()}/vipps-return.html#${params.toString()}`);
}

/* ---------------- Login ---------------- */

router.get("/login/start", loginLimiter, async (req, res) => {
  const inviteToken = String(req.query.invite || "").trim().slice(0, 128);
  if (!vippsLoginEnabled()) return returnWithError(res, "disabled", inviteToken);
  try {
    const url = await startVippsLogin({
      inviteToken,
      termsAccepted: req.query.terms === "1",
      publicBase: frontendBase()
    });
    res.redirect(302, url);
  } catch (err) {
    console.error("Vipps login start failed:", err);
    returnWithError(res, "unavailable", inviteToken);
  }
});

router.get("/login/callback", loginLimiter, async (req, res) => {
  if (!vippsLoginEnabled()) return returnWithError(res, "disabled");
  const state = await consumeLoginState(String(req.query.state || "")).catch(() => null);
  if (!state) return returnWithError(res, "expired");
  const inviteToken = state.invite_token || "";

  // The person pressed "avbryt" in Vipps.
  if (req.query.error) return returnWithError(res, "cancelled", inviteToken);

  let connection;
  try {
    const profile = await completeVippsLogin({
      code: String(req.query.code || ""),
      nonce: state.nonce,
      publicBase: frontendBase()
    });

    connection = await pool.getConnection();
    await connection.beginTransaction();

    let [[user]] = await connection.query(
      "SELECT id, name, email, role FROM users WHERE vipps_sub = ? LIMIT 1 FOR UPDATE",
      [profile.sub]
    );

    if (!user) {
      if (!profile.email || !profile.emailVerified) {
        await connection.rollback();
        return returnWithError(res, "no_email", inviteToken);
      }
      [[user]] = await connection.query(
        "SELECT id, name, email, role FROM users WHERE email = ? LIMIT 1 FOR UPDATE",
        [profile.email]
      );
      if (user) {
        if (String(user.role).toLowerCase() !== "investor") {
          await connection.rollback();
          return returnWithError(res, "email_is_startup", inviteToken);
        }
        await connection.query(
          "UPDATE users SET vipps_sub = ?, vipps_phone = COALESCE(?, vipps_phone) WHERE id = ?",
          [profile.sub, profile.phone, user.id]
        );
      } else {
        if (!state.terms_accepted) {
          await connection.rollback();
          return returnWithError(res, "terms", inviteToken);
        }
        // A password nobody knows: the account signs in with Vipps, and can
        // set a password later through "glemt passord" if it wants e-mail too.
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
        const [created] = await connection.query(
          `INSERT INTO users
           (name, email, password, role, email_verified, vipps_sub, vipps_phone, terms_accepted_at, terms_version)
           VALUES (?, ?, ?, 'investor', 1, ?, ?, NOW(), ?)`,
          [profile.name || profile.email, profile.email, passwordHash, profile.sub, profile.phone, CURRENT_TERMS_VERSION]
        );
        user = { id: created.insertId, name: profile.name || profile.email, email: profile.email, role: "investor" };
      }
    } else if (String(user.role).toLowerCase() !== "investor") {
      await connection.rollback();
      return returnWithError(res, "email_is_startup", inviteToken);
    }

    if (inviteToken) {
      const claim = await loadInviteClaim(connection, inviteToken);
      if (claim && !inviteIsAvailableTo(claim, user.id)) {
        await connection.rollback();
        return returnWithError(res, "invite_claimed", inviteToken);
      }
      if (claim && !(await claimInviteForUser(connection, inviteToken, user.id))) {
        await connection.rollback();
        return returnWithError(res, "invite_claimed", inviteToken);
      }
    }

    await connection.commit();
    const code = await issueLoginCode(state.state_hash, user.id);
    const params = new URLSearchParams({ code });
    if (inviteToken) params.set("invite", inviteToken);
    res.redirect(302, `${frontendBase()}/vipps-return.html#${params.toString()}`);
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error("Vipps login callback failed:", err);
    returnWithError(res, "unavailable", inviteToken);
  } finally {
    connection?.release();
  }
});

// The browser trades the one-time code for its session.
router.post("/login/exchange", loginLimiter, async (req, res) => {
  if (!vippsLoginEnabled()) return res.status(404).json({ error: "Vipps-innlogging er ikke slått på." });
  try {
    const row = await redeemLoginCode(String(req.body?.code || ""));
    if (!row) return res.status(400).json({ error: "Innloggingen har utløpt. Prøv igjen." });
    const [[user]] = await pool.query(
      "SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1",
      [row.user_id]
    );
    if (!user) return res.status(400).json({ error: "Fant ikke kontoen." });
    const sessionUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.json({ token: createAuthToken(sessionUser), user: sessionUser, invite: row.invite_token || null });
  } catch (err) {
    console.error("Vipps login exchange failed:", err);
    res.status(500).json({ error: "Kunne ikke fullføre innloggingen." });
  }
});

/* ---------------- The startup's Vipps merchant ---------------- */

async function companyForStartup(userId) {
  const [[company]] = await pool.query(
    `SELECT c.id, c.vipps_msn FROM company_memberships cm
     JOIN companies c ON c.id = cm.company_id WHERE cm.user_id = ? LIMIT 1`,
    [userId]
  );
  return company || null;
}

router.get("/merchant", auth, requireRole(["startup"]), async (req, res) => {
  const company = await companyForStartup(req.user.id);
  res.json({ enabled: vippsPaymentEnabled(), msn: company?.vipps_msn || null });
});

router.put("/merchant", auth, requireRole(["startup"]), async (req, res) => {
  if (!vippsPaymentEnabled()) return res.status(404).json({ error: "Vipps-betaling er ikke slått på." });
  const msn = String(req.body?.msn || "").replace(/\s/g, "");
  if (msn && !isValidMsn(msn)) {
    return res.status(400).json({ error: "Vipps-nummeret (MSN) er 5–8 siffer. Du finner det på portal.vippsmobilepay.com." });
  }
  const company = await companyForStartup(req.user.id);
  if (!company) return res.status(400).json({ error: "Kontoen er ikke koblet til et selskap ennå." });
  await pool.query("UPDATE companies SET vipps_msn = ? WHERE id = ?", [msn || null, company.id]);
  res.json({ msn: msn || null, message: msn ? "Vipps er koblet til." : "Vipps er koblet fra." });
});

/* ---------------- Paying an agreement with Vipps ---------------- */

async function loadPayableAgreement(agreementId) {
  const [[row]] = await pool.query(
    `SELECT a.id, a.rc_id, a.round_id, a.status, a.investment_amount, a.investor_id,
            a.vipps_reference, c.vipps_msn, COALESCE(c.company_name, '') AS company_name
     FROM rc_agreements a
     JOIN company_memberships cm ON cm.user_id = a.startup_id
     JOIN companies c ON c.id = cm.company_id
     WHERE a.id = ? LIMIT 1`,
    [agreementId]
  );
  return row || null;
}

router.post("/payment/:agreementId(\\d+)", auth, requireRole(["investor"]), async (req, res) => {
  if (!vippsPaymentEnabled()) return res.status(404).json({ error: "Vipps-betaling er ikke slått på." });
  try {
    const agreement = await loadPayableAgreement(req.params.agreementId);
    if (!agreement || Number(agreement.investor_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: "Fant ikke avtalen." });
    }
    if (agreement.status !== "Awaiting Payment") {
      return res.status(400).json({ error: "Avtalen er ikke klar for betaling." });
    }
    if (!agreement.vipps_msn) {
      return res.status(400).json({ error: "Selskapet tar ikke imot Vipps ennå. Betal med bankoverføring." });
    }

    const hold = await holdCapacityForCheckout(agreement);
    if (!hold.ok) return res.status(409).json({ error: hold.error });

    const reference = `rc${agreement.id}-${Date.now().toString(36)}`;
    const payment = await createVippsPayment({
      msn: agreement.vipps_msn,
      reference,
      amountNok: agreement.investment_amount,
      description: `RC-avtale ${agreement.rc_id || agreement.id} – ${agreement.company_name}`,
      returnUrl: `${frontendBase()}/rc-detail.html?agreement=${agreement.id}&vipps=return`
    });

    await pool.query(
      "UPDATE rc_agreements SET payment_method = 'vipps', vipps_reference = ? WHERE id = ?",
      [reference, agreement.id]
    );
    res.json({ url: payment.redirectUrl });
  } catch (err) {
    console.error("Vipps payment start failed:", err);
    res.status(502).json({ error: "Vi fikk ikke kontakt med Vipps. Prøv igjen, eller betal med bankoverføring." });
  }
});

/*
  After Vipps sends the investor back: look the payment up, capture it once
  it is authorised, and activate the agreement only when the full amount is
  captured on the payment Raisium itself created.
*/
router.post("/payment/:agreementId(\\d+)/sync", auth, requireRole(["investor"]), async (req, res) => {
  if (!vippsPaymentEnabled()) return res.status(404).json({ error: "Vipps-betaling er ikke slått på." });
  let connection;
  try {
    const agreement = await loadPayableAgreement(req.params.agreementId);
    if (!agreement || Number(agreement.investor_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: "Fant ikke avtalen." });
    }
    if (agreement.status === "Active RC") return res.json({ status: "paid" });
    if (!agreement.vipps_reference || !agreement.vipps_msn) return res.json({ status: "none" });

    const expected = Math.round(Number(agreement.investment_amount) * 100);
    let payment = await getVippsPayment({ msn: agreement.vipps_msn, reference: agreement.vipps_reference });
    if (Number(payment?.amount?.value) !== expected) {
      console.error("Vipps payment amount mismatch", { agreementId: agreement.id, reference: agreement.vipps_reference });
      return res.status(409).json({ error: "Beløpet stemmer ikke med avtalen. Kontakt oss." });
    }

    if (payment.state === "AUTHORIZED" && Number(payment.aggregate?.capturedAmount?.value || 0) < expected) {
      await captureVippsPayment({ msn: agreement.vipps_msn, reference: agreement.vipps_reference, amountNok: agreement.investment_amount });
      payment = await getVippsPayment({ msn: agreement.vipps_msn, reference: agreement.vipps_reference });
    }

    if (Number(payment.aggregate?.capturedAmount?.value || 0) >= expected) {
      connection = await pool.getConnection();
      const result = await activateRcAgreementPayment(connection, { agreementId: agreement.id });
      if (result.ok && !result.alreadyActive) {
        await pool.query("UPDATE rc_agreements SET vipps_paid_at = NOW() WHERE id = ?", [agreement.id]);
        syncConfirmationRequestsLater({ roundId: agreement.round_id });
      }
      return res.json({ status: result.ok ? "paid" : "error" });
    }

    if (["ABORTED", "EXPIRED", "TERMINATED"].includes(payment.state)) {
      return res.json({ status: "failed" });
    }
    res.json({ status: "pending" });
  } catch (err) {
    console.error("Vipps payment sync failed:", err);
    res.status(502).json({ error: "Vi fikk ikke sjekket betalingen hos Vipps. Last siden på nytt om litt." });
  } finally {
    connection?.release();
  }
});

export default router;
