import assert from "node:assert/strict";
import test from "node:test";
import { buildRoundAvailability } from "../utils/emissionRoundState.js";
import { inviteIsAvailableTo } from "../utils/inviteClaim.js";
import { aggregateRcConversions, calculateRcConversion } from "../utils/rcConversionCalculator.js";

const CANONICAL = {
  investment_amount: 10000,
  valuation_cap: 1000000,
  trigger_type: "time_elapsed",
  capitalization_base_share_count: 30000,
  nominal_value_per_share: 1
};

/* ---------------------------------------------------------------- hard cap */

test("hard cap: a round filled to exactly the target accepts no more", () => {
  const exact = buildRoundAvailability({
    target_amount: 100000,
    committed_amount: 100000,
    open: 1
  });

  assert.equal(exact.remainingCapacity, 0);
  assert.equal(exact.targetReached, true);
  assert.equal(exact.canInvest, false, "investor 11 must be refused");
  assert.equal(exact.status, "TARGET_REACHED");
});

test("hard cap: capacity never goes negative and the last slot is exact", () => {
  const nearlyFull = buildRoundAvailability({
    target_amount: 100000,
    committed_amount: 90000,
    open: 1
  });
  assert.equal(nearlyFull.remainingCapacity, 10000);
  assert.equal(nearlyFull.canInvest, true);

  // 10 000 fits exactly; 10 001 does not.
  assert.ok(10000 <= nearlyFull.remainingCapacity);
  assert.ok(10001 > nearlyFull.remainingCapacity);

  // Over-commitment is reported as zero remaining, never as a negative budget
  // that a later check could read as available room.
  const over = buildRoundAvailability({
    target_amount: 100000,
    committed_amount: 100001,
    open: 1
  });
  assert.equal(over.remainingCapacity, 0);
  assert.equal(over.canInvest, false);
});

test("hard cap: a closed or draft round accepts nothing regardless of capacity", () => {
  for (const round of [
    { target_amount: 100000, committed_amount: 0, open: 0 },
    { target_amount: 100000, committed_amount: 0, open: 1, closed_reason: "manually_closed" },
    { target_amount: 100000, committed_amount: 0, open: 1, closed_reason: "expired" },
    { target_amount: 100000, committed_amount: 0, open: 1, closed_reason: "cancelled" }
  ]) {
    assert.equal(buildRoundAvailability(round).canInvest, false);
  }
});

/* --------------------------------------------------------- single-use invite */

test("an invite is usable once, by the investor who claimed it", () => {
  assert.equal(inviteIsAvailableTo({ claimed_by_user_id: null }, 7), true, "unclaimed is open");
  assert.equal(inviteIsAvailableTo({ claimed_by_user_id: 7 }, 7), true, "the claimant may continue");
  assert.equal(inviteIsAvailableTo({ claimed_by_user_id: 7 }, 8), false, "a forwarded link is refused");
  assert.equal(inviteIsAvailableTo(null, 7), false, "an unknown token is refused");
});

/* ------------------------------------------------- one snapshot, all documents */

test("one calculation snapshot reconciles the articles, the register and the confirmation", () => {
  const investors = Array.from({ length: 10 }, () => calculateRcConversion(CANONICAL));
  const totals = aggregateRcConversions(
    investors.map((i) => ({ ...i, investment_amount: CANONICAL.investment_amount }))
  );

  const parValue = CANONICAL.nominal_value_per_share;
  const oldShareCount = CANONICAL.capitalization_base_share_count;
  const oldShareCapital = oldShareCount * parValue;

  // Updated Articles.
  const newShareCount = oldShareCount + totals.total_conversion_share_count;
  const newShareCapital = oldShareCapital + totals.total_par_amount;
  assert.equal(newShareCapital, newShareCount * parValue);

  // Shareholder register: existing holders plus the new allocations.
  const registerShareTotal =
    oldShareCount + investors.reduce((sum, i) => sum + i.final_share_count, 0);
  assert.equal(registerShareTotal, newShareCount);

  // Share contribution confirmation: the cash contributed equals the increase.
  assert.equal(totals.total_par_amount, newShareCapital - oldShareCapital);
  assert.equal(totals.total_share_capital_increase, totals.total_par_amount);
  assert.equal(totals.total_share_premium, 0);

  // Ownership across the register sums to 100 %.
  const ownership =
    (oldShareCount / newShareCount) +
    investors.reduce((sum, i) => sum + i.final_share_count / newShareCount, 0);
  assert.ok(Math.abs(ownership - 1) < 1e-9);
});

test("the historical cash received is never presented as the share capital", () => {
  const investors = Array.from({ length: 10 }, () => calculateRcConversion(CANONICAL));
  const totals = aggregateRcConversions(
    investors.map((i) => ({ ...i, investment_amount: CANONICAL.investment_amount }))
  );

  const totalCash = totals.total_investment_amount + totals.total_par_amount;
  const capitalIncrease = totals.total_share_capital_increase;

  assert.equal(totalCash, 103090);
  assert.equal(capitalIncrease, 3090);
  assert.notEqual(totalCash, capitalIncrease);

  // The investment amount must never appear as a contribution in the increase.
  assert.ok(capitalIncrease < totals.total_investment_amount);
});

/* ------------------------------------------------------ investors are independent */

test("investors with different amounts are allocated independently and sum correctly", () => {
  const amounts = [5000, 10000, 25000, 60000];
  const results = amounts.map((amount) =>
    calculateRcConversion({ ...CANONICAL, investment_amount: amount })
  );

  results.forEach((result, index) => {
    assert.equal(result.share_price, 33.33, "the same trigger prices everyone alike");
    assert.equal(result.par_amount, result.final_share_count * CANONICAL.nominal_value_per_share);
    assert.equal(
      result.final_share_count,
      Math.floor(amounts[index] / (33.33 - 1))
    );
  });

  const totals = aggregateRcConversions(
    results.map((r, i) => ({ ...r, investment_amount: amounts[i] }))
  );
  assert.equal(totals.total_investment_amount, 100000);
  assert.equal(
    totals.total_conversion_share_count,
    results.reduce((sum, r) => sum + r.final_share_count, 0)
  );
  assert.equal(totals.total_par_amount, totals.total_conversion_share_count);
});

/* ------------------------------------------------------------- money precision */

test("no floating-point subtraction error can cost a share", () => {
  // 1.01 - 1 is 0.010000000000000009 in binary floating point, which floors the
  // share count one short. The calculation runs in integer øre so it cannot.
  const result = calculateRcConversion({
    investment_amount: 50000,
    valuation_cap: 1.01 * 1000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 1000,
    nominal_value_per_share: 1
  });

  assert.equal(result.share_price, 1.01);
  assert.equal(result.final_share_count, 5000000);
  assert.equal(result.par_amount, 5000000);
});

test("the same inputs always produce the same result", () => {
  const runs = Array.from({ length: 25 }, () => calculateRcConversion(CANONICAL));
  runs.forEach((run) => assert.deepEqual(run, runs[0]));
});
