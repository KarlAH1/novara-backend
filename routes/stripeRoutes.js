import express from "express";
import { auth, requireRole } from "../middleware/authMiddleware.js";
import { isStripeConfigured } from "../utils/stripeClient.js";
import {
    getOrCreateConnectedAccount,
    createOnboardingLink,
    getConnectStatusForUser
} from "../utils/stripeConnect.js";
import { createCheckoutSessionForAgreement, createCheckoutSessionForStartupPlan, createCheckoutSessionForParValue } from "../utils/stripePayments.js";

const router = express.Router();

function getFrontendBase() {
    return String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");
}

router.get("/connect/status", auth, requireRole(["startup"]), async (req, res) => {
    if (!isStripeConfigured()) {
        return res.json({ configured: false, connected: false });
    }

    try {
        const status = await getConnectStatusForUser(req.user.id);
        res.json({ configured: true, ...status });
    } catch (err) {
        console.error("Stripe connect status error:", err);
        res.status(500).json({ error: "Kunne ikke hente Stripe-status." });
    }
});

router.post("/connect/onboard", auth, requireRole(["startup"]), async (req, res) => {
    if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe er ikke konfigurert i dette miljøet ennå." });
    }

    try {
        const { accountId } = await getOrCreateConnectedAccount(req.user.id);
        const frontendBase = getFrontendBase();

        const url = await createOnboardingLink(accountId, {
            refreshUrl: `${frontendBase}/dashboard.html?stripe_refresh=1`,
            returnUrl: `${frontendBase}/dashboard.html?stripe_return=1`
        });

        res.json({ url });
    } catch (err) {
        console.error("Stripe connect onboard error:", err);
        res.status(500).json({ error: err.message || "Kunne ikke starte Stripe-tilkobling." });
    }
});

router.post("/checkout/plan", auth, requireRole(["startup"]), async (req, res) => {
    if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe er ikke konfigurert i dette miljøet ennå." });
    }

    try {
        const result = await createCheckoutSessionForStartupPlan({
            userId: req.user.id,
            frontendBase: getFrontendBase()
        });

        if (!result.ok) {
            return res.status(result.code).json({ error: result.error });
        }

        res.json({ url: result.url });
    } catch (err) {
        console.error("Stripe plan checkout session error:", err);
        res.status(500).json({ error: "Kunne ikke starte betaling." });
    }
});

router.post("/checkout/par-value/:requestId(\\d+)", auth, requireRole(["investor"]), async (req, res) => {
    if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe er ikke konfigurert i dette miljøet ennå." });
    }

    try {
        const result = await createCheckoutSessionForParValue({
            requestId: req.params.requestId,
            investorId: req.user.id,
            frontendBase: getFrontendBase()
        });

        if (!result.ok) {
            return res.status(result.code).json({ error: result.error });
        }

        res.json({ url: result.url });
    } catch (err) {
        console.error("Stripe par-value checkout session error:", err);
        res.status(500).json({ error: "Kunne ikke starte betaling." });
    }
});

router.post("/checkout/:agreementId(\\d+)", auth, requireRole(["investor"]), async (req, res) => {
    if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe er ikke konfigurert i dette miljøet ennå." });
    }

    try {
        const result = await createCheckoutSessionForAgreement({
            agreementId: req.params.agreementId,
            investorId: req.user.id,
            frontendBase: getFrontendBase()
        });

        if (!result.ok) {
            return res.status(result.code).json({ error: result.error });
        }

        res.json({ url: result.url });
    } catch (err) {
        console.error("Stripe checkout session error:", err);
        res.status(500).json({ error: "Kunne ikke starte betaling." });
    }
});

export default router;
