import pool from "../config/db.js";
import { stripe } from "./stripeClient.js";
import { getCompanyForUserWithConnection } from "./startupContext.js";

// Standard connected accounts: the company gets its own full Stripe
// relationship/dashboard and is billed directly by Stripe for processing.
// Raisium never touches the money — Stripe settles straight to the
// company's own bank account. See conversation notes on why Standard
// (not Custom/Express with platform-held funds) is the right model here.
export async function getOrCreateConnectedAccount(userId) {
    const company = await getCompanyForUserWithConnection(pool, userId);
    if (!company?.company_id) {
        throw new Error("Fant ikke selskap for brukeren.");
    }

    const [rows] = await pool.query(
        "SELECT stripe_account_id FROM companies WHERE id = ? LIMIT 1",
        [company.company_id]
    );

    const existingAccountId = rows[0]?.stripe_account_id;
    if (existingAccountId) {
        return { company, accountId: existingAccountId };
    }

    const account = await stripe.accounts.create({
        type: "standard",
        country: "NO",
        business_type: "company",
        company: company.orgnr ? { registration_number: company.orgnr } : undefined,
        business_profile: company.company_name ? { name: company.company_name } : undefined
    });

    await pool.query(
        "UPDATE companies SET stripe_account_id = ? WHERE id = ?",
        [account.id, company.company_id]
    );

    return { company, accountId: account.id };
}

export async function createOnboardingLink(accountId, { refreshUrl, returnUrl }) {
    const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding"
    });

    return accountLink.url;
}

export async function refreshConnectedAccountStatus(companyId, accountId) {
    const account = await stripe.accounts.retrieve(accountId);

    await pool.query(
        `UPDATE companies
         SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?,
             stripe_onboarded_at = CASE WHEN ? THEN COALESCE(stripe_onboarded_at, NOW()) ELSE stripe_onboarded_at END
         WHERE id = ?`,
        [account.charges_enabled ? 1 : 0, account.payouts_enabled ? 1 : 0, account.charges_enabled ? 1 : 0, companyId]
    );

    return {
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted)
    };
}

export async function getConnectStatusForUser(userId) {
    const company = await getCompanyForUserWithConnection(pool, userId);
    if (!company?.company_id) {
        return { connected: false, chargesEnabled: false, payoutsEnabled: false };
    }

    const [rows] = await pool.query(
        "SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled FROM companies WHERE id = ? LIMIT 1",
        [company.company_id]
    );

    const row = rows[0];
    if (!row?.stripe_account_id) {
        return { connected: false, chargesEnabled: false, payoutsEnabled: false };
    }

    // Live-refresh from Stripe so the badge reflects reality even if the
    // account.updated webhook hasn't arrived yet (e.g. in local dev).
    const status = await refreshConnectedAccountStatus(company.company_id, row.stripe_account_id);

    return { connected: true, accountId: row.stripe_account_id, ...status };
}
