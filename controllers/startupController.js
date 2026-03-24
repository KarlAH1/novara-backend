import pool from "../config/db.js";
import { fetchBrregCompany, fetchBrregRoles } from "../utils/brreg.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
    STARTUP_PLAN_DEFINITIONS,
    getCompanyForUser,
    getStartupPlanDefinition,
    getStartupPlanSummaryForUser
} from "../utils/startupPlanAccess.js";
import {
    getCompanyStartupProfile,
    resolveCompanyStartupOwner
} from "../utils/startupContext.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendUploadsDir = path.resolve(__dirname, "../../frontend/uploads/pitch-decks");
const STARTUP_TEXT_MAX_LENGTH = 200;

function validateStartupText(value, fieldLabel, { required = false } = {}) {
    const normalized = String(value || "").trim();

    if (required && !normalized) {
        return `${fieldLabel} må fylles ut.`;
    }

    if (normalized.length > STARTUP_TEXT_MAX_LENGTH) {
        return `${fieldLabel} kan være maks ${STARTUP_TEXT_MAX_LENGTH} tegn.`;
    }

    return null;
}

async function getCompanyIdentityForUser(userId) {
    return getCompanyForUser(userId);
}

async function getLatestPitchDeck(userId) {
    const [rows] = await pool.query(
        `
        SELECT filename, url, uploaded_at
        FROM startup_documents
        WHERE startup_id = ?
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 1
        `,
        [userId]
    );

    return rows[0] || null;
}

export const createOrUpdateStartupProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const company = await getCompanyIdentityForUser(userId);
        const {
            what_offers,
            use_of_funds,
            description,
            sector,
            pitch,
            vision,
            raising_amount,
            slip_horizon_months,
            is_raising
        } = req.body;

        if (!company?.company_name) {
            return res.status(400).json({ error: "Fant ikke selskapsinformasjon fra Brønnøysund for brukeren." });
        }

        const offeringValue = String(what_offers || sector || "").trim();
        const useOfFundsValue = String(use_of_funds || pitch || "").trim();
        const descriptionValue = String(description || vision || "").trim();
        const offeringError = validateStartupText(offeringValue, "Hva selskapet tilbyr", { required: true });
        const useOfFundsError = validateStartupText(useOfFundsValue, "Bruk av kapital", { required: true });
        const descriptionError = validateStartupText(descriptionValue, "Kort selskapsbeskrivelse");

        if (offeringError || useOfFundsError || descriptionError) {
            return res.status(400).json({
                error: offeringError || useOfFundsError || descriptionError
            });
        }

        const existing = await getCompanyStartupProfile(pool, userId);

        if (existing) {
            await pool.query(
                `UPDATE startup_profiles
                 SET company_name=?, sector=?, pitch=?, country=?, vision=?,
                     raising_amount=?, slip_horizon_months=?, is_raising=?
                 WHERE user_id=?`,
                [
                    company.company_name,
                    offeringValue,
                    useOfFundsValue,
                    "",
                    descriptionValue,
                    raising_amount, slip_horizon_months, is_raising, existing.user_id
                ]
            );

            return res.json({ message: "Startup updated" });
        }

        await pool.query(
            `INSERT INTO startup_profiles
             (user_id, company_name, sector, pitch, country, vision,
              raising_amount, slip_horizon_months, is_raising)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                userId,
                company.company_name,
                offeringValue,
                useOfFundsValue,
                "",
                descriptionValue,
                raising_amount, slip_horizon_months, is_raising
            ]
        );

        res.json({ message: "Startup registrert" });

    } catch (err) {
        console.log(err);
        if (err?.code === "ER_DATA_TOO_LONG") {
            return res.status(400).json({
                error: `Tekstfeltene kan være maks ${STARTUP_TEXT_MAX_LENGTH} tegn.`
            });
        }
        res.status(500).json({ error: "Server error" });
    }
};

export const getStartupByUser = async (req, res) => {
    const profile = await getCompanyStartupProfile(pool, req.user.id);

    if (!profile) {
        return res.json([]);
    }

    const latestPitchDeck = await getLatestPitchDeck(profile.user_id);
    res.json([{
        ...profile,
        pitch_deck: latestPitchDeck
    }]);
};

export const deleteMyStartup = async (req, res) => {
    try {
      const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
      const startupUserId = startupContext.startupUserId;

      const [emissionRows] = await pool.query(
        `
        SELECT id
        FROM emission_rounds
        WHERE startup_id = ?
        LIMIT 1
        `,
        [startupUserId]
      );

      if (emissionRows.length > 0) {
        return res.status(400).json({
          error: "Startupen kan ikke slettes mens emisjon eller emisjonsgrunnlag fortsatt finnes."
        });
      }

      const [agreementRows] = await pool.query(
        `
        SELECT a.id
        FROM rc_agreements a
        JOIN emission_rounds e ON e.id = a.round_id
        WHERE e.startup_id = ?
        LIMIT 1
        `,
        [startupUserId]
      );

      if (agreementRows.length > 0) {
        return res.status(400).json({
          error: "Startupen kan ikke slettes når det finnes RC-avtaler i prosess eller signert."
        });
      }

      await pool.query(
        "DELETE FROM startup_profiles WHERE user_id=?",
        [startupUserId]
      );
  
      res.json({ message: "Startup slettet." });
  
    } catch (err) {
      console.error("Delete startup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

export const getAllRaisingStartups = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM startup_profiles WHERE is_raising=1"
    );
    res.json(rows);
};

export const getMyOrganization = async (req, res) => {
    try {
        const [rows] = await pool.query(
            `
            SELECT
              c.id,
              c.orgnr,
              c.company_name,
              u.id AS user_id,
              u.name,
              u.email,
              u.role
            FROM company_memberships cm
            JOIN companies c ON cm.company_id = c.id
            JOIN users u ON cm.user_id = u.id
            WHERE c.id = (
              SELECT company_id
              FROM company_memberships
              WHERE user_id = ?
              LIMIT 1
            )
            ORDER BY u.created_at ASC
            `,
            [req.user.id]
        );

        if (!rows.length) {
            return res.json(null);
        }

        const [roleCheckRows] = await pool.query(
            `
            SELECT company_role_check_status, company_role_check_checked_at
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [req.user.id]
        );

        let brregCompany = null;
        let brregRoles = [];

        try {
            brregCompany = await fetchBrregCompany(rows[0].orgnr);
            brregRoles = await fetchBrregRoles(rows[0].orgnr);
        } catch (err) {
            console.error("Brreg organization lookup error:", err.message || err);
        }

        res.json({
            orgnr: rows[0].orgnr,
            company_name: rows[0].company_name,
            role_check: {
                status: roleCheckRows[0]?.company_role_check_status || null,
                checked_at: roleCheckRows[0]?.company_role_check_checked_at || null
            },
            company_info: {
                legal_name: brregCompany?.name || rows[0].company_name,
                orgnr: rows[0].orgnr,
                organization_form: brregCompany?.formDescription || brregCompany?.form || null,
                status: brregCompany?.status || null,
                address: brregCompany?.address || null,
                has_registered_signature: brregCompany?.hasRegisteredSignature ?? null,
                has_registered_prokura: brregCompany?.hasRegisteredProkura ?? null,
                roles: brregRoles.slice(0, 16)
            },
            members: rows.map((row) => ({
                id: row.user_id,
                name: row.name,
                email: row.email,
                role: row.role
            }))
        });
    } catch (err) {
        console.error("Get organization error:", err);
        res.status(500).json({ error: "Server error" });
    }
};

export const uploadStartupPitchDeck = async (req, res) => {
    try {
        const existingProfile = await getCompanyStartupProfile(pool, req.user.id);
        const targetStartupUserId = existingProfile?.user_id || req.user.id;
        const fileName = String(req.body.fileName || "").trim();
        const fileData = String(req.body.fileData || "").trim();

        if (!fileName || !fileData) {
            return res.status(400).json({ error: "Filnavn og filinnhold mangler." });
        }

        if (!/\.pdf$/i.test(fileName)) {
            return res.status(400).json({ error: "Pitch deck må være en PDF." });
        }

        const match = fileData.match(/^data:application\/pdf;base64,(.+)$/);

        if (!match) {
            return res.status(400).json({ error: "Ugyldig PDF-opplasting." });
        }

        const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "-");
        const storedFileName = `${targetStartupUserId}-${Date.now()}-${safeName}`;
        const absolutePath = path.join(frontendUploadsDir, storedFileName);
        const publicPath = `uploads/pitch-decks/${storedFileName}`;

        await fs.mkdir(frontendUploadsDir, { recursive: true });
        await fs.writeFile(absolutePath, Buffer.from(match[1], "base64"));

        await pool.query(
            `
            INSERT INTO startup_documents (startup_id, filename, url)
            VALUES (?, ?, ?)
            `,
            [targetStartupUserId, fileName, publicPath]
        );

        res.json({
            success: true,
            file: {
                filename: fileName,
                url: publicPath
            }
        });
    } catch (err) {
        console.error("Upload startup pitch deck error:", err);
        res.status(500).json({ error: "Kunne ikke laste opp pitch deck." });
    }
};

function buildPlanResponse(summary) {
    return {
        state: summary.state,
        selected_plan: summary.selected_plan,
        active_plan: summary.active_plan,
        pending_plan: summary.pending_plan,
        payment_status: summary.payment_status,
        payment_confirmed: summary.payment_confirmed,
        raise_form_unlocked: summary.raise_form_unlocked,
        startup_has_basic_active: summary.startup_has_basic_active,
        startup_has_normal_active: summary.startup_has_normal_active,
        requires_normal_for_advanced_features: summary.requires_normal_for_advanced_features,
        upgrade_required_state: summary.upgrade_required_state,
        upgrade_message: summary.upgrade_message,
        can_store_documents: summary.can_store_documents,
        includes_conversion_package: summary.includes_conversion_package,
        includes_follow_up: summary.includes_follow_up,
        includes_legal_help: summary.includes_legal_help,
        company: summary.company,
        plan_options: summary.plan_options
    };
}

function getNextAnnualExpiry() {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    return next;
}

function buildPaymentReference(planCode, companyId) {
    return `startup-${planCode}-${companyId}-${Date.now()}`;
}

function generateDiscountCodeValue(planCode = "basic") {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `RAISIUM-${String(planCode || "basic").toUpperCase()}-${suffix}`;
}

async function getActiveSubscriptionForCompany(companyId) {
    const [rows] = await pool.query(
        `
        SELECT *
        FROM startup_plan_subscriptions
        WHERE company_id = ?
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at >= NOW())
        ORDER BY COALESCE(activated_at, created_at) DESC, id DESC
        LIMIT 1
        `,
        [companyId]
    );

    return rows[0] || null;
}

async function getOpenSubscriptionForCompany(companyId) {
    const [rows] = await pool.query(
        `
        SELECT *
        FROM startup_plan_subscriptions
        WHERE company_id = ?
          AND status IN ('payment_required', 'payment_pending')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `,
        [companyId]
    );

    return rows[0] || null;
}

export const getStartupPlanStatus = async (req, res) => {
    try {
        const summary = await getStartupPlanSummaryForUser(req.user.id);
        res.json(buildPlanResponse(summary));
    } catch (err) {
        console.error("Get startup plan status error:", err);
        res.status(500).json({ error: "Kunne ikke hente planstatus." });
    }
};

export const selectStartupPlan = async (req, res) => {
    try {
        const planCode = String(req.body.plan || "").trim().toLowerCase();
        const plan = getStartupPlanDefinition(planCode);
        const company = await getCompanyForUser(req.user.id);

        if (!company) {
            return res.status(400).json({ error: "Fant ikke selskapet som er koblet til brukeren." });
        }

        if (!plan || !plan.available || planCode === "pro") {
            return res.status(400).json({ error: "Valgt plan er ikke tilgjengelig ennå." });
        }

        const activeSubscription = await getActiveSubscriptionForCompany(company.company_id);
        if (activeSubscription?.plan_code === planCode) {
            const summary = await getStartupPlanSummaryForUser(req.user.id);
            return res.json({
                message: `${plan.name}-plan er allerede aktiv.`,
                ...buildPlanResponse(summary)
            });
        }

        if (activeSubscription?.plan_code === "normal" && planCode === "basic") {
            const summary = await getStartupPlanSummaryForUser(req.user.id);
            return res.json({
                message: "Normal-plan er allerede aktiv.",
                ...buildPlanResponse(summary)
            });
        }

        const openSubscription = await getOpenSubscriptionForCompany(company.company_id);
        const price = Number(plan.annual_price_nok || 0);

        if (openSubscription) {
            await pool.query(
                `
                UPDATE startup_plan_subscriptions
                SET plan_code = ?, list_price_nok = ?, final_price_nok = ?,
                    status = 'payment_required', activation_source = NULL,
                    payment_reference = NULL, discount_code_id = NULL,
                    starts_at = NULL, expires_at = NULL, activated_at = NULL
                WHERE id = ?
                `,
                [planCode, price, price, openSubscription.id]
            );
        } else {
            await pool.query(
                `
                INSERT INTO startup_plan_subscriptions
                (company_id, user_id, plan_code, billing_period, list_price_nok, final_price_nok, status)
                VALUES (?, ?, ?, 'annual', ?, ?, 'payment_required')
                `,
                [company.company_id, req.user.id, planCode, price, price]
            );
        }

        const summary = await getStartupPlanSummaryForUser(req.user.id);

        res.json({
            message: `${plan.name} valgt. Fortsett til betaling for å aktivere planen.`,
            ...buildPlanResponse(summary)
        });
    } catch (err) {
        console.error("Select startup plan error:", err);
        res.status(500).json({ error: "Kunne ikke velge plan." });
    }
};

export const startStartupPlanPayment = async (req, res) => {
    try {
        const company = await getCompanyForUser(req.user.id);

        if (!company) {
            return res.status(400).json({ error: "Fant ikke selskapet som er koblet til brukeren." });
        }

        const openSubscription = await getOpenSubscriptionForCompany(company.company_id);

        if (!openSubscription) {
            return res.status(400).json({ error: "Velg en plan før du går videre til betaling." });
        }

        if (openSubscription.plan_code === "pro") {
            return res.status(400).json({ error: "Pro-plan er ikke tilgjengelig ennå." });
        }

        await pool.query(
            `
            UPDATE startup_plan_subscriptions
            SET status = 'payment_pending',
                payment_reference = ?
            WHERE id = ?
            `,
            [buildPaymentReference(openSubscription.plan_code, company.company_id), openSubscription.id]
        );

        const summary = await getStartupPlanSummaryForUser(req.user.id);

        res.json({
            message: "Betaling er startet.",
            ...buildPlanResponse(summary)
        });
    } catch (err) {
        console.error("Start startup plan payment error:", err);
        res.status(500).json({ error: "Kunne ikke starte betaling." });
    }
};

export const confirmStartupPlanPayment = async (req, res) => {
    try {
        const company = await getCompanyForUser(req.user.id);

        if (!company) {
            return res.status(400).json({ error: "Fant ikke selskapet som er koblet til brukeren." });
        }

        const openSubscription = await getOpenSubscriptionForCompany(company.company_id);

        if (!openSubscription) {
            return res.status(400).json({ error: "Ingen plan er klar for betaling." });
        }

        if (openSubscription.status !== "payment_pending" && openSubscription.status !== "payment_required") {
            return res.status(400).json({ error: "Betalingsstatus kan ikke bekreftes akkurat na." });
        }

        await pool.query(
            `
            UPDATE startup_plan_subscriptions
            SET status = 'active',
                activation_source = 'mock_payment',
                starts_at = NOW(),
                expires_at = ?,
                activated_at = NOW()
            WHERE id = ?
            `,
            [getNextAnnualExpiry(), openSubscription.id]
        );

        const summary = await getStartupPlanSummaryForUser(req.user.id);

        res.json({
            message: "Planen er aktivert.",
            ...buildPlanResponse(summary)
        });
    } catch (err) {
        console.error("Confirm startup plan payment error:", err);
        res.status(500).json({ error: "Kunne ikke bekrefte betaling." });
    }
};

export const applyStartupDiscountCode = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const codeValue = String(req.body.code || "").trim().toUpperCase();
        const summaryBefore = await getStartupPlanSummaryForUser(req.user.id);
        const selectedPlan = summaryBefore.selected_plan;
        const company = summaryBefore.company;

        if (!company?.company_id) {
            return res.status(400).json({ error: "Fant ikke selskapet som er koblet til brukeren." });
        }

        if (!codeValue) {
            return res.status(400).json({ error: "Skriv inn en rabattkode." });
        }

        if (!selectedPlan) {
            return res.status(400).json({ error: "Velg en plan før du bruker rabattkode." });
        }

        if (summaryBefore.raise_form_unlocked && summaryBefore.active_plan === selectedPlan) {
            return res.status(400).json({ error: `${String(selectedPlan).toUpperCase()} er allerede aktiv for selskapet.` });
        }

        await connection.beginTransaction();

        const [codeRows] = await connection.query(
            `
            SELECT *
            FROM startup_discount_codes
            WHERE code = ?
            LIMIT 1
            `,
            [codeValue]
        );

        const code = codeRows[0];

        if (!code || !code.active) {
            await connection.rollback();
            return res.status(400).json({ error: "Rabattkoden er ikke gyldig." });
        }

        if (code.allowed_plan !== selectedPlan) {
            await connection.rollback();
            return res.status(400).json({ error: `Denne koden kan bare brukes pa ${String(code.allowed_plan || "").toUpperCase()}.` });
        }

        if (Number(code.times_redeemed || 0) >= Number(code.max_redemptions || 0)) {
            await connection.rollback();
            return res.status(400).json({ error: "Rabattkoden er brukt opp." });
        }

        if (selectedPlan !== "basic") {
            await connection.rollback();
            return res.status(400).json({ error: "Rabattkoden kan ikke brukes pa denne planen." });
        }

        const [existingRedemptions] = await connection.query(
            `
            SELECT id
            FROM startup_discount_redemptions
            WHERE discount_code_id = ?
              AND company_id = ?
            LIMIT 1
            `,
            [code.id, company.company_id]
        );

        if (existingRedemptions.length > 0) {
            await connection.rollback();
            return res.status(400).json({ error: "Rabattkoden er allerede brukt pa dette selskapet." });
        }

        const [openRows] = await connection.query(
            `
            SELECT *
            FROM startup_plan_subscriptions
            WHERE company_id = ?
              AND status IN ('payment_required', 'payment_pending')
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            `,
            [company.company_id]
        );

        let subscriptionId = openRows[0]?.id || null;

        if (subscriptionId) {
            await connection.query(
                `
                UPDATE startup_plan_subscriptions
                SET plan_code = 'basic',
                    list_price_nok = ?,
                    final_price_nok = 0,
                    status = 'active',
                    activation_source = 'discount_code',
                    discount_code_id = ?,
                    starts_at = NOW(),
                    expires_at = ?,
                    activated_at = NOW()
                WHERE id = ?
                `,
                [STARTUP_PLAN_DEFINITIONS.basic.annual_price_nok, code.id, getNextAnnualExpiry(), subscriptionId]
            );
        } else {
            const [insertResult] = await connection.query(
                `
                INSERT INTO startup_plan_subscriptions
                (company_id, user_id, plan_code, billing_period, list_price_nok, final_price_nok,
                 status, activation_source, discount_code_id, starts_at, expires_at, activated_at)
                VALUES (?, ?, 'basic', 'annual', ?, 0, 'active', 'discount_code', ?, NOW(), ?, NOW())
                `,
                [company.company_id, req.user.id, STARTUP_PLAN_DEFINITIONS.basic.annual_price_nok, code.id, getNextAnnualExpiry()]
            );

            subscriptionId = insertResult.insertId;
        }

        await connection.query(
            `
            INSERT INTO startup_discount_redemptions
            (discount_code_id, company_id, user_id, subscription_id, plan_code)
            VALUES (?, ?, ?, ?, 'basic')
            `,
            [code.id, company.company_id, req.user.id, subscriptionId]
        );

        await connection.query(
            `
            UPDATE startup_discount_codes
            SET times_redeemed = times_redeemed + 1
            WHERE id = ?
            `,
            [code.id]
        );

        await connection.commit();

        const summary = await getStartupPlanSummaryForUser(req.user.id);

        res.json({
            message: "Rabattkoden er aktivert. Basic-plan er nå aktiv.",
            ...buildPlanResponse(summary)
        });
    } catch (err) {
        await connection.rollback();
        console.error("Apply startup discount code error:", err);
        res.status(500).json({ error: "Kunne ikke aktivere rabattkoden." });
    } finally {
        connection.release();
    }
};

export const generateStartupDiscountCode = async (req, res) => {
    try {
        if (req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }

        const planCode = String(req.body.plan || "basic").trim().toLowerCase();
        const maxRedemptions = Math.max(1, Number(req.body.max_redemptions || 1));
        const plan = getStartupPlanDefinition(planCode);

        if (!plan || !plan.available) {
            return res.status(400).json({ error: "Kan bare generere kode for tilgjengelig plan." });
        }

        const code = String(req.body.code || "").trim().toUpperCase() || generateDiscountCodeValue(planCode);

        await pool.query(
            `
            INSERT INTO startup_discount_codes
            (code, active, allowed_plan, discount_type, discount_percent, max_redemptions, created_by_user_id)
            VALUES (?, 1, ?, 'full', 100, ?, ?)
            `,
            [code, planCode, maxRedemptions, req.user.id]
        );

        res.status(201).json({
            message: "Rabattkode opprettet.",
            code,
            allowed_plan: planCode,
            max_redemptions: maxRedemptions
        });
    } catch (err) {
        console.error("Generate startup discount code error:", err);
        res.status(500).json({ error: "Kunne ikke opprette rabattkode." });
    }
};
