import assert from "node:assert/strict";
import test from "node:test";
import * as D from "../utils/exactDecimal.js";
import {
  aggregateRcConversions,
  calculateRcConversion,
  CAPITALIZATION_BASIS,
  CAPITALIZATION_BASIS_TYPE,
  RC_CALCULATION_VERSION,
  RC_ROUNDING_METHOD
} from "../utils/rcConversionCalculator.js";

/*
  One precision rule, everywhere.

  The share price derived from a valuation cap is a rational number — NOK
  1,000,000 over 30,000 shares is exactly 100/3, not 33.33. Rounding it to øre
  before dividing the investment by it moves the raw share count, and near a
  whole-share boundary that hands the investor a share they did not pay for.

  So: exact arithmetic all the way to one rounding, floor to a whole share, and
  the par amount computed only after that. The 33.33 an investor sees is a
  display value, and these tests keep the two apart.
*/

const canonical = (overrides = {}) => calculateRcConversion({
  investment_amount: 10000,
  valuation_cap: 1000000,
  trigger_type: "time_elapsed",
  capitalization_base_share_count: 30000,
  nominal_value_per_share: 1,
  ...overrides
});

/* -------------------------------------------------- exact decimal primitives */

test("exact arithmetic represents thirds and hundredths without loss", () => {
  const third = D.divide(D.fromNumber(1000000), D.fromNumber(30000));
  assert.equal(D.toExactString(third, 12), "33.333333333333");
  assert.equal(D.toRoundedNumber(third, 2), 33.33);

  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
  const sum = D.add(D.fromNumber(0.1), D.fromNumber(0.2));
  assert.equal(D.toExactString(sum), "0.3");
  assert.equal(D.toRoundedNumber(sum, 2), 0.3);
});

test("floor is exact, including on values just below an integer", () => {
  assert.equal(D.floorToInteger(D.rational(30000n, 97n)), 309n);
  assert.equal(D.floorToInteger(D.fromNumber(309.999999)), 309n);
  assert.equal(D.floorToInteger(D.fromNumber(310)), 310n);
});

/* --------------------------------------------- no intermediate display rounding */

test("the share price is not rounded before the share count is derived", () => {
  const result = canonical();

  // What a person sees.
  assert.equal(result.share_price, 33.33);
  // What it was calculated from.
  assert.equal(result.share_price_exact, "33.333333333333");
  assert.equal(result.share_price_fraction, "100/3");

  // The raw count follows the exact price, not the displayed one.
  const exactRaw = 10000 / (1000000 / 30000 - 1);
  assert.ok(Math.abs(result.raw_share_count - exactRaw) < 1e-9);

  // Had the displayed price been used, the raw count would differ.
  const naiveRaw = 10000 / (33.33 - 1);
  assert.notEqual(Math.round(result.raw_share_count * 1e6), Math.round(naiveRaw * 1e6));
});

test("intermediate rounding would over-allocate, and does not", () => {
  // A case where the two rules genuinely disagree: rounding the price down to
  // 33.33 makes each share look cheaper, so the naive path grants one share too
  // many for an investment the investor has not made.
  const result = calculateRcConversion({
    investment_amount: 99000,
    valuation_cap: 1000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 30000,
    nominal_value_per_share: 1
  });

  const naive = Math.floor(99000 / (33.33 - 1));

  assert.equal(result.final_share_count, 3061, "exact arithmetic");
  assert.equal(naive, 3062, "the rounded-price path over-allocates");
  assert.ok(result.final_share_count < naive);
});

test("the canonical allocation is unchanged by the precision rule", () => {
  const result = canonical();
  assert.equal(result.final_share_count, 309);
  assert.equal(result.par_amount, 309);
});

/* ------------------------------------------------------ rounding, once, at the end */

test("rounding happens once, to whole shares, and is floor", () => {
  const result = canonical();
  assert.equal(result.rounding_method, RC_ROUNDING_METHOD);
  assert.equal(RC_ROUNDING_METHOD, "floor");
  assert.equal(result.final_share_count, Math.floor(result.raw_share_count));
});

test("the par amount is derived from the final whole shares, never from the raw count", () => {
  const result = canonical({ nominal_value_per_share: 0.1 });
  assert.equal(result.par_amount, Math.round(result.final_share_count * 0.1 * 100) / 100);
  assert.notEqual(result.par_amount, Math.round(result.raw_share_count * 0.1 * 100) / 100);
});

/* ---------------------------------------------------------- determinism, replay */

test("prices that cannot be written as a finite decimal still calculate deterministically", () => {
  // 1/3, 1/7 and 1/11 of a krone per share.
  for (const [cap, shares] of [[1000000, 30000], [700000, 70000 * 3], [1100000, 33000]]) {
    const runs = Array.from({ length: 5 }, () =>
      calculateRcConversion({
        investment_amount: 12345,
        valuation_cap: cap,
        trigger_type: "time_elapsed",
        capitalization_base_share_count: shares,
        nominal_value_per_share: 1
      })
    );
    runs.forEach((run) => assert.deepEqual(run, runs[0]));
  }
});

test("small investments, tiny par values and large caps all stay exact", () => {
  const tinyPar = calculateRcConversion({
    investment_amount: 500,
    valuation_cap: 250000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 1000000,
    nominal_value_per_share: 0.01
  });
  assert.ok(tinyPar.final_share_count > 0);
  assert.equal(tinyPar.par_amount, Math.round(tinyPar.final_share_count * 0.01 * 100) / 100);

  const bigCap = calculateRcConversion({
    investment_amount: 1000000,
    valuation_cap: 5000000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 30000,
    nominal_value_per_share: 1
  });
  assert.ok(Number.isSafeInteger(bigCap.final_share_count));
});

test("a value sitting exactly on a whole-share boundary does not gain a share", () => {
  // Investment exactly 1000 x (price - par): the raw count is a whole number,
  // and floor must leave it alone rather than dropping one.
  const result = calculateRcConversion({
    investment_amount: 9000,
    valuation_cap: 10000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 1000000,
    nominal_value_per_share: 1
  });
  assert.equal(result.share_price, 10);
  assert.equal(result.raw_share_count, 1000);
  assert.equal(result.final_share_count, 1000);
});

test("a frozen calculation replays exactly from its own recorded inputs", () => {
  const first = canonical();
  const replayed = calculateRcConversion({
    investment_amount: first.investment_amount,
    valuation_cap: first.valuation_cap,
    discount_percent: first.discount_percent,
    trigger_type: first.trigger_type,
    priced_round_share_price: first.priced_round_share_price,
    capitalization_base_share_count: first.capitalization_denominator,
    nominal_value_per_share: first.par_value_per_share
  });
  assert.deepEqual(replayed, first);
  assert.equal(first.calculation_version, RC_CALCULATION_VERSION);
});

/* -------------------------------------------------- capitalization denominator */

test("the denominator is issued shares only, and says so", () => {
  assert.equal(CAPITALIZATION_BASIS_TYPE, "ISSUED_SHARES_ONLY");
  assert.deepEqual(CAPITALIZATION_BASIS.included_instrument_categories, ["issued_shares"]);

  for (const excluded of [
    "unissued_option_pool", "granted_options", "other_rc_agreements",
    "convertible_instruments", "warrants", "subscription_rights"
  ]) {
    assert.ok(
      CAPITALIZATION_BASIS.excluded_instrument_categories.includes(excluded),
      `${excluded} must be excluded from the denominator`
    );
  }
});

test("an unrelated option plan does not enter the denominator", () => {
  // A company with 30,000 issued shares and, separately, a 5,000-share option
  // pool. The pool is not issued share capital, so it must not dilute the
  // denominator — that would be a different economic deal.
  const issuedOnly = canonical({ capitalization_base_share_count: 30000 });
  const fullyDiluted = canonical({ capitalization_base_share_count: 35000 });

  assert.equal(issuedOnly.capitalization_denominator, 30000);
  assert.equal(issuedOnly.capitalization_basis_type, "ISSUED_SHARES_ONLY");

  // Including the pool would price shares lower and hand out more of them.
  assert.ok(fullyDiluted.final_share_count > issuedOnly.final_share_count);
  assert.equal(issuedOnly.final_share_count, 309);
});

test("every investor in a round is priced off the same denominator", () => {
  const investors = [5000, 10000, 25000, 60000].map((amount) => canonical({ investment_amount: amount }));

  investors.forEach((investor) => {
    assert.equal(investor.capitalization_denominator, 30000);
    assert.equal(investor.share_price_fraction, "100/3");
    assert.equal(investor.capitalization_basis_type, CAPITALIZATION_BASIS_TYPE);
  });

  const totals = aggregateRcConversions(
    investors.map((investor, i) => ({ ...investor, investment_amount: [5000, 10000, 25000, 60000][i] }))
  );
  assert.equal(totals.total_investment_amount, 100000);
  assert.equal(totals.total_par_amount, totals.total_conversion_share_count);
});
