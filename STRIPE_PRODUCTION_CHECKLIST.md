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

## Before anything else

0. **Deploy the current backend first.** The columns the Stripe flow writes to
   (`companies.stripe_account_id`, `rc_agreements.stripe_checkout_session_id`,
   `stripe_payment_intent_id`, `stripe_paid_at`, `payment_method` and the same
   on par amount requests and plan subscriptions) were never created by any
   migration in the repository. `utils/paymentSchema.js` now adds whichever
   are missing on boot. Check the Render log after deploy: the service must
   start without errors before any live payment is attempted.

   On Render, also set:
   - `NODE_ENV=production`. Without it CORS accepts dev origins and the JWT
     strength check does not run.
   - Health Check Path: `/api/ready`. It checks the database, not just that
     the process is up.

## What remains

1. **Production API keys** — set `STRIPE_SECRET_KEY` to the live secret key
   (`sk_live_…`) in the Render environment. Restart the service.

2. **Two live webhook endpoints.** RC investments and par amounts are direct
   charges on the company's connected account, so Stripe reports them as
   *Connect* events. Plan payments are made to Raisium's own account and are
   reported as *account* events. A Stripe endpoint receives one kind or the
   other, never both, so in the Stripe Dashboard (live mode) add both, pointing
   at the same URL:

   ```
   https://<backend-host>/api/stripe/webhook
   ```

   - one listening to events on **Your account**;
   - one listening to events on **Connected accounts**.

   With only the first, no investor payment is ever confirmed: the money
   reaches the company but every RC stays in "Awaiting Payment". `stripe
   listen` forwards both kinds with one secret, so local testing does not show
   this.

3. **Webhook signing secrets.** Copy each endpoint's signing secret
   (`whsec_…`) to Render: the account endpoint's into `STRIPE_WEBHOOK_SECRET`,
   the Connect endpoint's into `STRIPE_CONNECT_WEBHOOK_SECRET`. The server
   accepts an event signed with either. With neither set the endpoint answers
   `503 Stripe webhook not configured`.

4. **Event subscriptions.** Subscribe both endpoints to:

   - `checkout.session.completed` and `checkout.session.async_payment_succeeded`
     (confirm RC investments, par amounts and plans);
   - `checkout.session.expired` and `checkout.session.async_payment_failed`
     (release the investor's hold on round capacity);
   - `account.updated` (Connect endpoint: whether the company can take card
     payments; Stripe can switch this off mid-round when it asks the company
     for more verification);
   - `charge.updated` (Connect endpoint: Stripe's fee and the net amount, which
     Stripe settles a few seconds after the payment).

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
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the endpoint for Raisium's own account (plan payments). |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the endpoint for connected accounts (RC investments, par amounts). Without it no investor payment is confirmed. |
