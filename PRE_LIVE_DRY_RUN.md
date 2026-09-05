# Pre-live dry run — required before accepting real money

Run this once, end to end, against an **isolated scratch database**.

> **Never against production.** Do not simulate investors, payments, triggers,
> conversion or registration on the Aiven production database, and do not alter
> production data. Point `DB_*` at a throwaway database, run
> `npm run db:bootstrap:local`, and create a fresh admin user.

Stripe may stay in test mode for the dry run. The payment *architecture* is
already webhook-authoritative; what the dry run proves is the workflow.

---

## Canonical scenario

| | |
|---|---|
| Company | Example AS |
| Share capital | NOK 30,000 |
| Shares | 30,000 |
| Par value | NOK 1 |
| Round target | NOK 100,000 |
| Valuation cap | NOK 1,000,000 |
| Investors | 10 × NOK 10,000 |
| Long-stop | 24 months |

Expected result at conversion: share price NOK 33.33, **309 shares** and a
**NOK 309** par amount per investor, 3,090 new shares, NOK 3,090 aggregate par
amount, new share capital **NOK 33,090**, 33,090 shares, ownership 0.934 % each
and 9.34 % together. Total historical cash NOK 103,090 — which is *not* the
share capital.

---

## Steps

### Setup
- [ ] Startup registers and completes onboarding.
- [ ] Company data loads from Brønnøysund.
- [ ] Current articles uploaded (a real PDF, on Linux if possible).
- [ ] Share capital, share count and par value are extracted. Note the source
      shown for each: read from the document, AI-assisted, or manual.
- [ ] **Deliberately try to activate before confirming.** Activation must be
      refused.
- [ ] Confirm the share basis. Check the confirmation is recorded with who and
      when.
- [ ] **Enter an inconsistent basis** (30,000 capital / 30,000 shares / par
      0.10). It must be refused, not silently accepted.

### Round
- [ ] Create the round. Long-stop must default to **2 years**.
- [ ] Par preview shows ~NOK 3,090 for the full round and does not warn
      (ratio ≈ 3 %, below the 10 % threshold).
- [ ] **Set the cap to NOK 30,000** so the share price equals par. Activation
      must be blocked with a clear reason. Restore the cap.
- [ ] Activate the round.
- [ ] Confirm an audit row exists for the activation.

### Investors
- [ ] Create 10 invites.
- [ ] Investor 1 opens their invite, signs, pays; the RC becomes Active RC only
      after the webhook, not on returning from the payment page.
- [ ] **Open investor 1's link as investor 2.** It must be refused.
- [ ] Repeat for investors 2–9 (NOK 90,000 committed, NOK 10,000 left).
- [ ] **Two browsers, investors 10 and 11, both request the last NOK 10,000 at
      once.** Exactly one gets a reservation; the other is stopped *before* any
      payment is created.
- [ ] Investor 10 pays. Round total is exactly NOK 100,000.
- [ ] **Investor 11 tries again.** Refused — "Runden er fulltegnet."
- [ ] Abandon a reservation and let it expire (or expire it manually). Capacity
      returns and another investor can then reserve.
- [ ] **Replay a `checkout.session.completed` webhook** for an agreement already
      active. Nothing changes: no duplicate RC, no double-counted investment.

### After the round
- [ ] Round closes. Copy must say the RC round is complete and **no shares have
      been issued**; it must not say "emisjonen er gjennomført".
- [ ] "Veien videre" explains that investors are not yet shareholders and that a
      separate Chapter 10 capital increase follows.
- [ ] Shareholder register contains **no RC investor** at this point.

### Trigger
- [ ] Simulate the 24-month long-stop (adjust the round deadline on the scratch
      database only).
- [ ] Status becomes **triggered**, never "converted".
- [ ] Calculation freezes. Verify 309 shares and NOK 309 per investor.
- [ ] **Change the company's share count, then reload.** The frozen calculation
      must not move.
- [ ] **Trigger again.** No duplicate conversion event is created.

### Chapter 10
- [ ] **Try to generate the board proposal before confirming the chair.** It
      must be refused.
- [ ] Brønnøysund suggests the chair. Confirm it.
- [ ] Board proposal generated. The name in the body matches the signature block.
- [ ] **Log in as a different company user and try to sign as chair.** Locking
      must be refused on the body/signature mismatch.
- [ ] GF protocol generated and signed. Resolution shows 3,090 shares, par NOK 1,
      subscription price NOK 1, capital increase NOK 3,090, **no share premium**.
- [ ] Investors subscribe.
- [ ] Par amount requests issued at NOK 309 each. Confirm the deadline does not
      move on subsequent page loads.
- [ ] Investors pay the par amount. Records stay separate from the year-0
      investment payments.
- [ ] **Replay a par payment webhook.** The confirmation timestamp does not change.
- [ ] Share contribution confirmation completed by the external confirmer.

### Registration
- [ ] **Check readiness with a par amount still unpaid.** Registration is blocked.
- [ ] With everything complete, readiness passes.
- [ ] Updated articles: NOK 33,090 / 33,090 shares / par NOK 1. All unrelated
      clauses preserved.
- [ ] Shareholder register: 33,090 shares total, 309 per RC investor, 0.934 %
      each. No extra ownership for the par amount.
- [ ] Download the package. Six documents, correctly ordered.
- [ ] Complete the conversion. Each RC records `converted_at`,
      `converted_share_count` and `converted_par_amount`.
- [ ] **Complete it again.** Nothing is double-recorded.
- [ ] RC history is still visible to both the investor and the company.

### Evidence
- [ ] `rc_audit_events` holds the full sequence: round created, terms changed,
      activated, invites, reservations, RC generated and signed, investment
      confirmed, trigger, calculation frozen, documents, par payments,
      registration, conversion.
- [ ] No national identity numbers, credentials or card data appear in it.
- [ ] Locked documents still carry their original hash and timestamps.

### Implementation visibility
- [ ] With a trigger older than 45 days and no board proposal, the round shows
      an outstanding action.
- [ ] An investor can report that implementation is outstanding, and it is
      recorded as *reported* — the platform states no conclusion about fault.

---

## Sign-off

- [ ] Every number above matched.
- [ ] No manual SQL was needed at any point in the normal workflow.
- [ ] Scratch database discarded.
