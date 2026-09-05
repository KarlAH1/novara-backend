import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_EVENTS } from "../utils/auditLogger.js";
import { calculateRcConversion, RC_CALCULATION_VERSION } from "../utils/rcConversionCalculator.js";

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(backendDir, rel), "utf8");

/*
  If a dispute arises about an RC round, the answer to "what happened, and when"
  has to come from durable records rather than from log lines that a redeploy
  threw away. These tests pin the events that must be preserved, and pin the
  rules that stop history being rewritten after the fact.
*/

/* ------------------------------------------------------- events preserved */

test("every material lifecycle event has an audit event type", () => {
  const REQUIRED = [
    "ROUND_CREATED", "ROUND_TERMS_CHANGED", "ROUND_ACTIVATED", "ROUND_CLOSED",
    "ARTICLES_UPLOADED", "ARTICLES_EXTRACTED", "ARTICLES_CONFIRMED",
    "INVITE_CREATED", "INVITE_CLAIMED",
    "CAPACITY_RESERVED", "CAPACITY_COMMITTED", "CAPACITY_RELEASED",
    "RC_GENERATED", "RC_SIGNED",
    "INVESTMENT_INITIATED", "INVESTMENT_CONFIRMED",
    "TRIGGER_DETECTED", "CALCULATION_FROZEN",
    "BOARD_PROPOSAL_GENERATED", "GF_GENERATED", "DOCUMENT_SIGNED", "DOCUMENT_LOCKED",
    "SUBSCRIPTION_COMPLETED", "PAR_REQUESTED", "PAR_CONFIRMED",
    "SHARE_CONTRIBUTION_CONFIRMED",
    "REGISTRATION_READINESS_CHECKED", "REGISTRATION_COMPLETED", "CONVERSION_COMPLETED",
    "IMPLEMENTATION_ISSUE_RAISED"
  ];

  for (const key of REQUIRED) {
    assert.ok(AUDIT_EVENTS[key], `missing audit event: ${key}`);
  }
});

test("the audit trail is written to the database, not only to the console", () => {
  const source = read("utils/auditLogger.js");
  assert.match(source, /CREATE TABLE rc_audit_events/);
  assert.match(source, /INSERT INTO rc_audit_events/);
});

test("the audit trail carries the fields a dispute would need", () => {
  const source = read("utils/auditLogger.js");
  for (const column of [
    "event_type", "startup_id", "round_id", "agreement_id", "investor_id",
    "actor_user_id", "actor_role", "previous_status", "new_status",
    "document_id", "document_hash", "calculation_version", "legal_model_version",
    "payment_reference", "trigger_type", "created_at"
  ]) {
    assert.match(source, new RegExp(`\\b${column}\\b`), `audit trail lacks ${column}`);
  }
});

test("identity numbers and credentials are never written to the audit trail", () => {
  const source = read("utils/auditLogger.js");
  assert.match(source, /FORBIDDEN_KEYS/);
  for (const key of ["national_id", "fodselsnummer", "personnummer", "password", "token", "cvc"]) {
    assert.match(source, new RegExp(`"${key}"`), `${key} is not excluded from the audit trail`);
  }
});

test("an audit write failure never rolls back the operation it describes", () => {
  const source = read("utils/auditLogger.js");
  // The insert is wrapped so a logging problem cannot fail a capital increase.
  assert.match(source, /catch \(err\) \{\s*console\.error\("\[audit\] durable write failed:/);
});

/* -------------------------------------------------------- evidence immutability */

test("a locked document is never rewritten in place", () => {
  const source = read("utils/documentSigning.js");
  // Locking stamps a hash over the final content; corrections are new versions.
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /status = 'LOCKED'/);
});

test("a frozen calculation is read back rather than recomputed", () => {
  const source = read("routes/conversionRoutes.js");
  assert.match(source, /readFrozenCalculations/);
  // The freeze only writes where no snapshot exists yet.
  assert.match(source, /JSON_EXTRACT\(calculations_json, '\$\.frozen_at'\) IS NULL/);
});

test("a confirmed par payment is never re-priced", () => {
  const source = read("routes/conversionRoutes.js");
  assert.match(source, /IF\(conversion_par_value_requests\.paid_confirmed_at IS NULL/);
});

test("a confirmed par payment is not re-timestamped by a redelivered webhook", () => {
  const source = read("utils/stripePayments.js");
  assert.match(source, /WHERE id = \? AND paid_confirmed_at IS NULL/);
});

test("conversion completion is recorded once, not on every retry", () => {
  const source = read("routes/conversionRoutes.js");
  assert.match(source, /WHERE id = \? AND converted_at IS NULL/);
});

test("RC history is preserved rather than deleted at conversion", () => {
  const source = read("utils/rcAgreementSchema.js");
  assert.match(source, /converted_at/);
  assert.match(source, /RC history is never deleted/);
});

/* --------------------------------------------------- executed terms never mutate */

test("the terms an RC was signed under are snapshotted onto the agreement", () => {
  const source = read("utils/rcAgreementSchema.js");
  for (const column of [
    "terms_valuation_cap", "terms_discount_rate", "terms_trigger_period_years",
    "terms_par_value_per_share", "terms_capitalization_base_share_count",
    "terms_snapshot_at", "legal_model_version", "calculation_version",
    "agreement_template_version"
  ]) {
    assert.match(source, new RegExp(column), `terms snapshot lacks ${column}`);
  }
});

test("round terms cannot be edited once an investment exists", () => {
  const source = read("controllers/emissionController.js");
  assert.match(source, /Configuration locked after first investment/);
});

test("changing the standard long-stop cannot reach back into a signed RC", () => {
  // A historical agreement signed on a 36-month long-stop keeps 36 months: the
  // period is read from the agreement's own snapshot, not from today's default.
  const source = read("utils/rcAgreementSchema.js");
  assert.match(source, /terms_trigger_period_years/);

  const contract = read("templates/rc-template.html").replace(/<[^>]+>/g, " ");
  assert.match(contract, /perioden som er angitt i Vedlegg 1 for denne avtalen/);
  assert.match(contract, /Perioden er låst ved signering og endres ikke av senere endringer i rundens oppsett/);
});

test("a frozen calculation reproduces exactly from its own recorded inputs", () => {
  const first = calculateRcConversion({
    investment_amount: 10000,
    valuation_cap: 1000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 30000,
    nominal_value_per_share: 1
  });

  assert.equal(first.calculation_version, RC_CALCULATION_VERSION);

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
});
