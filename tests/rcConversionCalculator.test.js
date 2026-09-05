import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRcConversions, calculateRcConversion } from "../utils/rcConversionCalculator.js";

/*
  The RC follows the SLIP-style architecture: the investor pays the Investment
  Amount when entering the RC, and on exercise pays only the aggregate par value
  as the new cash contribution. The Investment Amount is never set off against
  the subscription obligation — it is accounted for through the share count:

    RC Shares  = Investment Amount / (Share Price - Par Value)
    Par Amount = RC Shares * Par Value
*/

const BASE_SHARES = 1000;

// The cap alone determines the price for this trigger type, so cap = price * 1000.
const base = {
  trigger_type: "ownership_change",
  capitalization_base_share_count: BASE_SHARES,
  nominal_value_per_share: 1
};

const atPrice = (price) => ({ valuation_cap: price * BASE_SHARES });

test("share count is derived from Share Price less Par Value", () => {
  // Share Price 10, Par 1 -> investment covers 9 per share.
  const result = calculateRcConversion({
    ...base,
    investment_amount: 50000,
    ...atPrice(10)
  });

  assert.equal(result.share_price, 10);
  assert.equal(result.conversion_share_count, Math.floor(50000 / 9)); // 5555
  assert.equal(result.par_amount, 5555);
  assert.equal(result.share_capital_increase, 5555);
  assert.equal(result.share_premium, 0, "exercise contribution is exactly par, so no premium");
});

test("investor's total economic price per share equals Share Price", () => {
  const investment = 50000;
  const result = calculateRcConversion({
    ...base,
    investment_amount: investment,
    ...atPrice(10)
  });

  const totalPaid = result.investment_amount_applied + result.par_amount;
  const pricePerShare = totalPaid / result.conversion_share_count;
  assert.equal(Math.round(pricePerShare * 100) / 100, 10);
});

test("par amount is the only cash due on exercise, and no claim remains", () => {
  const result = calculateRcConversion({
    ...base,
    investment_amount: 20000,
    nominal_value_per_share: 0.01,
    ...atPrice(5)
  });

  // 20000 / (5 - 0.01) = 4008.01... -> 4008 shares
  assert.equal(result.conversion_share_count, 4008);
  assert.equal(result.par_amount, 40.08);
  assert.equal(result.share_premium, 0);
  // Nothing in the result asserts a residual claim or a set-off amount.
  assert.equal(result.setoff_amount, undefined);
  assert.equal(result.remaining_rc_claim, undefined);
});

test("a low par value keeps the exercise payment small", () => {
  const result = calculateRcConversion({
    ...base,
    investment_amount: 20000,
    nominal_value_per_share: 0.01,
    ...atPrice(2)
  });

  const ratio = result.par_amount / 20000;
  assert.ok(ratio < 0.01, `par amount should be a small fraction of the investment, was ${ratio}`);
});

test("a high par value relative to price produces a large par amount", () => {
  const result = calculateRcConversion({
    ...base,
    investment_amount: 50000,
    nominal_value_per_share: 100,
    ...atPrice(150)
  });

  // 50000 / 50 = 1000 shares, par amount 100 000 — twice the investment.
  assert.equal(result.conversion_share_count, 1000);
  assert.equal(result.par_amount, 100000);
});

test("Share Price equal to Par Value is refused with a structured error", () => {
  assert.throws(
    () => calculateRcConversion({
      ...base,
      investment_amount: 50000,
      nominal_value_per_share: 10,
      ...atPrice(10)
    }),
    (err) => err.code === "SHARE_PRICE_NOT_ABOVE_PAR"
  );
});

test("Share Price below Par Value is refused rather than producing invalid shares", () => {
  assert.throws(
    () => calculateRcConversion({
      ...base,
      investment_amount: 50000,
      nominal_value_per_share: 10,
      ...atPrice(4)
    }),
    (err) => err.code === "SHARE_PRICE_NOT_ABOVE_PAR"
  );
});

test("Share Price just above Par Value still computes", () => {
  const result = calculateRcConversion({
    ...base,
    investment_amount: 50000,
    nominal_value_per_share: 1,
    ...atPrice(1.01)
  });

  assert.equal(result.conversion_share_count, Math.floor(50000 / 0.01));
  assert.ok(result.par_amount > 0);
});

test("share count rounds down to whole shares", () => {
  const result = calculateRcConversion({
    ...base,
    investment_amount: 1000,
    nominal_value_per_share: 1,
    ...atPrice(4) // investment covers 3 per share
  });

  assert.equal(result.conversion_share_count, 333);
  assert.ok(result.rounding_difference > 0, "leftover investment is reported, not silently dropped");
});

test("rejects non-positive investment, par value and capitalization", () => {
  assert.throws(() => calculateRcConversion({ ...base, investment_amount: 0, ...atPrice(10) }));
  assert.throws(() => calculateRcConversion({ ...base, investment_amount: 1000, nominal_value_per_share: 0, ...atPrice(10) }));
  assert.throws(() => calculateRcConversion({ ...base, investment_amount: 1000, capitalization_base_share_count: 0, ...atPrice(10) }));
});

test("valuation cap applies when it prices lower than the round", () => {
  const result = calculateRcConversion({
    ...base,
    trigger_type: "new_priced_round",
    investment_amount: 50000,
    valuation_cap: 1000000,      // 1 000 000 / 1000 shares = 1000 per share
    priced_round_share_price: 5000,
    discount_percent: 10
  });

  assert.equal(result.share_price, 1000, "cap price wins over the higher round price");
});

test("a discount only applies on a new priced round", () => {
  // Same cap and discount, two trigger types. On a priced round the discount can
  // win; on any other trigger the cap alone sets the price.
  const shared = {
    ...base,
    investment_amount: 50000,
    valuation_cap: 10000000,     // 10 000 per share
    priced_round_share_price: 5000,
    discount_percent: 20
  };

  const pricedRound = calculateRcConversion({ ...shared, trigger_type: "new_priced_round" });
  assert.equal(pricedRound.discount_price, 4000, "20 % off the 5 000 round price");
  assert.equal(pricedRound.share_price, 4000, "the discount beats the cap here");

  const ownershipChange = calculateRcConversion({ ...shared, trigger_type: "ownership_change" });
  assert.equal(ownershipChange.discount_price, null, "no discount outside a priced round");
  assert.equal(ownershipChange.share_price, 10000, "the cap alone sets the price");
});

test("a trigger other than a priced round requires a valuation cap", () => {
  assert.throws(() => calculateRcConversion({
    ...base,
    trigger_type: "ownership_change",
    investment_amount: 50000,
    discount_percent: 20
  }));
});

test("the same trigger prices every investor in the round identically", () => {
  const terms = { ...base, ...atPrice(10) };
  const small = calculateRcConversion({ ...terms, investment_amount: 9000 });
  const large = calculateRcConversion({ ...terms, investment_amount: 90000 });

  assert.equal(small.share_price, large.share_price);
  assert.equal(small.conversion_share_count, 1000);
  assert.equal(large.conversion_share_count, 10000);
  assert.equal(large.par_amount, small.par_amount * 10);
});

test("aggregate totals sum par amounts and share capital increase across investors", () => {
  const a = calculateRcConversion({ ...base, investment_amount: 50000, ...atPrice(10) });
  const b = calculateRcConversion({ ...base, investment_amount: 25000, ...atPrice(10) });

  const totals = aggregateRcConversions([
    { ...a, investment_amount: 50000 },
    { ...b, investment_amount: 25000 }
  ]);

  assert.equal(totals.total_investment_amount, 75000);
  assert.equal(totals.total_conversion_share_count, a.conversion_share_count + b.conversion_share_count);
  assert.equal(totals.total_par_amount, a.par_amount + b.par_amount);
  assert.equal(totals.total_share_capital_increase, totals.total_par_amount);
  assert.equal(totals.total_share_premium, 0);
});
