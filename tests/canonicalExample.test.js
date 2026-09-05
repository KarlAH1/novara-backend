import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateRcConversions,
  calculateRcConversion,
  RC_CALCULATION_VERSION,
  RC_ROUNDING_METHOD
} from "../utils/rcConversionCalculator.js";
import { buildParPreview, PAR_AMOUNT_WARNING_RATIO } from "../utils/roundActivationReadiness.js";

/*
  The canonical Raisium example, used as the reference case for the whole model.

    Company before the round   30,000 shares, NOK 30,000 share capital, par NOK 1
    Valuation cap             NOK 1,000,000
    Round                     NOK 100,000 from 10 investors at NOK 10,000 each
    Long-stop                 24 months

  Cap share price is 1,000,000 / 30,000 = NOK 33.33 (to the øre).
  Each investor: 10,000 / (33.33 - 1) = 309.31... -> 309 shares, par amount 309.
*/

const EXISTING_SHARES = 30000;
const EXISTING_CAPITAL = 30000;
const PAR_VALUE = 1;
const VALUATION_CAP = 1000000;
const INVESTORS = 10;
const INVESTMENT_EACH = 10000;

const canonicalInvestor = (overrides = {}) => calculateRcConversion({
  investment_amount: INVESTMENT_EACH,
  valuation_cap: VALUATION_CAP,
  trigger_type: "time_elapsed",
  capitalization_base_share_count: EXISTING_SHARES,
  nominal_value_per_share: PAR_VALUE,
  ...overrides
});

test("canonical: share price is the cap divided by issued shares", () => {
  const result = canonicalInvestor();
  assert.equal(result.share_price, 33.33);
  assert.equal(result.capitalization_denominator, EXISTING_SHARES);
  assert.equal(result.capitalization_basis, "issued_shares_current_articles");
});

test("canonical: each investor is allocated 309 shares and owes NOK 309", () => {
  const result = canonicalInvestor();

  assert.equal(result.rounding_method, RC_ROUNDING_METHOD);
  assert.ok(result.raw_share_count > 309 && result.raw_share_count < 310);
  assert.equal(result.final_share_count, 309);
  assert.equal(result.conversion_share_count, 309);
  assert.equal(result.par_amount, 309);
  assert.equal(result.share_capital_increase, 309);
  assert.equal(result.share_premium, 0);
});

test("canonical: the par amount buys no extra shares and adds no ownership", () => {
  const result = canonicalInvestor();

  // Paying the par amount must not enlarge the allocation. Re-running the
  // calculation with investment + par must not produce more than 309 shares
  // for the investor's actual entitlement.
  assert.equal(result.final_share_count, 309);

  // Total cash from the investor is investment + par, but ownership is set by
  // the share count alone.
  const totalCash = INVESTMENT_EACH + result.par_amount;
  assert.equal(totalCash, 10309);

  // The economic price per share is the Share Price: the applied investment
  // plus the par amount, over the shares actually allocated.
  const appliedPerShare =
    (result.investment_amount_applied + result.par_amount) / result.final_share_count;
  assert.equal(Math.round(appliedPerShare * 100) / 100, result.share_price);

  // Rounding down leaves a small unapplied remainder of the investment, which
  // is reported rather than silently converted into extra shares.
  assert.equal(
    Math.round((result.investment_amount_applied + result.rounding_difference) * 100) / 100,
    INVESTMENT_EACH
  );
  assert.ok(result.rounding_difference < result.share_price);
});

test("canonical: ten investors reconcile to the new share capital and share count", () => {
  const investors = Array.from({ length: INVESTORS }, () => canonicalInvestor());
  const totals = aggregateRcConversions(
    investors.map((item) => ({ ...item, investment_amount: INVESTMENT_EACH }))
  );

  assert.equal(totals.total_investment_amount, 100000);
  assert.equal(totals.total_conversion_share_count, 3090);
  assert.equal(totals.total_par_amount, 3090);
  assert.equal(totals.total_share_capital_increase, 3090);
  assert.equal(totals.total_share_premium, 0);

  const newShareCount = EXISTING_SHARES + totals.total_conversion_share_count;
  const newShareCapital = EXISTING_CAPITAL + totals.total_par_amount;

  assert.equal(newShareCount, 33090);
  assert.equal(newShareCapital, 33090);

  // The invariant the updated Articles must satisfy.
  assert.equal(newShareCapital, newShareCount * PAR_VALUE);

  // Total cash the company has historically received is NOT the share capital.
  const totalCashReceived = totals.total_investment_amount + totals.total_par_amount;
  assert.equal(totalCashReceived, 103090);
  assert.notEqual(newShareCapital, totalCashReceived);
});

test("canonical: ownership is computed on post-conversion shares, not on the cap", () => {
  const result = canonicalInvestor();
  const newShareCount = EXISTING_SHARES + (result.final_share_count * INVESTORS);

  const perInvestor = result.final_share_count / newShareCount;
  assert.ok(Math.abs(perInvestor - 0.00934) < 0.0001, `per investor was ${perInvestor}`);

  const allInvestors = (result.final_share_count * INVESTORS) / newShareCount;
  assert.ok(Math.abs(allInvestors - 0.0934) < 0.001, `all investors held ${allInvestors}`);

  // The naive (and wrong) answer would be investment / valuation cap = 1 %.
  assert.notEqual(Math.round(perInvestor * 10000), Math.round((INVESTMENT_EACH / VALUATION_CAP) * 10000));
});

test("canonical: the snapshot alone reproduces the result", () => {
  const first = canonicalInvestor();

  assert.equal(first.calculation_version, RC_CALCULATION_VERSION);

  // Feed the snapshot's own recorded inputs back in.
  const second = calculateRcConversion({
    investment_amount: first.investment_amount,
    valuation_cap: first.valuation_cap,
    discount_percent: first.discount_percent,
    trigger_type: first.trigger_type,
    priced_round_share_price: first.priced_round_share_price,
    capitalization_base_share_count: first.capitalization_denominator,
    nominal_value_per_share: first.par_value_per_share
  });

  assert.deepEqual(second, first);
});

test("canonical: the pre-round preview matches what conversion will produce", () => {
  const preview = buildParPreview({
    valuationCap: VALUATION_CAP,
    shareCount: EXISTING_SHARES,
    parValue: PAR_VALUE,
    exampleInvestment: INVESTMENT_EACH
  });

  assert.equal(preview.blocked, false);
  assert.equal(preview.share_price, 33.33);
  assert.equal(preview.rc_shares, 309);
  assert.equal(preview.par_amount, 309);
  assert.ok(preview.par_amount_ratio < PAR_AMOUNT_WARNING_RATIO);
  assert.equal(preview.warn, false);
});

test("preview blocks a round whose cap prices shares at or below par", () => {
  // 30,000 shares against a NOK 30,000 cap is exactly par.
  const atPar = buildParPreview({
    valuationCap: 30000,
    shareCount: EXISTING_SHARES,
    parValue: PAR_VALUE,
    exampleInvestment: INVESTMENT_EACH
  });

  assert.equal(atPar.blocked, true);
  assert.match(atPar.reason, /pålydende/);
});

test("preview warns when the par amount is a large share of the investment", () => {
  // A high par value relative to the share price makes the later par amount big.
  const preview = buildParPreview({
    valuationCap: 1000000,
    shareCount: 30000,
    parValue: 20,
    exampleInvestment: INVESTMENT_EACH
  });

  assert.equal(preview.blocked, false);
  assert.ok(preview.par_amount_ratio >= PAR_AMOUNT_WARNING_RATIO);
  assert.equal(preview.warn, true);
});
