/*
  The pilot round (2026-10-20): a one-owner AS opening a 25 000 kr round from
  the share basis in Foretaksregisteret, without uploading its articles.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRoundActivationReadiness,
  shareBasisFromRegister
} from "../utils/roundActivationReadiness.js";

const REGISTER_BLOCKER = "Bekreft aksjekapital, antall aksjer og pålydende.";

// Just enough of a mysql2 connection for the readiness check: no articles
// table, one verified member, and the given profile and confirmation.
function fakeConnection({ profile = {}, confirmation = null } = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes("information_schema.TABLES")) {
        return [params[0] === "startup_articles_confirmations" ? [{ 1: 1 }] : []];
      }
      if (sql.includes("company_memberships")) return [[{ verified: 1 }]];
      if (sql.includes("FROM startup_profiles")) return [[profile]];
      if (sql.includes("FROM startup_articles_confirmations")) return [confirmation ? [confirmation] : []];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const PILOT_ROUND = {
  target_amount: 25000,
  valuation_cap: 2000000,
  trigger_period: 2,
  bank_account: "1234.56.78903"
};

test("the register's capital and share count give the par value", () => {
  assert.deepEqual(
    shareBasisFromRegister({ capitalAmount: 40000, capitalShareCount: 40000 }),
    { share_capital_amount: 40000, share_count: 40000, par_value_per_share: 1 }
  );
  assert.equal(shareBasisFromRegister({ capitalAmount: 30000, capitalShareCount: 3000 }).par_value_per_share, 10);
  assert.equal(shareBasisFromRegister({ capitalAmount: 40000 }), null);
  assert.equal(shareBasisFromRegister(null), null);
});

test("before the share basis is confirmed, confirming it is the one thing asked for", async () => {
  const readiness = await checkRoundActivationReadiness(fakeConnection(), 3, PILOT_ROUND);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers, [REGISTER_BLOCKER]);
});

test("a round confirmed from Foretaksregisteret opens without uploaded articles", async () => {
  const readiness = await checkRoundActivationReadiness(
    fakeConnection({
      profile: { nominal_value_per_share: 1, current_share_count: 40000, share_basis_temporary: 0 },
      confirmation: { source: "brreg", share_capital_amount: 40000, share_count: 40000, par_value_per_share: 1 }
    }),
    3,
    PILOT_ROUND
  );
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.ready, true);
});

test("a confirmation from another source still needs the articles", async () => {
  const readiness = await checkRoundActivationReadiness(
    fakeConnection({
      profile: { nominal_value_per_share: 1, current_share_count: 40000, share_basis_temporary: 0 },
      confirmation: { source: "manual", share_capital_amount: 40000, share_count: 40000, par_value_per_share: 1 }
    }),
    3,
    PILOT_ROUND
  );
  assert.ok(readiness.blockers.includes("Gjeldende vedtekter må lastes opp før runden kan åpnes."));
});

test("the par amount warning reads as Norwegian and says how to lower it", async () => {
  const readiness = await checkRoundActivationReadiness(
    fakeConnection({
      profile: { nominal_value_per_share: 1, current_share_count: 40000, share_basis_temporary: 0 },
      confirmation: { source: "brreg", share_capital_amount: 40000, share_count: 40000, par_value_per_share: 1 }
    }),
    3,
    { ...PILOT_ROUND, valuation_cap: 250000 }
  );
  assert.equal(readiness.preview.rc_shares, 4761);
  assert.equal(readiness.warnings.length, 1);
  assert.match(readiness.warnings[0], /ca\. 4 761 kr i aksjeinnskudd/);
  assert.match(readiness.warnings[0], /ca\. 19,0 % av investeringsbeløpet/);
  assert.match(readiness.warnings[0], /høyere valuation cap/);
});
