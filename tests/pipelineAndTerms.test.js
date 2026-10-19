import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_INVITEE_RELATION,
  INVITEE_RELATIONS,
  PIPELINE_STAGES,
  derivePipelineStage,
  normalizeInviteeInput,
  summarizePipeline
} from "../utils/invitePipeline.js";
import { CURRENT_TERMS_VERSION, hasAcceptedTerms } from "../utils/legalTerms.js";
import {
  assertConfirmedTarget,
  assertLocalDatabase,
  isLocalDatabaseHost
} from "../utils/dbSafety.js";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

/* ------------------------------------------------------------ pipeline */

test("each invite is for one named person", () => {
  assert.equal(normalizeInviteeInput({}).ok, false, "a nameless link is refused");
  assert.equal(normalizeInviteeInput({ inviteeName: " K " }).ok, false, "one letter is not a name");
  assert.equal(normalizeInviteeInput({ inviteeName: "x".repeat(121) }).ok, false);

  const invitee = normalizeInviteeInput({ inviteeName: "  Kari   Nordmann ", relation: "venner_familie" });
  assert.deepEqual(invitee, { ok: true, name: "Kari Nordmann", relation: "venner_familie" });
});

test("an unknown relation falls back to 'annet' instead of being stored as typed", () => {
  const invitee = normalizeInviteeInput({ inviteeName: "Ola", relation: "<script>" });
  assert.equal(invitee.relation, DEFAULT_INVITEE_RELATION);
  assert.ok(Object.hasOwn(INVITEE_RELATIONS, invitee.relation));
});

test("the pipeline stage follows what actually happened, furthest step first", () => {
  assert.equal(derivePipelineStage({}), "invitert");
  assert.equal(derivePipelineStage({ first_opened_at: "2026-10-01" }), "apnet");
  assert.equal(derivePipelineStage({ first_opened_at: "2026-10-01", claimed_by_user_id: 7 }), "registrert");
  assert.equal(derivePipelineStage({ claimed_by_user_id: 7, agreement_status: "Pending Signatures" }), "signering");
  assert.equal(derivePipelineStage({ claimed_by_user_id: 7, agreement_status: "Awaiting Payment" }), "betaling");
  assert.equal(derivePipelineStage({ claimed_by_user_id: 7, agreement_status: "Active RC" }), "aktiv");
  assert.equal(derivePipelineStage({ claimed_by_user_id: 7, agreement_status: "Cancelled" }), "avbrutt");
});

test("the pipeline summary counts every stage, including empty ones", () => {
  const counts = summarizePipeline([
    { stage: "invitert" }, { stage: "invitert" }, { stage: "aktiv" }, { stage: "avbrutt" }
  ]);
  for (const { key } of PIPELINE_STAGES) assert.ok(Object.hasOwn(counts, key));
  assert.equal(counts.invitert, 2);
  assert.equal(counts.aktiv, 1);
  assert.equal(counts.avbrutt, 1);
  assert.equal(counts.betaling, 0);
});

test("invite creation requires a name and the pipeline is only for the round's own startup", () => {
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  assert.match(inviteRoutes, /normalizeInviteeInput\(req\.body \|\| \{\}\)/);
  assert.match(inviteRoutes, /INSERT INTO rc_invites \(round_id, token, invitee_name, invitee_relation\)/);
  assert.match(inviteRoutes, /"\/pipeline\/:roundId",\s*auth,\s*requireRole\(\["startup"\]\)/);
  assert.match(inviteRoutes, /Number\(round\.startup_id\) !== Number\(req\.user\.id\)/);
});

test("an invite that already led to an agreement cannot be revoked", () => {
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  const revoke = inviteRoutes.slice(inviteRoutes.indexOf('"/revoke/:inviteId"'));
  assert.match(revoke, /findAgreementForClaimedInvite\(pool, invite\)/);
  assert.ok(
    revoke.indexOf("findAgreementForClaimedInvite") < revoke.indexOf("DELETE FROM rc_invites"),
    "the agreement check must run before the delete"
  );
});

test("the startup previewing its own link does not count as the invitee opening it", () => {
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  assert.match(
    inviteRoutes,
    /if \(Number\(viewingUser\?\.id\) !== Number\(invite\.startup_id\)\) \{\s*await markInviteOpened/
  );
});

test("returning to your own invite keeps the original claim time", () => {
  const inviteClaim = read("backend/utils/inviteClaim.js");
  assert.match(inviteClaim, /claimed_at = COALESCE\(claimed_at, NOW\(\)\)/);
});

/* --------------------------------------------------------------- terms */

test("only an explicit true counts as accepting the terms", () => {
  assert.equal(hasAcceptedTerms({ acceptTerms: true }), true);
  for (const value of [undefined, null, false, "true", 1, "on"]) {
    assert.equal(hasAcceptedTerms({ acceptTerms: value }), false, `${String(value)} is not acceptance`);
  }
  assert.match(CURRENT_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("both doors into an account require and record terms acceptance", () => {
  const auth = read("backend/controllers/authController.js");
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");

  assert.match(auth, /if \(!hasAcceptedTerms\(req\.body\)\)/);
  assert.match(auth, /terms_accepted_at, terms_version/);

  const send = inviteRoutes.slice(inviteRoutes.indexOf('"/access-code/send/:token"'), inviteRoutes.indexOf('"/access-code/verify/:token"'));
  const verify = inviteRoutes.slice(inviteRoutes.indexOf('"/access-code/verify/:token"'));
  assert.match(send, /hasAcceptedTerms\(req\.body\)/);
  assert.match(verify, /hasAcceptedTerms\(req\.body\)/);
  assert.match(verify, /terms_accepted_at, terms_version/);
});

test("the signup forms send the acceptance and link to the terms", () => {
  const investPage = read("frontend/invest.html");
  const investScript = read("frontend/invest.js");
  const registerPage = read("frontend/register.html");
  const sharedScript = read("frontend/script.js");

  assert.match(investPage, /id="investorAcceptTerms"/);
  assert.match(investScript, /JSON\.stringify\(\{ name, email, password, acceptTerms \}\)/);
  assert.match(registerPage, /id="startupAcceptTerms"/);
  assert.match(sharedScript, /allowRoleCheckFallback, acceptTerms \}/);

  for (const page of [investPage, registerPage]) {
    assert.match(page, /href="vilkar\.html"/);
    assert.match(page, /href="personvern\.html"/);
  }
});

test("the terms and privacy pages carry the version the backend records", () => {
  const version = CURRENT_TERMS_VERSION;
  assert.match(read("frontend/vilkar.html"), new RegExp(`versjon ${version}`));
  assert.match(read("frontend/personvern.html"), new RegExp(`versjon ${version}`));
});

test("the terms state that Raisium is software, not a party, adviser or holder of funds", () => {
  const terms = read("frontend/vilkar.html");
  assert.match(terms, /Ikke avtalepart/);
  assert.match(terms, /Ikke markedsplass/);
  assert.match(terms, /Ikke rådgiver/);
  assert.match(terms, /Holder ikke penger/);
  assert.match(terms, /bare å invitere personer selskapet allerede har en relasjon til/);
});

/* --------------------------------------------------------- operations */

test("local-only scripts refuse a remote database unless told otherwise", () => {
  assert.equal(isLocalDatabaseHost("127.0.0.1"), true);
  assert.equal(isLocalDatabaseHost("localhost"), true);
  assert.equal(isLocalDatabaseHost("novara-novara.e.aivencloud.com"), false);

  const remote = { DB_HOST: "novara-novara.e.aivencloud.com", DB_NAME: "defaultdb" };
  assert.throws(() => assertLocalDatabase("bootstrap", { argv: [], env: remote }), /lokal database/);
  assert.doesNotThrow(() => assertLocalDatabase("bootstrap", { argv: ["--allow-remote"], env: remote }));
  assert.doesNotThrow(() => assertLocalDatabase("bootstrap", { argv: [], env: { DB_HOST: "127.0.0.1" } }));
});

test("the destructive cleanup script needs the exact database named", () => {
  const env = { DB_HOST: "db.example", DB_NAME: "defaultdb" };
  assert.throws(() => assertConfirmedTarget("clean", { argv: [], env }), /--confirm=defaultdb@db\.example/);
  assert.throws(() => assertConfirmedTarget("clean", { argv: ["--confirm=other@db.example"], env }));
  assert.doesNotThrow(() => assertConfirmedTarget("clean", { argv: ["--confirm=defaultdb@db.example"], env }));

  assert.match(read("backend/scripts/cleanNonAdminLaunchData.js"), /assertConfirmedTarget\("cleanNonAdminLaunchData"\)/);
  assert.match(read("backend/scripts/bootstrapLocalDb.js"), /assertLocalDatabase\("db:bootstrap:local"/);
});

test("legacy tokens without issuer and audience are refused by default", () => {
  assert.match(read("backend/utils/authToken.js"), /process\.env\.ALLOW_LEGACY_JWT \|\| "false"/);
});

test("production refuses to boot with a weak JWT secret", () => {
  const server = read("backend/server.js");
  assert.match(server, /process\.env\.JWT_SECRET\.length < 32/);
});

test("Telegram alerts carry no names, e-mail addresses or free text", () => {
  for (const file of [
    "backend/controllers/authController.js",
    "backend/controllers/adminController.js",
    "backend/routes/conversionRoutes.js"
  ]) {
    const source = read(file);
    let index = source.indexOf("sendTelegramAdminAlert(\"");
    while (index !== -1) {
      const call = source.slice(index, source.indexOf("]", index));
      assert.doesNotMatch(call, /E-post:|Navn:|Fra:|Melding:/, `${file} sends personal data to Telegram`);
      index = source.indexOf("sendTelegramAdminAlert(\"", index + 1);
    }
  }
});

test("every page links to the terms and the privacy policy", () => {
  const frontendDir = path.join(root, "frontend");
  const pagesWithFooter = fs.readdirSync(frontendDir)
    .filter((file) => file.endsWith(".html"))
    .filter((file) => read(`frontend/${file}`).includes("site-footer-links"));

  assert.ok(pagesWithFooter.length > 10);
  for (const page of pagesWithFooter) {
    const source = read(`frontend/${page}`);
    assert.match(source, /href="vilkar\.html"/, `${page} is missing the terms link`);
    assert.match(source, /href="personvern\.html"/, `${page} is missing the privacy link`);
  }
});

test("there is exactly one way to create an invite, and it requires a name", () => {
  const sources = ["routes", "controllers", "utils"].flatMap((dir) =>
    fs.readdirSync(path.join(root, "backend", dir))
      .filter((file) => file.endsWith(".js"))
      .map((file) => ({ file: `${dir}/${file}`, source: read(`backend/${dir}/${file}`) }))
  );
  const inserts = sources.filter(({ source }) => /INSERT INTO (?:rc_invites|emission_invites)\b/.test(source));
  assert.deepEqual(inserts.map(({ file }) => file), ["routes/rcInviteRoutes.js"]);
  assert.doesNotMatch(read("backend/routes/emissionRoutes.js"), /\/invite"/);
});

test("every payment column the Stripe flow writes is created on boot", async () => {
  const { PAYMENT_COLUMNS } = await import("../utils/paymentSchema.js");
  const stripePayments = read("backend/utils/stripePayments.js");
  const stripeConnect = read("backend/utils/stripeConnect.js");
  const has = (table, column) => PAYMENT_COLUMNS[table]?.some(([name]) => name === column);

  for (const column of ["stripe_checkout_session_id", "stripe_payment_intent_id", "stripe_paid_at"]) {
    assert.match(stripePayments, new RegExp(column));
    for (const table of ["rc_agreements", "conversion_par_value_requests", "startup_plan_subscriptions"]) {
      assert.ok(has(table, column), `${table}.${column} is never created`);
    }
  }
  for (const column of ["stripe_account_id", "stripe_charges_enabled", "stripe_payouts_enabled", "stripe_onboarded_at"]) {
    assert.match(stripeConnect, new RegExp(column));
    assert.ok(has("companies", column), `companies.${column} is never created`);
  }
  assert.ok(has("rc_agreements", "payment_method"));
  assert.match(read("backend/server.js"), /await ensurePaymentSchema\(\);/);
});
