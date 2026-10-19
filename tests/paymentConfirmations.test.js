/*
  Payments go directly to the startup, and a revisor Raisium pays confirms they
  arrived: in year 0 and, as aksjeloven § 10-9 (2) requires, at the capital
  increase. The startup neither finds nor pays a confirmer.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the GF resolution has the share contribution paid directly to the company", () => {
  const gf = read("backend/templates/gfc-template.html");
  assert.match(gf, /innbetales kontant direkte til selskapet/);
  assert.match(gf, /aksjeloven § 10-13 annet ledd/);
});

test("the company no longer names its own confirmer", () => {
  const conversion = read("backend/routes/conversionRoutes.js");
  assert.doesNotMatch(conversion, /thirdPartyEmail: req\.body\.thirdPartyEmail/);
  assert.doesNotMatch(conversion, /capital_confirmation_document_id && freshConversion\.third_party_email/);
});

test("a request opens when payments complete, in year 0 and at conversion", () => {
  assert.match(read("backend/utils/stripePayments.js"), /syncConfirmationRequestsLater\(\{ roundId: result\.agreement\.round_id \}\)/);
  assert.match(read("backend/utils/stripePayments.js"), /syncConfirmationRequestsLater\(\{ conversionId:/);
  assert.match(read("backend/routes/rcAgreementRoutes.js"), /syncConfirmationRequestsLater\(\{ roundId: result\.agreement\.round_id \}\)/);
  assert.match(read("backend/routes/conversionRoutes.js"), /syncConfirmationRequestsLater\(\{ conversionId:/);
  assert.match(read("backend/controllers/emissionController.js"), /syncConfirmationRequestsLater\(\{ roundId: Number\(emissionId\) \}\)/);
});

test("a confirmation is signed only by the confirmer, only once the evidence is complete", () => {
  const module = read("backend/utils/paymentConfirmations.js");
  assert.match(module, /if \(request\.status !== CONFIRMATION_STATUS\.READY\)/);
  assert.match(module, /needsBank && !request\.evidence_document_id/, "bank transfers need a bank statement");
  assert.match(module, /rows\.some\(\(row\) => !row\.paid\)/, "every par amount must be paid");

  const routes = read("backend/routes/confirmationRoutes.js");
  assert.match(routes, /router\.post\("\/:id\(\\\\d\+\)\/claim", auth, requireRole\(\[CONFIRMER_ROLE\]\)/);
  assert.match(routes, /Number\(request\.startup_id\) !== Number\(startupUserId\)/, "a company uploads only for itself");

  assert.match(read("backend/routes/documentRoutes.js"), /completeConfirmationForDocument\(connection, Number\(documentId\)/);
});

test("the confirmer role exists everywhere users are defined", () => {
  assert.match(read("backend/utils/authSchema.js"), /ENUM\('investor','startup','admin','confirmer'\)/);
  assert.match(read("backend/scripts/bootstrapLocalDb.js"), /role ENUM\('investor','startup','admin','confirmer'\)/);
  assert.match(read("backend/utils/documentSchema.js"), /"ROUND_PAYMENT_CONFIRMATION"/);
  assert.doesNotMatch(read("backend/scripts/createConfirmerUser.js"), /CONFIRMER_PASSWORD \|\| "[^"]+"/);
});

test("the confirmer and the company each have a page for it", () => {
  assert.ok(fs.existsSync(path.join(root, "frontend/bekreftelser.html")));
  assert.match(read("frontend/script.js"), /data\.user\?\.role === "confirmer"[\s\S]{0,80}bekreftelser\.html/);
  assert.match(read("frontend/convert.html"), /<script src="confirmation-ui\.js"><\/script>/);
  assert.match(read("frontend/dashboard.html"), /<script src="confirmation-ui\.js"><\/script>/);
  assert.match(read("backend/server.js"), /\/\^\\\/api\\\/confirmations\\\/\\d\+\\\/evidence\$\//, "bank statements may exceed the default body limit");
});

test("the privacy notice and terms name the revisor", () => {
  assert.match(read("frontend/personvern.html"), /Raisiums revisor/);
  assert.match(read("frontend/vilkar.html"), /bekreftes av en revisor Raisium betaler/);
});
