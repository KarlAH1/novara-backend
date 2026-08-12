import pool from "../config/db.js";
import { getCompanyStartupProfile, resolveCompanyStartupOwner } from "./startupContext.js";
import { getRcAgreementColumns } from "../routes/rcAgreementRoutes.js";
import { getStartupPlanSummaryForUser, STARTUP_PLAN_STATES } from "./startupPlanAccess.js";

// rc_agreements columns vary by migration state — mirrors the same
// dynamic-select pattern used in the GET /:id route (rcAgreementRoutes.js).
async function getRcAgreementSignedAtSelects() {
    const columns = await getRcAgreementColumns();
    const investorSignedAtSelect = columns.has("investor_signed_at")
        ? "a.investor_signed_at"
        : columns.has("signed_at")
            ? "a.signed_at AS investor_signed_at"
            : "NULL AS investor_signed_at";
    const paymentConfirmedAtSelect = columns.has("payment_confirmed_by_startup_at")
        ? "a.payment_confirmed_by_startup_at"
        : "NULL AS payment_confirmed_by_startup_at";

    return { investorSignedAtSelect, paymentConfirmedAtSelect };
}

// Same shape as the /auth/pending-signatures endpoint — reused here so the
// "next task" list never disagrees with what that endpoint already reports.
async function getPendingSignatureTask(userId) {
    const [rows] = await pool.query(
        `SELECT ds.document_id, d.title
         FROM document_signers ds
         JOIN documents d ON d.id = ds.document_id
         WHERE ds.user_id = ? AND ds.signed_at IS NULL AND d.status != 'LOCKED'
         ORDER BY ds.id DESC
         LIMIT 1`,
        [userId]
    );

    const row = rows[0];
    if (!row) return null;

    return {
        title: "Signer dokumentet",
        description: row.title ? `"${row.title}" venter på din signatur.` : "Et dokument venter på din signatur.",
        ctaLabel: "Signer nå",
        ctaUrl: `sign.html?type=conversion&id=${row.document_id}`
    };
}

// Mirrors the exact conditions in getRcAgreementViewState() (rcAgreementRoutes.js)
// so "next task" always matches what rc-detail.html itself would show.
function resolveAgreementFlow(agreement) {
    const paymentConfirmed = !!agreement.payment_confirmed_by_startup_at || agreement.status === "Active RC";
    const investorSigned = !!agreement.investor_signed_at || agreement.status === "Awaiting Payment" || paymentConfirmed;
    return { paymentConfirmed, investorSigned };
}

async function getInvestorNextTask(userId) {
    const signatureTask = await getPendingSignatureTask(userId);
    if (signatureTask) return signatureTask;

    const { investorSignedAtSelect, paymentConfirmedAtSelect } = await getRcAgreementSignedAtSelects();

    const [agreements] = await pool.query(
        `SELECT a.id, a.status, ${investorSignedAtSelect}, ${paymentConfirmedAtSelect},
                pr.status AS par_value_status, pr.due_date AS par_value_due_date
         FROM rc_agreements a
         LEFT JOIN conversion_par_value_requests pr
             ON pr.id = (
                 SELECT req.id FROM conversion_par_value_requests req
                 WHERE req.agreement_id = a.id ORDER BY req.id DESC LIMIT 1
             )
         WHERE a.investor_id = ?
         ORDER BY a.created_at DESC`,
        [userId]
    );

    for (const agreement of agreements) {
        const { paymentConfirmed, investorSigned } = resolveAgreementFlow(agreement);
        if (investorSigned && !paymentConfirmed) {
            return {
                title: "Betal RC-avtalen",
                description: "Du har signert avtalen — betal investeringsbeløpet for å fullføre den.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreement.id}`
            };
        }
    }

    for (const agreement of agreements) {
        const dueNotConfirmed = agreement.par_value_status && agreement.par_value_status !== "paid_confirmed";
        if (dueNotConfirmed && agreement.par_value_due_date) {
            return {
                title: "Betal paribeløp",
                description: "Et paribeløp må betales for formell utstedelse av aksjene.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreement.id}`
            };
        }
    }

    if (agreements.length > 0) {
        const [legalRows] = await pool.query(
            `SELECT full_name, birth_date, digital_address, residential_address, postal_code, city, country
             FROM investor_legal_profiles WHERE user_id = ? LIMIT 1`,
            [userId]
        );
        const legal = legalRows[0] || {};
        const legalComplete = Boolean(
            legal.full_name && legal.birth_date && legal.digital_address &&
            legal.residential_address && legal.postal_code && legal.city && legal.country
        );

        if (!legalComplete) {
            return {
                title: "Fyll ut aksjonærinfo",
                description: "Fyll ut opplysningene selskapet trenger til aksjeeierboken.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreements[0].id}`
            };
        }
    }

    return null;
}

async function getStartupPlanTask(userId) {
    const planSummary = await getStartupPlanSummaryForUser(userId);

    if (planSummary.state === STARTUP_PLAN_STATES.RAISE_FORM_UNLOCKED) {
        return null;
    }

    if (planSummary.state === STARTUP_PLAN_STATES.PAYMENT_PENDING) {
        return {
            title: "Venter på bekreftelse fra Raisium",
            description: "Betalingen din er registrert og venter på bekreftelse fra Raisium før rundeverktøyet åpnes.",
            ctaLabel: "Se status",
            ctaUrl: "profile.html"
        };
    }

    if (planSummary.state === STARTUP_PLAN_STATES.PAYMENT_REQUIRED || planSummary.state === STARTUP_PLAN_STATES.PLAN_SELECTED) {
        return {
            title: "Betal for planen",
            description: "Fullfør betalingen for planen din — rundeverktøyet åpnes når betalingen er bekreftet.",
            ctaLabel: "Gå til betaling",
            ctaUrl: "startup-payment.html"
        };
    }

    return {
        title: "Velg en plan",
        description: "Velg og aktiver en plan for å låse opp rundeverktøyet og starte en privat runde.",
        ctaLabel: "Velg plan",
        ctaUrl: "emisjon.html"
    };
}

async function getStartupNextTask(userId) {
    const planTask = await getStartupPlanTask(userId);
    if (planTask) return planTask;

    const signatureTask = await getPendingSignatureTask(userId);
    if (signatureTask) return signatureTask;

    const { investorSignedAtSelect, paymentConfirmedAtSelect } = await getRcAgreementSignedAtSelects();

    const [agreements] = await pool.query(
        `SELECT a.id, a.status, ${investorSignedAtSelect}, ${paymentConfirmedAtSelect}
         FROM rc_agreements a
         JOIN emission_rounds e ON a.round_id = e.id
         WHERE e.startup_id = ?
         ORDER BY a.created_at DESC`,
        [userId]
    );

    for (const agreement of agreements) {
        const { paymentConfirmed, investorSigned } = resolveAgreementFlow(agreement);
        if (investorSigned && !paymentConfirmed) {
            return {
                title: "Bekreft betaling mottatt",
                description: "En investor har signert avtalen og skal ha betalt inn beløpet — bekreft når pengene er mottatt.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreement.id}`
            };
        }
    }

    const profile = await getCompanyStartupProfile(pool, userId);
    const offeringMissing = !String(profile?.sector || "").trim();
    const useOfFundsMissing = !String(profile?.pitch || "").trim();

    if (!profile || offeringMissing || useOfFundsMissing) {
        return {
            title: "Fullfør profilen",
            description: "Fyll ut hva selskapet tilbyr og hva pengene skal brukes til, så investorer kan se det.",
            ctaLabel: "Gå til profilen",
            ctaUrl: "profile.html"
        };
    }

    const { startupUserId } = await resolveCompanyStartupOwner(pool, userId);
    const [articlesRows] = await pool.query(
        `SELECT id FROM startup_documents WHERE startup_id = ? AND document_type = 'current_articles_of_association' LIMIT 1`,
        [startupUserId]
    );

    if (articlesRows.length === 0) {
        return {
            title: "Last opp vedtekter",
            description: "Last opp gjeldende vedtekter, så de er klare til bruk i dokumentflyten og en eventuell konvertering.",
            ctaLabel: "Gå til profilen",
            ctaUrl: "profile.html"
        };
    }

    const [pitchDeckRows] = await pool.query(
        `SELECT id FROM startup_documents WHERE startup_id = ? AND document_type = 'pitch_deck' LIMIT 1`,
        [startupUserId]
    );

    if (pitchDeckRows.length === 0) {
        return {
            title: "Last opp pitch deck",
            description: "Last opp en PDF med pitch deck, så investorer får mer kontekst.",
            ctaLabel: "Gå til profilen",
            ctaUrl: "profile.html"
        };
    }

    return null;
}

export async function resolveNextTask(userId, role) {
    const safeRole = String(role || "").toLowerCase();

    if (safeRole === "investor") {
        return getInvestorNextTask(userId);
    }

    if (safeRole === "startup") {
        return getStartupNextTask(userId);
    }

    return null;
}
