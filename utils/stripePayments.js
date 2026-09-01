import pool from "../config/db.js";
import { stripe } from "./stripeClient.js";
import { activateRcAgreementPayment } from "./rcPaymentActivation.js";
import { sendRcPaymentConfirmedEmail, sendStripePaymentReceivedStartupEmail } from "./notificationEmailFlow.js";
import { getCompanyForUser } from "./startupPlanAccess.js";
import { sendTelegramAdminAlert } from "./telegramNotifier.js";

// Direct charges mean Stripe's processing fee is deducted from the connected
// account (the startup), so the amount that actually lands in their bank
// account is lower than the RC investment amount. We record that fee/net
// split here purely for transparency in the UI — it does not change the
// investment amount itself, which is the contractual figure that governs
// share conversion.
async function fetchStripeFeeSplit(paymentIntentId, stripeAccountId) {
    if (!paymentIntentId || !stripeAccountId) {
        return null;
    }

    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
            paymentIntentId,
            { expand: ["latest_charge.balance_transaction"] },
            { stripeAccount: stripeAccountId }
        );

        const balanceTransaction = paymentIntent?.latest_charge?.balance_transaction;
        if (!balanceTransaction) {
            return null;
        }

        return {
            feeAmount: balanceTransaction.fee / 100,
            netAmount: balanceTransaction.net / 100
        };
    } catch (err) {
        console.error("Stripe fee lookup error:", err);
        return null;
    }
}

export async function createCheckoutSessionForAgreement({ agreementId, investorId, frontendBase }) {
    const [rows] = await pool.query(
        `
        SELECT a.id, a.rc_id, a.status, a.investment_amount, a.investor_id,
               c.stripe_account_id, c.stripe_charges_enabled
        FROM rc_agreements a
        JOIN emission_rounds e ON a.round_id = e.id
        JOIN company_memberships cm ON cm.user_id = e.startup_id
        JOIN companies c ON c.id = cm.company_id
        WHERE a.id = ?
        LIMIT 1
        `,
        [agreementId]
    );

    const agreement = rows[0];
    if (!agreement || Number(agreement.investor_id) !== Number(investorId)) {
        return { ok: false, code: 404, error: "Fant ikke avtalen." };
    }

    if (agreement.status !== "Awaiting Payment") {
        return { ok: false, code: 400, error: "Avtalen er ikke klar for betaling." };
    }

    if (!agreement.stripe_account_id || !agreement.stripe_charges_enabled) {
        return { ok: false, code: 400, error: "Selskapet har ikke satt opp betalingsmottak ennå. Betal via bankoverføring i mellomtiden." };
    }

    const session = await stripe.checkout.sessions.create(
        {
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "nok",
                        product_data: { name: `RC-avtale ${agreement.rc_id || `RC-${agreementId}`}` },
                        unit_amount: Math.round(Number(agreement.investment_amount) * 100)
                    },
                    quantity: 1
                }
            ],
            metadata: { rc_agreement_id: String(agreementId) },
            payment_intent_data: {
                metadata: { rc_agreement_id: String(agreementId) }
            },
            success_url: `${frontendBase}/rc-detail.html?agreement=${agreementId}&stripe=success`,
            cancel_url: `${frontendBase}/rc-detail.html?agreement=${agreementId}&stripe=cancelled`
        },
        { stripeAccount: agreement.stripe_account_id }
    );

    await pool.query(
        `UPDATE rc_agreements SET payment_method = 'stripe', stripe_checkout_session_id = ? WHERE id = ?`,
        [session.id, agreementId]
    );

    return { ok: true, url: session.url };
}

export async function handleCheckoutSessionCompleted(session) {
    const agreementId = session.metadata?.rc_agreement_id;
    if (!agreementId) {
        return;
    }

    const connection = await pool.getConnection();
    try {
        const result = await activateRcAgreementPayment(connection, { agreementId });

        if (result.ok && !result.alreadyActive) {
            await pool.query(
                `UPDATE rc_agreements SET stripe_payment_intent_id = ?, stripe_paid_at = NOW() WHERE id = ?`,
                [session.payment_intent || null, agreementId]
            );

            const [companyRows] = await pool.query(
                `SELECT c.stripe_account_id
                 FROM rc_agreements a
                 JOIN company_memberships cm ON cm.user_id = a.startup_id
                 JOIN companies c ON c.id = cm.company_id
                 WHERE a.id = ? LIMIT 1`,
                [agreementId]
            );
            const feeSplit = await fetchStripeFeeSplit(session.payment_intent, companyRows[0]?.stripe_account_id);
            if (feeSplit) {
                await pool.query(
                    `UPDATE rc_agreements SET stripe_fee_amount = ?, stripe_net_amount = ? WHERE id = ?`,
                    [feeSplit.feeAmount, feeSplit.netAmount, agreementId]
                );
            }

            sendRcPaymentConfirmedEmail({
                investorEmail: result.agreement.investor_email,
                startupName: result.agreement.startup_name || "selskapet",
                amount: result.agreement.investment_amount,
                agreementId
            });

            sendStripePaymentReceivedStartupEmail({
                startupEmail: result.agreement.startup_email,
                investorName: result.agreement.investor_name,
                investorEmail: result.agreement.investor_email,
                amount: result.agreement.investment_amount,
                agreementId
            });
        }

        if (!result.ok) {
            console.error("Stripe webhook: could not activate agreement", agreementId, result.error);
        }
    } finally {
        connection.release();
    }
}

// Same Connect direct-charge pattern as createCheckoutSessionForAgreement —
// the par-value amount also goes straight to the startup's own account.
export async function createCheckoutSessionForParValue({ requestId, investorId, frontendBase }) {
    const [rows] = await pool.query(
        `
        SELECT pr.id, pr.status, pr.par_value_amount, pr.reference, pr.investor_id, pr.agreement_id,
               c.stripe_account_id, c.stripe_charges_enabled
        FROM conversion_par_value_requests pr
        JOIN conversion_events ce ON pr.conversion_event_id = ce.id
        JOIN company_memberships cm ON cm.user_id = ce.startup_id
        JOIN companies c ON c.id = cm.company_id
        WHERE pr.id = ?
        LIMIT 1
        `,
        [requestId]
    );

    const request = rows[0];
    if (!request || Number(request.investor_id) !== Number(investorId)) {
        return { ok: false, code: 404, error: "Fant ikke paribeløp-kravet." };
    }

    if (request.status === "paid_confirmed") {
        return { ok: false, code: 400, error: "Paribeløpet er allerede bekreftet betalt." };
    }

    if (!request.par_value_amount) {
        return { ok: false, code: 400, error: "Fant ikke beløp for paribeløpet." };
    }

    if (!request.stripe_account_id || !request.stripe_charges_enabled) {
        return { ok: false, code: 400, error: "Selskapet har ikke satt opp betalingsmottak ennå. Betal via bankoverføring i mellomtiden." };
    }

    const session = await stripe.checkout.sessions.create(
        {
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "nok",
                        product_data: { name: `Paribeløp ${request.reference || `PARI-${requestId}`}` },
                        unit_amount: Math.round(Number(request.par_value_amount) * 100)
                    },
                    quantity: 1
                }
            ],
            metadata: { par_value_request_id: String(requestId) },
            payment_intent_data: {
                metadata: { par_value_request_id: String(requestId) }
            },
            success_url: `${frontendBase}/rc-detail.html?agreement=${request.agreement_id}&stripe=success`,
            cancel_url: `${frontendBase}/rc-detail.html?agreement=${request.agreement_id}&stripe=cancelled`
        },
        { stripeAccount: request.stripe_account_id }
    );

    await pool.query(
        `UPDATE conversion_par_value_requests SET stripe_checkout_session_id = ? WHERE id = ?`,
        [session.id, requestId]
    );

    return { ok: true, url: session.url };
}

// Stripe (via webhook) is the source of truth here too — activates the same
// way the startup's manual "/conversion/par-value/confirm" does.
export async function handleParValueCheckoutSessionCompleted(session) {
    const requestId = session.metadata?.par_value_request_id;
    if (!requestId) {
        return;
    }

    const [rows] = await pool.query(
        `SELECT pr.id, pr.status, c.stripe_account_id
         FROM conversion_par_value_requests pr
         JOIN conversion_events ce ON pr.conversion_event_id = ce.id
         JOIN company_memberships cm ON cm.user_id = ce.startup_id
         JOIN companies c ON c.id = cm.company_id
         WHERE pr.id = ? LIMIT 1`,
        [requestId]
    );
    const request = rows[0];

    if (!request || request.status === "paid_confirmed") {
        return;
    }

    await pool.query(
        `UPDATE conversion_par_value_requests
         SET status = 'paid_confirmed', paid_confirmed_at = NOW(),
             stripe_payment_intent_id = ?, stripe_paid_at = NOW()
         WHERE id = ?`,
        [session.payment_intent || null, requestId]
    );

    const feeSplit = await fetchStripeFeeSplit(session.payment_intent, request.stripe_account_id);
    if (feeSplit) {
        await pool.query(
            `UPDATE conversion_par_value_requests SET stripe_fee_amount = ?, stripe_net_amount = ? WHERE id = ?`,
            [feeSplit.feeAmount, feeSplit.netAmount, requestId]
        );
    }
}

async function getOpenStartupPlanSubscription(companyId) {
    const [rows] = await pool.query(
        `SELECT * FROM startup_plan_subscriptions
         WHERE company_id = ? AND status IN ('payment_required', 'payment_pending')
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [companyId]
    );
    return rows[0] || null;
}

function getNextAnnualExpiry() {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    return next;
}

// Plain Stripe Checkout on Raisium's own account — this money is Raisium's
// own revenue (plan fees), not routed to a startup, so unlike the RC-agreement
// checkout above this does NOT pass a connected `stripeAccount`.
export async function createCheckoutSessionForStartupPlan({ userId, frontendBase }) {
    const company = await getCompanyForUser(userId);
    if (!company?.company_id) {
        return { ok: false, code: 400, error: "Fant ikke selskapet som er koblet til brukeren." };
    }

    const subscription = await getOpenStartupPlanSubscription(company.company_id);
    if (!subscription) {
        return { ok: false, code: 400, error: "Velg en plan før du går videre til betaling." };
    }

    const amount = Number(subscription.final_price_nok || 0);
    if (!amount) {
        return { ok: false, code: 400, error: "Fant ikke pris for planen." };
    }

    const planLabel = subscription.plan_code === "pro" ? "Scale" : "Seed";

    const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
            {
                price_data: {
                    currency: "nok",
                    product_data: { name: `Raisium ${planLabel}-plan` },
                    unit_amount: Math.round(amount * 100)
                },
                quantity: 1
            }
        ],
        metadata: { startup_plan_subscription_id: String(subscription.id) },
        success_url: `${frontendBase}/startup-payment.html?stripe=success`,
        cancel_url: `${frontendBase}/startup-payment.html?stripe=cancelled`
    });

    await pool.query(
        `UPDATE startup_plan_subscriptions SET stripe_checkout_session_id = ? WHERE id = ?`,
        [session.id, subscription.id]
    );

    return { ok: true, url: session.url };
}

// Stripe (via webhook) activates the plan the same way an admin's manual
// "confirm payment" does — no human confirmation step needed for Stripe-paid plans.
export async function handlePlanCheckoutSessionCompleted(session) {
    const subscriptionId = session.metadata?.startup_plan_subscription_id;
    if (!subscriptionId) {
        return;
    }

    const [rows] = await pool.query(
        `SELECT * FROM startup_plan_subscriptions WHERE id = ? LIMIT 1`,
        [subscriptionId]
    );
    const subscription = rows[0];

    if (!subscription || subscription.status === "active") {
        return;
    }

    await pool.query(
        `UPDATE startup_plan_subscriptions
         SET status = 'active', activation_source = 'stripe',
             starts_at = NOW(), expires_at = ?, activated_at = NOW(),
             stripe_payment_intent_id = ?, stripe_paid_at = NOW()
         WHERE id = ?`,
        [getNextAnnualExpiry(), session.payment_intent || null, subscriptionId]
    );

    sendTelegramAdminAlert("Startup-plan betalt via Stripe", [
        `Subscription ID: ${subscriptionId}`,
        `Selskap-ID: ${subscription.company_id}`,
        `Plan: ${subscription.plan_code}`,
        `Beløp: ${subscription.final_price_nok} kr`
    ]);
}
