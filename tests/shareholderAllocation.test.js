import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateShareholders,
  shareCountsForStoredOwners,
  SHAREHOLDER_SOURCE
} from "../utils/shareholderAllocation.js";

/*
  Existing owners must match the company's aksjeeierbok, which counts shares.
  Percentages are accepted as input and converted, and the result must add up
  to the issued shares exactly.
*/

const TOTAL = 40000;
const counts = (r) => r.shareholders.map((s) => s.share_count);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("share counts typed in are kept exactly", () => {
  const r = allocateShareholders([
    { name: "A", share_count: 25000 },
    { name: "B", share_count: 15000 }
  ], TOTAL);
  assert.deepEqual(counts(r), [25000, 15000]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.shareholders.map((s) => s.source), [SHAREHOLDER_SOURCE.SHARES, SHAREHOLDER_SOURCE.SHARES]);
  assert.deepEqual(r.shareholders.map((s) => s.ownership_percent), [62.5, 37.5]);
});

test("whole percentages convert exactly", () => {
  const r = allocateShareholders([
    { name: "A", ownership_percent: 60 },
    { name: "B", ownership_percent: 40 }
  ], TOTAL);
  assert.deepEqual(counts(r), [24000, 16000]);
  assert.equal(r.complete, true);
});

test("rounded thirds still add up to every issued share", () => {
  // 33.33 % three times is 99.99 %: the rounding a founder naturally types.
  const r = allocateShareholders([
    { name: "A", ownership_percent: 33.33 },
    { name: "B", ownership_percent: 33.33 },
    { name: "C", ownership_percent: 33.33 }
  ], TOTAL);
  assert.equal(sum(counts(r)), TOTAL);
  assert.equal(r.complete, true);
  // No one is more than one share away from their exact third.
  counts(r).forEach((c) => assert.ok(Math.abs(c - TOTAL / 3) < 1));
});

test("percentages and share counts can be mixed", () => {
  const r = allocateShareholders([
    { name: "A", share_count: 24000 },
    { name: "B", ownership_percent: 40 }
  ], TOTAL);
  assert.deepEqual(counts(r), [24000, 16000]);
  assert.equal(r.complete, true);
});

test("percentages that do not add up are not stretched to fit", () => {
  // 99.9 % is not a rounding slip of 100 % — something is missing.
  const r = allocateShareholders([
    { name: "A", ownership_percent: 50 },
    { name: "B", ownership_percent: 49.9 }
  ], TOTAL);
  assert.ok(sum(counts(r)) < TOTAL);
  assert.equal(r.complete, false);
  assert.match(r.errors[0], /av 40 000 aksjer|av 40 000 aksjer/);
});

test("more shares than the company has is refused", () => {
  const r = allocateShareholders([
    { name: "A", share_count: 30000 },
    { name: "B", share_count: 20000 }
  ], TOTAL);
  assert.equal(r.complete, false);
  assert.match(r.errors[0], /men selskapet har bare/);
});

test("a holding too small for one whole share is reported", () => {
  const r = allocateShareholders([
    { name: "A", ownership_percent: 99.999 },
    { name: "B", ownership_percent: 0.001 }
  ], 100);
  assert.ok(r.errors.some((e) => /for liten til å gi en hel aksje/.test(e)));
});

test("large companies keep exact totals", () => {
  const r = allocateShareholders([
    { name: "A", ownership_percent: 33.33 },
    { name: "B", ownership_percent: 33.33 },
    { name: "C", ownership_percent: 33.34 }
  ], 1000000);
  assert.deepEqual(counts(r), [333300, 333300, 333400]);
  assert.equal(r.complete, true);
});

test("without a confirmed share count, nothing is invented", () => {
  const r = allocateShareholders([{ name: "A", ownership_percent: 100 }], null);
  assert.equal(r.shareholders[0].share_count, null);
  assert.equal(r.total_shares, null);

  const withShares = allocateShareholders([{ name: "A", share_count: 100 }], null);
  assert.ok(withShares.errors.length > 0, "shares cannot be checked without the company total");
});

test("stored owners use their stored counts", () => {
  assert.deepEqual(
    shareCountsForStoredOwners([
      { shareholder_name: "A", share_count: 24000, ownership_percent: 60 },
      { shareholder_name: "B", share_count: 16000, ownership_percent: 40 }
    ], TOTAL),
    [24000, 16000]
  );
});

test("older rows with only a percentage no longer inflate the last owner", () => {
  // The old rule gave the last owner "the rest", so 50 % + 40 % made the
  // second owner hold 50 %. The shortfall now stays visible instead.
  const result = shareCountsForStoredOwners([
    { shareholder_name: "A", ownership_percent: 50 },
    { shareholder_name: "B", ownership_percent: 40 }
  ], TOTAL);
  assert.deepEqual(result, [20000, 16000]);
});
