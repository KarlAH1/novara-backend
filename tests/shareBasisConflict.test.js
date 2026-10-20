/*
  Uploaded articles and the profile disagree on the share count (2026-10-20:
  94 000 in the articles, 124 000 in the profile). The review step offers the
  fix next to the problem, so the share-basis blockers are returned on their
  own and say the numbers the way a person reads them.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { checkRoundActivationReadiness } from "../utils/roundActivationReadiness.js";

function connectionWithArticles({ profileShareCount }) {
  const parsed = { share_capital_amount: 94000, share_count: 94000, nominal_value: 1 };
  return {
    async query(sql, params = []) {
      if (sql.includes("information_schema.TABLES")) {
        return [["startup_documents", "startup_articles_confirmations"].includes(params[0]) ? [{ 1: 1 }] : []];
      }
      if (sql.startsWith("SHOW COLUMNS FROM `startup_documents`")) {
        return [[{ Field: "document_type" }, { Field: "file_data" }]];
      }
      if (sql.includes("company_memberships")) return [[{ verified: 1 }]];
      if (sql.includes("FROM startup_profiles")) {
        return [[{ nominal_value_per_share: 1, current_share_count: profileShareCount, share_basis_temporary: 0 }]];
      }
      if (sql.includes("FROM startup_documents")) {
        return [[{ id: 7, parse_status: "parsed_complete", parsed_fields_json: JSON.stringify(parsed) }]];
      }
      if (sql.includes("FROM startup_articles_confirmations")) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const ROUND = { target_amount: 50000, valuation_cap: 500000, trigger_period: 3, bank_account: "1234.56.78911" };

test("a profile that disagrees with the articles is reported with grouped numbers", async () => {
  const readiness = await checkRoundActivationReadiness(connectionWithArticles({ profileShareCount: 124000 }), 3, ROUND);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.includes(
    "Antall aksjer i profilen (124 000) stemmer ikke med gjeldende vedtekter (94 000). Rett opp før runden åpnes."
  ));
  assert.equal(readiness.basis.profile_share_count, 124000);
});

test("the share-basis blockers are returned on their own, and only those", async () => {
  const readiness = await checkRoundActivationReadiness(
    connectionWithArticles({ profileShareCount: 124000 }),
    3,
    { ...ROUND, bank_account: "" }
  );
  assert.deepEqual(readiness.basis_blockers, [
    "Antall aksjer i profilen (124 000) stemmer ikke med gjeldende vedtekter (94 000). Rett opp før runden åpnes.",
    "Aksjekapital, antall aksjer og pålydende må bekreftes mot gjeldende vedtekter før runden kan åpnes."
  ]);
  assert.ok(readiness.blockers.includes("Kontonummer for innbetaling må være satt."));
  assert.ok(!readiness.basis_blockers.includes("Kontonummer for innbetaling må være satt."));
});
