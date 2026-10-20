import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool from "../config/db.js";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { generateInviteToken } from "../utils/inviteToken.js";
import { getInvite } from "../controllers/rcInviteController.js";
import { createExpiry, hashToken, validatePasswordRequirements } from "../utils/authSecurity.js";
import { sendInvestorInviteAccessCodeEmail } from "../utils/authEmailFlow.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import { buildParPreview } from "../utils/roundActivationReadiness.js";
import {
  INVITE_TAKEN_ERROR,
  claimInviteForUser,
  getOptionalUserFromRequest,
  inviteIsAvailableTo,
  loadInviteClaim
} from "../utils/inviteClaim.js";
import { createAuthToken } from "../utils/authToken.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { sendEmail } from "../utils/emailService.js";
import { renderEmail, frontendBase } from "../utils/emailLayout.js";
import { escapeHtml } from "../utils/html.js";
import { MINIMUM_RC_INVESTMENT_NOK } from "../utils/rcInvestmentRules.js";
import {
  deleteInvestorFlowProgress,
  loadInvestorFlowProgress,
  saveInvestorFlowProgress
} from "../utils/investorFlowProgress.js";
import { getReservedAmount } from "../utils/capacityReservation.js";
import {
  findAgreementForClaimedInvite,
  loadRoundPipeline,
  markInviteOpened,
  normalizeInviteeInput
} from "../utils/invitePipeline.js";
import { AUDIT_EVENTS, recordAuditEvent } from "../utils/auditLogger.js";
import {
  CURRENT_TERMS_VERSION,
  hasAcceptedTerms,
  termsNotAcceptedResponse
} from "../utils/legalTerms.js";

const router = express.Router();
const inviteAccessLimiter = createRateLimiter({
  keyPrefix: "invite-access-code",
  windowMs: 10 * 60 * 1000,
  maxRequests: 8,
  message: "For mange kodeforsøk. Vent litt og prøv igjen."
});

function createSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function findInvestorAgreementForRound(connection, roundId, investorId) {
  if (!investorId) return null;
  const [rows] = await connection.query(
    `SELECT id FROM rc_agreements
     WHERE round_id = ? AND investor_id = ?
     LIMIT 1`,
    [roundId, investorId]
  );
  return rows[0] || null;
}

router.get("/:token", getInvite);

router.get("/:token/progress", auth, requireRole(["investor"]), async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const invite = await loadInviteClaim(pool, token);
    if (!invite) {
      return res.status(404).json({ error: "Fant ikke invitasjonen." });
    }
    if (invite.claimed_by_user_id == null) {
      return res.json({ progress: null });
    }
    if (!inviteIsAvailableTo(invite, req.user.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const existingAgreement = await findInvestorAgreementForRound(
      pool,
      invite.round_id,
      req.user.id
    );
    if (existingAgreement) {
      await deleteInvestorFlowProgress(pool, {
        investorId: req.user.id,
        inviteId: invite.id
      });
      return res.status(409).json({
        error: "Du har allerede en investering i denne runden.",
        code: "agreement_exists_for_round",
        agreementId: existingAgreement.id
      });
    }

    const availability = await syncEmissionRoundAvailability(pool, invite.round_id);
    if (!availability?.canInvest || availability.remainingCapacity < MINIMUM_RC_INVESTMENT_NOK) {
      await deleteInvestorFlowProgress(pool, {
        investorId: req.user.id,
        inviteId: invite.id
      });
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }

    const progress = await loadInvestorFlowProgress(pool, {
      investorId: req.user.id,
      inviteId: invite.id
    });
    res.json({ progress });
  } catch (err) {
    console.error("Get investor flow progress failed:", err);
    res.status(500).json({ error: "Kunne ikke hente fremdriften." });
  }
});

router.put("/:token/progress", auth, requireRole(["investor"]), async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const invite = await loadInviteClaim(pool, token);
    if (!invite) {
      return res.status(404).json({ error: "Fant ikke invitasjonen." });
    }
    if (!inviteIsAvailableTo(invite, req.user.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const existingAgreement = await findInvestorAgreementForRound(
      pool,
      invite.round_id,
      req.user.id
    );
    if (existingAgreement) {
      await deleteInvestorFlowProgress(pool, {
        investorId: req.user.id,
        inviteId: invite.id
      });
      return res.status(409).json({
        error: "Du har allerede en investering i denne runden.",
        code: "agreement_exists_for_round",
        agreementId: existingAgreement.id
      });
    }

    const availability = await syncEmissionRoundAvailability(pool, invite.round_id);
    if (!availability?.canInvest || availability.remainingCapacity < MINIMUM_RC_INVESTMENT_NOK) {
      await deleteInvestorFlowProgress(pool, {
        investorId: req.user.id,
        inviteId: invite.id
      });
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }
    if (!(await claimInviteForUser(pool, token, req.user.id))) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const progress = await saveInvestorFlowProgress(pool, {
      investorId: req.user.id,
      inviteId: invite.id,
      progress: req.body || {}
    });
    res.json({ success: true, progress });
  } catch (err) {
    console.error("Save investor flow progress failed:", err);
    res.status(500).json({ error: "Kunne ikke lagre fremdriften." });
  }
});
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

      const invitee = normalizeInviteeInput(req.body || {});
      if (!invitee.ok) {
        await connection.rollback();
        return res.status(400).json({ error: invitee.error, code: "INVITEE_NAME_REQUIRED" });
      }

      const token = generateInviteToken();

      const [insertResult] = await connection.query(
        "INSERT INTO rc_invites (round_id, token, invitee_name, invitee_relation) VALUES (?, ?, ?, ?)",
        [roundId, token, invitee.name, invitee.relation]
      );

      // The invitee's name stays in rc_invites; the audit trail only needs to
      // show that a personal invite was issued, and to whom by relation.
      await recordAuditEvent(connection, AUDIT_EVENTS.INVITE_CREATED, {
        startupId: round.startup_id,
        roundId: Number(roundId),
        actorUserId: req.user.id,
        actorRole: "startup",
        metadata: { invite_id: insertResult.insertId, relation: invitee.relation }
      });

      await connection.commit();

      res.status(201).json({
        message: "Personlig invitasjon opprettet",
        token,
        invite: {
          id: insertResult.insertId,
          inviteeName: invitee.name,
          relation: invitee.relation
        }
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
   SEND AN INVITE BY E-MAIL (Startup Only)
   Raisium sends the personal link on the founder's behalf, to one address
   the founder typed, with their own short message. Still one link, one
   person: the link locks to whoever opens it first.
===================================================== */

const inviteEmailLimiter = createRateLimiter({
  keyPrefix: "invite-email",
  windowMs: 10 * 60 * 1000,
  maxRequests: 30,
  message: "Du har sendt mange invitasjoner på kort tid. Vent litt og prøv igjen."
});

router.post(
  "/send-email/:token",
  auth,
  requireRole(["startup"]),
  inviteEmailLimiter,
  async (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const message = String(req.body?.message || "").trim().slice(0, 600);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Skriv inn en gyldig e-postadresse, for eksempel navn@epost.no." });
      }

      const [rows] = await pool.query(
        `SELECT i.id, i.invitee_name, r.id AS round_id, r.startup_id, r.open, r.target_amount,
                COALESCE(sp.company_name, owner.name) AS company_name
         FROM rc_invites i
         JOIN emission_rounds r ON r.id = i.round_id
         LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
         LEFT JOIN users owner ON owner.id = r.startup_id
         WHERE i.token = ?
         LIMIT 1`,
        [req.params.token]
      );
      const invite = rows[0];
      if (!invite) {
        return res.status(404).json({ error: "Fant ikke invitasjonen. Lag en ny lenke og prøv igjen." });
      }
      if (invite.startup_id !== req.user.id) {
        return res.status(403).json({ error: "Denne invitasjonen hører til en annen runde." });
      }
      if (Number(invite.open) !== 1) {
        return res.status(400).json({ error: "Runden er ikke åpen, så invitasjonen kan ikke sendes nå." });
      }

      const [[sender]] = await pool.query("SELECT name FROM users WHERE id = ? LIMIT 1", [req.user.id]);
      const senderName = String(sender?.name || "").trim() || "En gründer";
      const firstName = senderName.split(/\s+/)[0];
      const company = invite.company_name || "selskapet";
      const link = `${frontendBase()}/invest.html?invite=${encodeURIComponent(req.params.token)}`;
      const target = Number(invite.target_amount || 0);
      const targetLabel = target ? `${target.toLocaleString("no-NO")} kr` : "";

      await sendEmail({
        to: email,
        subject: `${firstName} har invitert deg til å investere i ${company}`,
        text: `${senderName} fra ${company} har invitert deg til å investere i en privat runde.${message ? `\n\n«${message}»` : ""}\n\nSe invitasjonen:\n${link}\n\nLenken er personlig. Del den ikke videre.`,
        html: renderEmail({
          heading: `${firstName} har invitert deg til å investere i ${company}`,
          introHtml: `<strong>${escapeHtml(senderName)}</strong> fra <strong>${escapeHtml(company)}</strong> har sendt deg en personlig invitasjon til en privat runde. Se hva selskapet gjør, og bestem selv om du vil være med.`,
          box: {
            amount: targetLabel,
            label: targetLabel ? `Privat runde i ${company}` : "",
            linesHtml: message ? `«${escapeHtml(message).replace(/\n/g, "<br>")}»` : ""
          },
          button: { label: "Se invitasjonen", url: link },
          after: "Lenken er personlig og låses til deg første gang du åpner den. Del den ikke videre.",
          preheader: `${senderName} har invitert deg til en privat runde i ${company}`,
          accent: "investor"
        })
      });

      res.json({ message: `Invitasjonen er sendt til ${email}.` });
    } catch (err) {
      console.error("Send invite e-mail failed:", err);
      res.status(500).json({ error: "Vi fikk ikke sendt e-posten. Prøv igjen, eller del lenken på SMS i stedet." });
    }
  }
);

/* =====================================================
   INVESTOR PIPELINE (Startup Only)
   Everyone the startup has invited to this round, and how
   far each of them has come.
===================================================== */

router.get(
  "/pipeline/:roundId",
  auth,
  requireRole(["startup"]),
  async (req, res) => {
    try {
      const roundId = Number(req.params.roundId);
      if (!Number.isInteger(roundId) || roundId <= 0) {
        return res.status(400).json({ error: "Ugyldig runde." });
      }

      const [[round]] = await pool.query(
        "SELECT id, startup_id FROM emission_rounds WHERE id = ? LIMIT 1",
        [roundId]
      );
      if (!round) {
        return res.status(404).json({ error: "Fant ikke runden." });
      }
      if (Number(round.startup_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Ikke din runde." });
      }

      res.json(await loadRoundPipeline(pool, roundId));
    } catch (err) {
      console.error("Load invite pipeline failed:", err);
      res.status(500).json({ error: "Kunne ikke hente invitasjonene." });
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

/*
  Illustrative par amount for an invited investor, using the long-stop scenario:
  no discount, price set by the valuation cap over the company's issued shares.
  Returns null whenever the share basis is not yet confirmed, rather than
  guessing — a wrong estimate here is worse than none.
*/
async function buildInviteParEstimate(db, invite) {
  try {
    const cap = Number(invite.valuation_cap || 0);
    const target = Number(invite.target_amount || 0);
    if (!cap || !target) return null;

    const [[profile]] = await db.query(
      `SELECT nominal_value_per_share, current_share_count
       FROM startup_profiles WHERE user_id = ? LIMIT 1`,
      [invite.startup_id]
    );

    const preview = buildParPreview({
      valuationCap: cap,
      shareCount: Number(profile?.current_share_count || 0),
      parValue: Number(profile?.nominal_value_per_share || 0),
      // A typical single investment: one tenth of the round, so the figure is
      // recognisable rather than the whole round's aggregate.
      exampleInvestment: Math.max(Math.round(target / 10), MINIMUM_RC_INVESTMENT_NOK)
    });

    return preview && !preview.blocked ? preview : null;
  } catch {
    return null;
  }
}

/*
  What this investor's own amount would mean at conversion.

  The generic example on the terms page is not enough: the second payment is the
  most surprising part of the model, and someone deciding to put in NOK 5,000
  needs to see the figure for NOK 5,000, next to the field where they type it.

  Calculated here, by the same calculator that will later produce the binding
  allocation. The browser never derives an allocation of its own.
*/
router.get("/:token/par-estimate", async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const token = String(req.params.token || "").trim();
    const amount = Number(req.query.amount);

    if (!Number.isFinite(amount) || amount < MINIMUM_RC_INVESTMENT_NOK) {
      return res.json({
        estimate: null,
        minimumInvestment: MINIMUM_RC_INVESTMENT_NOK
      });
    }

    const [rows] = await connection.query(
      `SELECT r.startup_id, r.valuation_cap
       FROM rc_invites i
       JOIN emission_rounds r ON i.round_id = r.id
       WHERE i.token = ? LIMIT 1`,
      [token]
    );
    const round = rows[0];
    if (!round) return res.status(404).json({ error: "Fant ikke invitasjonen." });

    const [[profile]] = await connection.query(
      `SELECT nominal_value_per_share, current_share_count
       FROM startup_profiles WHERE user_id = ? LIMIT 1`,
      [round.startup_id]
    );

    const preview = buildParPreview({
      valuationCap: Number(round.valuation_cap || 0),
      shareCount: Number(profile?.current_share_count || 0),
      parValue: Number(profile?.nominal_value_per_share || 0),
      exampleInvestment: amount
    });

    res.json({ estimate: preview && !preview.blocked ? preview : null });
  } catch (err) {
    console.error("Par estimate error:", err);
    res.json({ estimate: null });
  } finally {
    connection.release();
  }
});

router.get("/validate/:token", async (req, res) => {
  try {

    const token = req.params.token;

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteClaim) {
      return res.status(404).json({ error: "Ugyldig invitasjon." });
    }

    const viewingUser = getOptionalUserFromRequest(req);
    if (!inviteIsAvailableTo(inviteClaim, viewingUser?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const [rows] = await pool.query(
      `
      SELECT 
        i.round_id,
        r.startup_id,
        r.target_amount,
        r.amount_raised,
        r.discount_rate,
        r.valuation_cap,
        r.conversion_years,
        r.open,
        COALESCE(c.company_name, sp.company_name, u.name) AS company_name,
        sp.sector AS what_offers,
        sp.pitch AS use_of_funds,
        sp.vision AS description,
        sd.filename AS pitch_deck_filename,
        sd.url AS pitch_deck_url
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      JOIN users u ON r.startup_id = u.id
      LEFT JOIN company_memberships cm ON cm.user_id = r.startup_id
      LEFT JOIN companies c ON c.id = cm.company_id
      LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
      LEFT JOIN startup_documents sd ON sd.id = (
        SELECT sd2.id
        FROM startup_documents sd2
        WHERE sd2.startup_id = r.startup_id
          AND sd2.document_type = 'pitch_deck'
        ORDER BY sd2.uploaded_at DESC, sd2.id DESC
        LIMIT 1
      )
      WHERE i.token = ?
      `,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Ugyldig invitasjon til privat runde" });
    }

    const invite = rows[0];

    // The startup previewing its own link is not the invitee opening it.
    if (Number(viewingUser?.id) !== Number(invite.startup_id)) {
      await markInviteOpened(pool, inviteClaim.id).catch((markError) => {
        console.error("Mark invite opened failed:", markError);
      });
    }

    const availability = await syncEmissionRoundAvailability(pool, invite.round_id);
    const reservedAmount = availability
      ? await getReservedAmount(pool, invite.round_id)
      : 0;
    const remainingCapacity = Math.max(
      Number(availability?.remainingCapacity || 0) - Number(reservedAmount || 0),
      0
    );
    const belowMinimumCapacity = Boolean(
      availability?.canInvest && remainingCapacity < MINIMUM_RC_INVESTMENT_NOK
    );
    const existingAgreement = await findInvestorAgreementForRound(
      pool,
      invite.round_id,
      viewingUser?.id
    );

    res.json({
      startup: {
        companyName: invite.company_name,
        portalTitle: `${invite.company_name} sin private rundeportal`,
        portalIntro: `Denne siden brukes av ${invite.company_name} for avtaler, dokumenter og status. Raisium leverer programvaren.`,
        whatOffers: invite.what_offers || "",
        useOfFunds: invite.use_of_funds || "",
        description: invite.description || "",
        pitchDeck: invite.pitch_deck_url
          ? {
              filename: invite.pitch_deck_filename || "Åpne PDF",
              url: invite.pitch_deck_url
            }
          : null
      },
      round: {
        id: invite.round_id,
        status: availability?.status || (invite.open === 1 ? "LIVE" : "DRAFT"),
        targetAmount: availability?.targetAmount ?? Number(invite.target_amount || 0),
        committedAmount: availability?.committedAmount ?? availability?.committed_amount ?? null,
        amountRaised: availability?.confirmedPaidAmount ?? availability?.amount_raised ?? invite.amount_raised ?? null,
        remainingCapacity,
        closedReason: existingAgreement
          ? "agreement_exists_for_round"
          : (availability?.closedReason || null),
        canInvest: Boolean(availability?.canInvest) && !belowMinimumCapacity && !existingAgreement,
        existingAgreementId: existingAgreement?.id || null,
        message: existingAgreement
          ? "Du har allerede en investering i denne runden."
          : belowMinimumCapacity
          ? "Runden har mindre enn minste investeringsbeløp tilgjengelig."
          : (availability?.message || null)
      },
      terms: {
        targetAmount: invite.target_amount,
        amountRaised: invite.amount_raised,
        discountRate: invite.discount_rate,
        valuationCap: invite.valuation_cap,
        conversionYears: invite.conversion_years,
        minimumInvestment: MINIMUM_RC_INVESTMENT_NOK
      },
      // Deterministic only for the long-stop scenario, where the valuation cap
      // alone sets the price. Calculated here so the browser never derives a
      // legal allocation of its own.
      par_estimate: await buildInviteParEstimate(pool, invite)
    });

  } catch (err) {
    console.error("Validate invite failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/access-code/send/:token", inviteAccessLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email) {
      return res.status(400).json({ error: "Navn og e-post er påkrevd." });
    }

    if (!hasAcceptedTerms(req.body)) {
      return termsNotAcceptedResponse(res);
    }

    if (password) {
      const passwordError = validatePasswordRequirements(password);
      if (passwordError) {
        return res.status(400).json({ error: passwordError });
      }
    }

    const [inviteRows] = await pool.query(
      `
      SELECT r.id
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      WHERE i.token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!inviteRows.length) {
      return res.status(404).json({ error: "Ugyldig eller lukket invitasjon til privat runde" });
    }

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteIsAvailableTo(inviteClaim, getOptionalUserFromRequest(req)?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const availability = await syncEmissionRoundAvailability(pool, inviteRows[0].id);
    if (!availability?.canInvest) {
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }

    const [userRows] = await pool.query(
      "SELECT id, role FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (userRows.length) {
      const existingRole = String(userRows[0].role || "").toLowerCase();
      if (existingRole === "investor") {
        return res.status(400).json({ error: "Brukeren finnes allerede. Logg inn med e-post og passord." });
      }
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes i denne private investorflyten.", code: "email_is_startup" });
    }

    let pendingPasswordHash;
    if (password) {
      pendingPasswordHash = await bcrypt.hash(password, 10);
    } else {
      const [pendingRows] = await pool.query(
        `
        SELECT pending_password_hash
        FROM startup_email_verifications
        WHERE email = ?
          AND pending_password_hash IS NOT NULL
          AND consumed_at IS NULL
          AND expires_at >= NOW()
        ORDER BY id DESC
        LIMIT 1
        `,
        [email]
      );
      pendingPasswordHash = pendingRows[0]?.pending_password_hash;
    }

    if (!pendingPasswordHash) {
      return res.status(400).json({
        error: "Registreringen har utløpt. Gå tilbake og skriv inn opplysningene på nytt."
      });
    }

    const code = createSixDigitCode();
    const expiresAt = createExpiry(0.25);

    // Only the newest code may complete this registration. The password is
    // kept as a one-way bcrypt hash and removed as soon as the flow completes
    // or is replaced by a new code.
    await pool.query(
      `
      UPDATE startup_email_verifications
      SET consumed_at = NOW(), pending_password_hash = NULL
      WHERE email = ?
        AND pending_password_hash IS NOT NULL
        AND consumed_at IS NULL
      `,
      [email]
    );

    await pool.query(
      `
      INSERT INTO startup_email_verifications
        (email, code_hash, verification_token_hash, pending_password_hash, expires_at)
      VALUES (?, ?, NULL, ?, ?)
      `,
      [email, hashToken(code), pendingPasswordHash, expiresAt]
    );

    await sendInvestorInviteAccessCodeEmail({ email, code });

    res.json({
      success: true,
      message: "Vi har sendt en kode til e-posten din.",
      expiresAt
    });
  } catch (err) {
    console.error("Send investor invite access code failed:", {
      message: err?.message || String(err),
      email: String(req.body?.email || "").trim().toLowerCase(),
      hasResendKey: Boolean(String(process.env.RESEND_API_KEY || process.env.RESEND_KEY || "").trim()),
      hasEmailFrom: Boolean(String(process.env.EMAIL_FROM || process.env.RESEND_FROM || process.env.FROM_EMAIL || process.env.MAIL_FROM || "").trim()),
      environment: process.env.NODE_ENV || "development"
    });
    res.status(500).json({ error: "Kunne ikke sende kode akkurat nå." });
  }
});

router.post("/access-code/verify/:token", inviteAccessLimiter, async (req, res) => {
  let connection;
  let transactionStarted = false;

  try {
    const token = String(req.params.token || "").trim();
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();

    if (!name || !email || !code) {
      return res.status(400).json({ error: "Navn, e-post og kode er påkrevd." });
    }

    if (!hasAcceptedTerms(req.body)) {
      return termsNotAcceptedResponse(res);
    }

    const [inviteRows] = await pool.query(
      `
      SELECT r.id
      FROM rc_invites i
      JOIN emission_rounds r ON i.round_id = r.id
      WHERE i.token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!inviteRows.length) {
      return res.status(404).json({ error: "Ugyldig eller lukket invitasjon til privat runde" });
    }

    const inviteClaim = await loadInviteClaim(pool, token);
    if (!inviteIsAvailableTo(inviteClaim, getOptionalUserFromRequest(req)?.id)) {
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    const availability = await syncEmissionRoundAvailability(pool, inviteRows[0].id);
    if (!availability?.canInvest) {
      return res.status(409).json({
        error: availability?.message || "Den private runden er avsluttet.",
        code: availability?.closedReason || "round_closed"
      });
    }

    const [verificationRows] = await pool.query(
      `
      SELECT id, code_hash, pending_password_hash, expires_at, attempts
      FROM startup_email_verifications
      WHERE email = ?
        AND pending_password_hash IS NOT NULL
        AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1
      `,
      [email]
    );

    const record = verificationRows[0];
    if (!record) {
      return res.status(400).json({ error: "Fant ingen aktiv kode. Be om en ny kode." });
    }

    const expiresAt = new Date(record.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      await pool.query(
        "UPDATE startup_email_verifications SET consumed_at = NOW(), pending_password_hash = NULL WHERE id = ?",
        [record.id]
      );
      return res.status(400).json({ error: "Koden har utløpt. Be om en ny kode." });
    }

    if (Number(record.attempts || 0) >= 5) {
      await pool.query(
        "UPDATE startup_email_verifications SET consumed_at = NOW(), pending_password_hash = NULL WHERE id = ?",
        [record.id]
      );
      return res.status(429).json({ error: "For mange kodeforsøk. Be om en ny kode." });
    }

    if (hashToken(code) !== record.code_hash) {
      await pool.query(
        `
        UPDATE startup_email_verifications
        SET attempts = attempts + 1,
            consumed_at = IF(attempts + 1 >= 5, NOW(), consumed_at),
            pending_password_hash = IF(attempts + 1 >= 5, NULL, pending_password_hash)
        WHERE id = ? AND consumed_at IS NULL AND attempts < 5
        `,
        [record.id]
      );
      return res.status(400).json({ error: "Koden er ugyldig." });
    }

    const passwordHash = String(record.pending_password_hash);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [userRows] = await connection.query(
      "SELECT id, role FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (userRows.length) {
      await connection.rollback();
      transactionStarted = false;
      const existingRole = String(userRows[0].role || "").toLowerCase();
      if (existingRole === "investor") {
        return res.status(400).json({ error: "Brukeren finnes allerede. Logg inn med e-post og passord." });
      }
      return res.status(400).json({ error: "Denne e-posten er allerede knyttet til en startup-bruker og kan ikke brukes i denne private investorflyten.", code: "email_is_startup" });
    }

    const [result] = await connection.query(
      `INSERT INTO users
       (name, email, password, role, email_verified, email_verification_token, email_verification_expires,
        terms_accepted_at, terms_version)
       VALUES (?, ?, ?, 'investor', 1, NULL, NULL, NOW(), ?)`,
      [name, email, passwordHash, CURRENT_TERMS_VERSION]
    );

    const [verificationUpdate] = await connection.query(
      `
      UPDATE startup_email_verifications
      SET verified_at = NOW(),
          consumed_at = NOW(),
          pending_password_hash = NULL
      WHERE id = ? AND consumed_at IS NULL AND attempts < 5
      `,
      [record.id]
    );

    if (verificationUpdate.affectedRows !== 1) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ error: "Koden er allerede brukt eller låst." });
    }

    // Bind the invite to this investor — anyone else with the link is now locked out.
    if (!(await claimInviteForUser(connection, token, result.insertId))) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
    }

    await connection.commit();
    transactionStarted = false;

    const user = {
      id: result.insertId,
      name,
      email,
      role: "investor"
    };

    res.json({
      success: true,
      message: "E-posten er verifisert. Du kan fortsette.",
      token: createAuthToken(user),
      user
    });
  } catch (err) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("Verify investor invite access code failed:", err);
    res.status(500).json({ error: "Kunne ikke verifisere koden." });
  } finally {
    connection?.release();
  }
});

router.post("/access/:token", async (req, res) => {
  res.status(410).json({
    success: false,
    error: "Bruk kodeverifisering for å opprette investortilgang."
  });
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
        JOIN emission_rounds r ON i.round_id = r.id
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

      // Once the invitee has an RC agreement, the invite is part of that
      // agreement's history and stays.
      if (await findAgreementForClaimedInvite(pool, invite)) {
        return res.status(409).json({
          error: "Personen har allerede startet en avtale, så invitasjonen kan ikke trekkes tilbake.",
          code: "INVITE_HAS_AGREEMENT"
        });
      }

      await pool.query(
        "DELETE FROM rc_invites WHERE id=?",
        [inviteId]
      );

      await recordAuditEvent(pool, AUDIT_EVENTS.INVITE_REVOKED, {
        startupId: invite.startup_id,
        roundId: invite.round_id,
        actorUserId: req.user.id,
        actorRole: "startup",
        metadata: { invite_id: invite.id, was_claimed: invite.claimed_by_user_id != null }
      });

      res.json({ message: "Invitasjonen er trukket tilbake" });

    } catch (err) {
      console.error("Revoke invite failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
