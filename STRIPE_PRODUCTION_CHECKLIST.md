# Stripe — remaining production tasks

Never commit secrets. Everything below is set as environment variables on
Render, not in the repository.

The payment **architecture** is already correct and needs no code change:

- Confirmation is server-side only. `POST /api/stripe/webhook` is registered
  before `express.json()` so it sees the raw body, and every event is verified
  with `stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET`.
  Returning from a redirect URL never marks anything paid.
- Both handlers are idempotent. A redelivered `checkout.session.completed`
  returns early on an already-active agreement, and an already-confirmed par
  payment is not rewritten.
- Investment Amounts and Par Amounts are charged as Stripe Connect **direct
  charges** (`{ stripeAccount }`), so the money goes to the company's connected
  account. Raisium never receives or retains either amount.

## What remains

1. **Production API keys** — set `STRIPE_SECRET_KEY` to the live secret key
   (`sk_live_…`) in the Render environment. Restart the service.

2. **Production webhook endpoint** — in the Stripe Dashboard (live mode), add an
   endpoint pointing at:

   ```
   https://<backend-host>/api/stripe/webhook
   ```

   `stripe listen` is a development tool and does not cover live mode.

3. **Webhook signing secret** — copy the live endpoint's signing secret
   (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` on Render. Without it the endpoint
   answers `503 Stripe webhook not configured` and no payment is ever
   confirmed.

4. **Event subscriptions** — the live endpoint must subscribe to at least:

   - `checkout.session.completed`

   This single event drives all three flows (RC investment, par amount, startup
   plan). Nothing else is currently handled, so subscribing to more events is
   harmless but pointless.

5. **Connect production setup** — each startup must complete Stripe Connect
   onboarding **again in live mode**; a test-mode connected account does not
   carry over. Verify `companies.stripe_account_id` holds a live account id
   before the first real round.

6. **Real payment reconciliation test** — with live keys in place, run one small
   end-to-end payment and confirm:
   - the webhook is received and signature-verified;
   - the RC agreement moves to `Active RC` server-side;
   - `stripe_payment_intent_id`, `stripe_fee_amount` and `stripe_net_amount` are
     populated;
   - the funds land in the **company's** connected account, not Raisium's.

## Environment variables

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Live secret key. Absent ⇒ payments disabled. |
| `STRIPE_WEBHOOK_SECRET` | Live endpoint signing secret. Absent ⇒ webhook returns 503. |
