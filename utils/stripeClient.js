import { createHash } from "crypto";
import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

export const stripe = stripeSecretKey
    ? new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" })
    : null;

export function isStripeConfigured() {
    return Boolean(stripe);
}

/*
  Idempotency keys are scoped to the Stripe account, not to the database. Keys
  built from row ids alone collided whenever two databases shared one Stripe
  account (local and staging on the same test keys, or a rebuilt database):
  Stripe answered with the other database's session, already paid. The
  database's identity is part of the key.
*/
const idempotencyNamespace = createHash("sha256")
    .update(`${process.env.DB_HOST || ""}/${process.env.DB_PORT || ""}/${process.env.DB_NAME || ""}`)
    .digest("hex")
    .slice(0, 10);

export function stripeIdempotencyKey(...parts) {
    return ["raisium", idempotencyNamespace, ...parts].join(":").slice(0, 255);
}
