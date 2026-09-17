import pool from "../config/db.js";
import { getCompanyStartupProfile, resolveCompanyStartupOwner, getCompanyForUserWithConnection } from "./startupContext.js";
import { getRcAgreementColumns } from "../routes/rcAgreementRoutes.js";
import { getStartupPlanSummaryForUser, STARTUP_PLAN_STATES } from "./startupPlanAccess.js";
import { isStripeConfigured } from "./stripeClient.js";
import { getPendingSignatures } from "./pendingSignatures.js";
import { getLatestStartupRoundDraft } from "./roundDraft.js";
import { getInvestorFlowProgressList } from "./investorFlowProgress.js";

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

// Same source as /auth/pending-signatures, so the card and the endpoint agree.
async function getPendingSignatureTasks(userId) {
    const pending = await getPendingSignatures(pool, userId);
    return pending.map((item) => ({
        kind: "pending_signature",
        roundId: item.round_id == null ? null : Number(item.round_id),
        startupId: item.startup_id == null ? null : Number(item.startup_id),
        title: item.company_name
            ? `Signer dokumentet for ${item.company_name}`
            : "Signer dokumentet",
        description: item.document_title
            ? `"${item.document_title}" venter på din signatur.`
            : "Et dokument venter på din signatur.",
        ctaLabel: "Signer nå",
        ctaUrl: item.sign_path
    }));
}

async function getPendingSignatureTask(userId) {
    const [first] = await getPendingSignatureTasks(userId);
    return first || null;
}

// Mirrors the exact conditions in getRcAgreementViewState() (rcAgreementRoutes.js)
// so "next task" always matches what rc-detail.html itself would show.
function resolveAgreementFlow(agreement) {
    const paymentConfirmed = !!agreement.payment_confirmed_by_startup_at || agreement.status === "Active RC";
    const investorSigned = !!agreement.investor_signed_at || agreement.status === "Awaiting Payment" || paymentConfirmed;
    return { paymentConfirmed, investorSigned };
}

async function getInvestorNextTasks(userId) {
    const tasks = [];
    const occupiedRounds = new Set();
    const addTask = (task) => {
        if (!task) return;
        const roundId = Number(task.roundId);
        if (Number.isInteger(roundId) && roundId > 0) {
            if (occupiedRounds.has(roundId)) return;
            occupiedRounds.add(roundId);
        }
        tasks.push(task);
    };

    const signatureTasks = await getPendingSignatureTasks(userId);
    signatureTasks.forEach(addTask);

    const { investorSignedAtSelect, paymentConfirmedAtSelect } = await getRcAgreementSignedAtSelects();

    const [agreements] = await pool.query(
        `SELECT a.id, a.round_id, a.startup_id, a.status,
                ${investorSignedAtSelect}, ${paymentConfirmedAtSelect},
                pr.status AS par_value_status, pr.due_date AS par_value_due_date,
                COALESCE(sp.company_name, startup.name) AS company_name
         FROM rc_agreements a
         JOIN users startup ON startup.id = a.startup_id
         LEFT JOIN startup_profiles sp ON sp.user_id = a.startup_id
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
            addTask({
                kind: "agreement_payment",
                roundId: Number(agreement.round_id),
                startupId: Number(agreement.startup_id),
                title: agreement.company_name
                    ? `Betal RC-avtalen for ${agreement.company_name}`
                    : "Betal RC-avtalen",
                description: "Du har signert avtalen — betal investeringsbeløpet for å fullføre den.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreement.id}`
            });
        }
    }

    for (const agreement of agreements) {
        const dueNotConfirmed = agreement.par_value_status && agreement.par_value_status !== "paid_confirmed";
        if (dueNotConfirmed && agreement.par_value_due_date) {
            addTask({
                kind: "par_value_payment",
                roundId: Number(agreement.round_id),
                startupId: Number(agreement.startup_id),
                title: agreement.company_name
                    ? `Betal paribeløp for ${agreement.company_name}`
                    : "Betal paribeløp",
                description: "Et paribeløp må betales for formell utstedelse av aksjene.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreement.id}`
            });
        }
    }

    const flowProgressItems = await getInvestorFlowProgressList(pool, userId);
    for (const flowProgress of flowProgressItems) {
        const stageDetails = {
            terms: ["Steg 1 av 4", "Vilkår"],
            invest: ["Steg 2 av 4", "Beløp"],
            review: ["Steg 3 av 4", "Bekreft"]
        };
        const [stepLabel, stageLabel] = stageDetails[flowProgress.stage] || stageDetails.terms;
        const companyLabel = flowProgress.companyName ? ` hos ${flowProgress.companyName}` : "";
        addTask({
            kind: "resume_investor_flow",
            roundId: flowProgress.roundId,
            eyebrow: "Fortsett der du slapp",
            title: `Fullfør investeringen${companyLabel}`,
            description: `${stepLabel} · ${stageLabel}`,
            ctaLabel: "Fortsett",
            ctaUrl: `invest.html?invite=${encodeURIComponent(flowProgress.inviteToken)}`,
            updatedAt: flowProgress.updatedAt
        });
    }

    if (tasks.length > 0) return tasks;

    if (agreements.length > 0) {
        const [legalRows] = await pool.query(
            `SELECT full_name, birth_date, digital_address, residential_address, postal_code, city, country,
                    (national_id_encrypted IS NOT NULL) AS has_national_id
             FROM investor_legal_profiles WHERE user_id = ? LIMIT 1`,
            [userId]
        );
        const legal = legalRows[0] || {};
        const legalComplete = Boolean(
            legal.full_name && legal.digital_address &&
            legal.residential_address && legal.postal_code && legal.city && legal.country &&
            legal.has_national_id
        );

        if (!legalComplete) {
            return [{
                kind: "legal_profile",
                title: "Fyll ut aksjonærinfo",
                description: "Fyll ut opplysningene selskapet trenger til aksjeeierboken.",
                ctaLabel: "Gå til avtalen",
                ctaUrl: `rc-detail.html?agreement=${agreements[0].id}`
            }];
        }
    }

    return [];
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
            ctaUrl: "startup-payment.html"
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

    const roundDraft = await getLatestStartupRoundDraft(pool, startupUserId);
    if (roundDraft) {
        const stepNames = ["Vilkår", "Eiergrunnlag", "Bekreft"];
        const step = Math.min(3, Math.max(1, Number(roundDraft.lastStep || 1)));
        return {
            kind: "resume_round_draft",
            eyebrow: "Fortsett der du slapp",
            title: "Gjør ferdig rundeoppsettet",
            description: `Steg ${step} av 3 · ${stepNames[step - 1]}`,
            ctaLabel: "Fortsett",
            ctaUrl: `dashboard.html?emission=${roundDraft.roundId}&step=${step}`,
            updatedAt: roundDraft.updatedAt
        };
    }

    const [articlesRows] = await pool.query(
        `SELECT id FROM startup_documents WHERE startup_id = ? AND document_type = 'current_articles_of_association' LIMIT 1`,
        [startupUserId]
    );

    if (articlesRows.length === 0) {
        return {
            title: "Last opp vedtekter",
            description: "Last opp gjeldende vedtekter, så de er klare til bruk i dokumentflyten og en eventuell konvertering.",
            ctaLabel: "Gå til dokumenter",
            ctaUrl: "document.html"
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

    if (isStripeConfigured()) {
        const company = await getCompanyForUserWithConnection(pool, userId);
        if (company?.company_id) {
            const [companyRows] = await pool.query(
                "SELECT stripe_charges_enabled FROM companies WHERE id = ? LIMIT 1",
                [company.company_id]
            );

            if (!companyRows[0]?.stripe_charges_enabled) {
                return {
                    title: "Koble Stripe",
                    description: "Koble til Stripe så investorer kan betale umiddelbart med kort eller Vipps, i stedet for bankoverføring.",
                    ctaLabel: "Gå til profilen",
                    ctaUrl: "profile.html"
                };
            }
        }
    }

    return null;
}

export async function resolveNextTask(userId, role) {
    const [task] = await resolveNextTasks(userId, role);
    return task || null;
}

export async function resolveNextTasks(userId, role) {
    const safeRole = String(role || "").toLowerCase();

    if (safeRole === "investor") {
        return getInvestorNextTasks(userId);
    }

    if (safeRole === "startup") {
        const task = await getStartupNextTask(userId);
        return task ? [task] : [];
    }

    return [];
}
