import pool from "../config/db.js";
import { stripe, stripeIdempotencyKey } from "./stripeClient.js";
import { activateRcAgreementPayment } from "./rcPaymentActivation.js";
import { sendRcPaymentConfirmedEmail, sendStripePaymentReceivedStartupEmail } from "./notificationEmailFlow.js";
import { getCompanyForUser } from "./startupPlanAccess.js";
import { sendTelegramAdminAlert } from "./telegramNotifier.js";
import { releaseReservationForAgreement, reserveCapacity, RESERVATION_TTL_MINUTES } from "./capacityReservation.js";
import { syncEmissionRoundAvailability } from "./emissionRoundState.js";
import { AUDIT_EVENTS } from "./auditLogger.js";
import { enqueueCriticalAuditEvent } from "./auditOutbox.js";
import { syncConfirmationRequestsLater } from "./paymentConfirmations.js";

export function paymentMatches(session, expectedAmountNok) {
    return session?.payment_status === "paid"
        && String(session.currency || "").toLowerCase() === "nok"
        && Number(session.amount_total) === Math.round(Number(expectedAmountNok) * 100);
}

async function getReusableCheckoutSession(sessionId, requestOptions = {}) {
    if (!sessionId) return null;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {}, requestOptions);
        return session.status === "open" && session.url ? session : null;
    } catch (error) {
        console.warn("Stripe checkout lookup failed; creating a replacement session:", error?.code || error?.message);
        return null;
    }
}

function checkoutIdempotencyKey(scope, id, previousSessionId) {
    return stripeIdempotencyKey(scope, id, previousSessionId || "initial");
}

function runAfterWebhook(task, label) {
    setImmediate(() => {
        Promise.resolve().then(task).catch((error) => {
            console.error(`Stripe post-webhook ${label} failed:`, error);
        });
    });
}

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

/*
  A Checkout session must close before the capacity it pays for is released.
  Sessions used to stay open for Stripe's default 24 hours while the
  reservation lapsed after 45 minutes, so an investor could pay for a place
  another investor had since taken: Stripe captured the money and Raisium could
  not activate the agreement. Now the hold is renewed (or taken again, if there
  is still room) when checkout starts, and the session expires first.
*/
const CHECKOUT_SESSION_MINUTES = 31; // Stripe's minimum is 30
if (CHECKOUT_SESSION_MINUTES >= RESERVATION_TTL_MINUTES) {
    throw new Error("A Checkout session must expire before the capacity reservation it pays for.");
}

export async function holdCapacityForCheckout(agreement) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const availability = await syncEmissionRoundAvailability(connection, agreement.round_id, { lock: true });
        const reservation = await reserveCapacity(connection, {
            roundId: agreement.round_id,
            investorId: agreement.investor_id,
            amount: agreement.investment_amount,
            agreementId: agreement.id,
            remainingCapacity: availability?.remainingCapacity ?? 0
        });
        if (!reservation.ok) {
            await connection.rollback();
            return {
                ok: false,
                error: reservation.code === "capacity_exceeded"
                    ? "Runden ble fulltegnet før betalingen din ble registrert, så avtalen kan ikke betales. Ikke overfør penger. Du kan avbryte investeringen."
                    : reservation.error
            };
        }
        await connection.commit();
        return { ok: true };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/*
  Stripe sets a direct charge's balance transaction asynchronously, usually a
  few seconds after checkout.session.completed (it arrives as charge.updated).
  Looking it up once, at completion, found nothing and the fee was never
  recorded. So it is retried for a while, and charge.updated tries again.
*/
const FEE_TABLES = ["rc_agreements", "conversion_par_value_requests"];
const FEE_RETRY_DELAYS_MS = [0, 5000, 20000, 60000];

function recordFeeSplitWhenAvailable(table, rowId, paymentIntentId, stripeAccountId, attempt = 0) {
    if (!FEE_TABLES.includes(table) || !rowId || !paymentIntentId || !stripeAccountId) return;
    const timer = setTimeout(async () => {
        try {
            const split = await fetchStripeFeeSplit(paymentIntentId, stripeAccountId);
            if (split) {
                await pool.query(
                    `UPDATE ${table} SET stripe_fee_amount = ?, stripe_net_amount = ? WHERE id = ? AND stripe_fee_amount IS NULL`,
                    [split.feeAmount, split.netAmount, rowId]
                );
            } else if (attempt + 1 < FEE_RETRY_DELAYS_MS.length) {
                recordFeeSplitWhenAvailable(table, rowId, paymentIntentId, stripeAccountId, attempt + 1);
            }
        } catch (error) {
            console.error("Stripe fee split could not be recorded:", error);
        }
    }, FEE_RETRY_DELAYS_MS[attempt]);
    timer.unref?.();
}

export async function handleChargeUpdated(charge, { connectedAccount = null } = {}) {
    if (!connectedAccount || !charge?.payment_intent || !charge.balance_transaction) return;
    for (const table of FEE_TABLES) {
        const [rows] = await pool.query(
            `SELECT id FROM ${table} WHERE stripe_payment_intent_id = ? AND stripe_fee_amount IS NULL LIMIT 1`,
            [charge.payment_intent]
        );
        if (rows.length) recordFeeSplitWhenAvailable(table, rows[0].id, charge.payment_intent, connectedAccount);
    }
}

export async function createCheckoutSessionForAgreement({ agreementId, investorId, frontendBase }) {
    const [rows] = await pool.query(
        `
        SELECT a.id, a.rc_id, a.round_id, a.status, a.investment_amount, a.investor_id,
               a.stripe_checkout_session_id,
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
        return { ok: false, code: 400, error: "Selskapet kan ikke ta imot kortbetaling akkurat nå. Betal med bankoverføring, eller prøv igjen senere." };
    }

    const hold = await holdCapacityForCheckout(agreement);
    if (!hold.ok) {
        return { ok: false, code: 409, error: hold.error };
    }

    const stripeOptions = { stripeAccount: agreement.stripe_account_id };
    const reusableSession = await getReusableCheckoutSession(agreement.stripe_checkout_session_id, stripeOptions);
    if (reusableSession) return { ok: true, url: reusableSession.url };

    const session = await stripe.checkout.sessions.create(
        {
            mode: "payment",
            expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_MINUTES * 60,
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
        {
            ...stripeOptions,
            idempotencyKey: checkoutIdempotencyKey("agreement", agreementId, agreement.stripe_checkout_session_id)
        }
    );

    await pool.query(
        `UPDATE rc_agreements SET payment_method = 'stripe', stripe_checkout_session_id = ? WHERE id = ?`,
        [session.id, agreementId]
    );

    return { ok: true, url: session.url };
}

/*
  Every Checkout session is created by Raisium and its id stored before the
  investor is redirected, so a completed session is only accepted when it is
  that stored session. A session merely carrying the right metadata could have
  been created by anyone holding the connected account's own API keys.
*/
export async function handleCheckoutSessionCompleted(session) {
    const agreementId = session.metadata?.rc_agreement_id;
    if (!agreementId) {
        return;
    }

    const [paymentRows] = await pool.query(
        `SELECT investment_amount, stripe_checkout_session_id
         FROM rc_agreements WHERE id = ? LIMIT 1`,
        [agreementId]
    );
    const payment = paymentRows[0];
    if (!payment
        || !paymentMatches(session, payment.investment_amount)
        || payment.stripe_checkout_session_id !== session.id) {
        console.error("Stripe webhook rejected agreement payment mismatch", { agreementId, sessionId: session.id });
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
            syncConfirmationRequestsLater({ roundId: result.agreement.round_id });

            runAfterWebhook(async () => {
                const [companyRows] = await pool.query(
                    `SELECT c.stripe_account_id
                     FROM rc_agreements a
                     JOIN company_memberships cm ON cm.user_id = a.startup_id
                     JOIN companies c ON c.id = cm.company_id
                     WHERE a.id = ? LIMIT 1`,
                    [agreementId]
                );
                recordFeeSplitWhenAvailable("rc_agreements", agreementId, session.payment_intent, companyRows[0]?.stripe_account_id);
                await Promise.allSettled([
                    sendRcPaymentConfirmedEmail({
                        investorEmail: result.agreement.investor_email,
                        startupName: result.agreement.startup_name || "selskapet",
                        amount: result.agreement.investment_amount,
                        agreementId
                    }),
                    sendStripePaymentReceivedStartupEmail({
                        startupEmail: result.agreement.startup_email,
                        investorName: result.agreement.investor_name,
                        investorEmail: result.agreement.investor_email,
                        amount: result.agreement.investment_amount,
                        agreementId
                    })
                ]);
            }, "agreement enrichment");
        }

        if (!result.ok) {
            // Stripe has already taken the money and it sits in the company's
            // account, but there is no RC behind it. Someone has to refund it.
            console.error("Stripe webhook: could not activate agreement", agreementId, result.error);
            runAfterWebhook(() => sendTelegramAdminAlert("Betaling mottatt, men avtalen kunne ikke aktiveres", [
                `Avtale-ID: ${agreementId}`,
                `Stripe-økt: ${session.id}`,
                `Årsak: ${result.error}`,
                "Beløpet må refunderes til investoren fra selskapets Stripe-konto."
            ]), "unactivated payment alert");
        }
    } finally {
        connection.release();
    }
}

export async function handleCheckoutSessionFailed(session) {
    const agreementId = session.metadata?.rc_agreement_id;
    if (!agreementId) return;

    // Only the agreement's current session may release its hold. An older
    // session expiring after the investor has started a new one must not
    // take the place away from the payment in progress.
    const [[agreement]] = await pool.query(
        "SELECT stripe_checkout_session_id FROM rc_agreements WHERE id = ? LIMIT 1",
        [agreementId]
    );
    if (!agreement || agreement.stripe_checkout_session_id !== session.id) return;

    const connection = await pool.getConnection();
    try {
        await releaseReservationForAgreement(
            connection,
            agreementId,
            session.status === "expired" ? "stripe_session_expired" : "stripe_payment_failed"
        );
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
               pr.stripe_checkout_session_id,
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
        return { ok: false, code: 400, error: "Selskapet kan ikke ta imot kortbetaling akkurat nå. Betal med bankoverføring, eller prøv igjen senere." };
    }

    const stripeOptions = { stripeAccount: request.stripe_account_id };
    const reusableSession = await getReusableCheckoutSession(request.stripe_checkout_session_id, stripeOptions);
    if (reusableSession) return { ok: true, url: reusableSession.url };

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
        {
            ...stripeOptions,
            idempotencyKey: checkoutIdempotencyKey("par", requestId, request.stripe_checkout_session_id)
        }
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
        `SELECT pr.id, pr.status, pr.par_value_amount, pr.stripe_checkout_session_id, c.stripe_account_id
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

    if (!paymentMatches(session, request.par_value_amount)
        || request.stripe_checkout_session_id !== session.id) {
        console.error("Stripe webhook rejected par-value payment mismatch", { requestId, sessionId: session.id });
        return;
    }

    // Idempotent: a redelivered webhook must not rewrite the confirmation
    // timestamp of a payment that is already recorded.
    const [update] = await pool.query(
        `UPDATE conversion_par_value_requests
         SET status = 'paid_confirmed', paid_confirmed_at = NOW(),
             stripe_payment_intent_id = ?, stripe_paid_at = NOW()
         WHERE id = ? AND paid_confirmed_at IS NULL`,
        [session.payment_intent || null, requestId]
    );

    if (!update.affectedRows) {
        return;
    }

    const [[details]] = await pool.query(
        `SELECT pr.agreement_id, pr.investor_id, pr.reference, pr.conversion_event_id, ce.startup_id, ce.round_id
         FROM conversion_par_value_requests pr
         JOIN conversion_events ce ON ce.id = pr.conversion_event_id
         WHERE pr.id = ?`,
        [requestId]
    );
    await enqueueCriticalAuditEvent(pool, AUDIT_EVENTS.PAR_CONFIRMED, {
        startupId: details?.startup_id ?? null,
        roundId: details?.round_id ?? null,
        agreementId: details?.agreement_id ?? null,
        investorId: details?.investor_id ?? null,
        actorRole: "system",
        paymentReference: details?.reference || null,
        metadata: { conversion_event_id: details?.conversion_event_id ?? null, amount: request.par_value_amount, confirmed_via: "stripe", stripe_session: session.id }
    });

    recordFeeSplitWhenAvailable("conversion_par_value_requests", requestId, session.payment_intent, request.stripe_account_id);
    syncConfirmationRequestsLater({ conversionId: details?.conversion_event_id ?? null });
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

    const reusableSession = await getReusableCheckoutSession(subscription.stripe_checkout_session_id);
    if (reusableSession) return { ok: true, url: reusableSession.url };

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
    }, {
        idempotencyKey: checkoutIdempotencyKey("plan", subscription.id, subscription.stripe_checkout_session_id)
    });

    await pool.query(
        `UPDATE startup_plan_subscriptions SET stripe_checkout_session_id = ? WHERE id = ?`,
        [session.id, subscription.id]
    );

    return { ok: true, url: session.url };
}

// Stripe (via webhook) activates the plan the same way an admin's manual
// "confirm payment" does — no human confirmation step needed for Stripe-paid plans.
// Plan payments are made to Raisium's own account. The same metadata on a
// session in a connected account is the company paying itself, not Raisium.
export async function handlePlanCheckoutSessionCompleted(session, { connectedAccount = null } = {}) {
    if (connectedAccount) return;
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

    if (!paymentMatches(session, subscription.final_price_nok)
        || subscription.stripe_checkout_session_id !== session.id) {
        console.error("Stripe webhook rejected plan payment mismatch", { subscriptionId, sessionId: session.id });
        return;
    }

    const [update] = await pool.query(
        `UPDATE startup_plan_subscriptions
         SET status = 'active', activation_source = 'stripe',
             starts_at = NOW(), expires_at = ?, activated_at = NOW(),
             stripe_payment_intent_id = ?, stripe_paid_at = NOW()
         WHERE id = ? AND status <> 'active'`,
        [null, session.payment_intent || null, subscriptionId]
    );

    if (!update.affectedRows) return;

    runAfterWebhook(() => sendTelegramAdminAlert("Startup-plan betalt via Stripe", [
        `Subscription ID: ${subscriptionId}`,
        `Selskap-ID: ${subscription.company_id}`,
        `Plan: ${subscription.plan_code}`,
        `Beløp: ${subscription.final_price_nok} kr`
    ]), "plan notification");
}
