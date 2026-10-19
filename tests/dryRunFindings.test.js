/*
  Regressions found in the pre-live dry run on 2026-10-18 (PRE_LIVE_DRY_RUN.md),
  each pinned so it cannot quietly return.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { amendArticlesShareCapital, splitArticles } from "../utils/articlesAmendment.js";
import { parseArticlesText } from "../utils/articlesParser.js";
import { RESERVATION_TTL_MINUTES } from "../utils/capacityReservation.js";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const ARTICLES = `VEDTEKTER FOR EKSEMPEL AS
Org.nr. 937 565 658
Sist endret 8. april 2026
§ 1 Foretaksnavn
Selskapets foretaksnavn er Eksempel AS.
§ 2 Forretningskommune
Selskapets forretningskommune er Lillestrøm.
§ 3 Virksomhet
Selskapets virksomhet er utvikling, drift og salg av programvare, og det som står i forbindelse med
dette.
§ 4 Aksjekapital
Selskapets aksjekapital er NOK 40 000, fordelt på 40 000 aksjer, hver pålydende NOK 1.
§ 5 Styre
Selskapets styre skal ha fra ett til tre medlemmer.
§ 6 Signatur
Selskapets firma tegnes av styrets leder alene.
§ 7 Generalforsamling
Den ordinære generalforsamlingen skal behandle godkjenning av årsregnskapet.
§ 8 Aksjeoverdragelse
Erverv av aksjer er betinget av samtykke fra styret. Aksjeeierne har forkjøpsrett.`;

const AMEND = {
  current: { shareCapital: 40000, shareCount: 40000, parValue: 1 },
  next: { shareCapital: 44160, shareCount: 44160 },
  companyName: "EKSEMPEL AS",
  orgnr: "937565658",
  amendedDate: "18. oktober 2026"
};

const plain = (html) => html.replace(/<[^>]+>/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");

/* ------------------------------------------------------------ articles */

test("updated articles keep every clause and change only the share capital figures", () => {
  const result = amendArticlesShareCapital(ARTICLES, AMEND);
  assert.equal(result.ok, true, result.error);
  const text = plain(result.html);

  for (const clause of [
    "Selskapets forretningskommune er Lillestrøm.",
    "Selskapets virksomhet er utvikling, drift og salg av programvare, og det som står i forbindelse med dette.",
    "Selskapets firma tegnes av styrets leder alene.",
    "Erverv av aksjer er betinget av samtykke fra styret. Aksjeeierne har forkjøpsrett."
  ]) {
    assert.ok(text.includes(clause), `kept: ${clause}`);
  }
  assert.ok(text.includes("Selskapets aksjekapital er NOK 44 160, fordelt på 44 160 aksjer, hver pålydende NOK 1."));
  assert.ok(!text.includes("40 000"), "no figure from before the increase is left");
  assert.ok(text.includes("Sist endret 18. oktober 2026"));
  assert.equal(splitArticles(ARTICLES).sections.length, 8);
});

test("updated articles are not generated when the uploaded articles disagree with the confirmed basis", () => {
  const result = amendArticlesShareCapital(ARTICLES, { ...AMEND, current: { shareCapital: 30000, shareCount: 30000, parValue: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /bekreftede aksjegrunnlaget/);
});

test("updated articles are not generated when the capital clause cannot be found exactly once", () => {
  assert.equal(amendArticlesShareCapital(ARTICLES.replace("§ 4 Aksjekapital\n", "").replace(/Selskapets aksjekapital[^\n]+/, ""), AMEND).ok, false);
  const twice = `${ARTICLES}\n§ 9 Aksjekapital\nSelskapets aksjekapital er NOK 40 000, fordelt på 40 000 aksjer, hver pålydende NOK 1.`;
  assert.equal(amendArticlesShareCapital(twice, AMEND).ok, false);
  assert.equal(amendArticlesShareCapital("", AMEND).ok, false, "a scanned PDF has no text to amend");
});

test("a clause written without a heading is amended in place", () => {
  const inline = "VEDTEKTER FOR TEST AS\n§ 1 Selskapets navn er Test AS.\n§ 2 Selskapets aksjekapital er kr 40 000 fordelt på 40 000 aksjer, hver\npålydende kr 1,-.";
  const result = amendArticlesShareCapital(inline, AMEND);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.capitalSection.after, "Selskapets aksjekapital er kr 44 160 fordelt på 44 160 aksjer, hver pålydende kr 1,-.");
});

test("the template that replaced the company's clauses with stock text is gone", () => {
  assert.equal(fs.existsSync(path.join(root, "backend/utils/updatedArticlesBuilder.js")), false);
  assert.equal(fs.existsSync(path.join(root, "backend/templates/vedtekter-template.html")), false);
  assert.doesNotMatch(read("backend/routes/conversionRoutes.js"), /følger det som er registrert for selskapet/);
});

test("the parser reads a share capital followed by a comma, and the clause rather than its heading", () => {
  const fields = parseArticlesText(ARTICLES).parsedFields;
  assert.equal(fields.share_capital_amount, 40000);
  assert.equal(fields.share_count, 40000);
  assert.equal(fields.nominal_value, 1);
  assert.equal(fields.company_name, "EKSEMPEL AS");
  assert.equal(fields.municipality, "Lillestrøm");
});

/* ------------------------------------------------------------ par amounts and subscription */

test("par amount requests have one row per investor in every schema that creates the table", () => {
  assert.match(read("backend/scripts/bootstrapLocalDb.js"), /UNIQUE KEY uniq_conversion_agreement \(conversion_event_id, agreement_id\)/);
  const schema = read("backend/utils/conversionSchema.js");
  assert.match(schema, /ensureParValueRequestUniqueKey\(connection\)/, "an existing table without the key gets it on boot");
  assert.match(schema, /ADD UNIQUE KEY uniq_conversion_agreement/);
});

test("par amounts are requested only after the investors have subscribed in the GF protocol", () => {
  const source = read("backend/routes/conversionRoutes.js");
  assert.match(source, /if \(hasParValueRequestsTable && await isGfSubscriptionComplete\(connection, conversion\)\)/);
  assert.match(source, /role: GF_SUBSCRIBER_ROLE/, "each investor signs the protocol as subscriber");
  assert.match(source, /PAR_PAYMENT_DAYS_AFTER_GF/, "the payment deadline runs from the meeting");

  const signing = read("backend/routes/documentRoutes.js");
  assert.match(signing, /BOARD_PROPOSAL_NOT_SIGNED/, "the protocol cannot be signed before the board proposal");
  assert.match(signing, /GF_NOT_SIGNED_BY_MEETING/, "investors subscribe only after the meeting has signed");
  assert.match(signing, /issueParValueNotices\(pool, gfConversion\.id\)/);
});

test("registration readiness requires a par amount request for every investor", () => {
  assert.match(read("backend/routes/conversionRoutes.js"), /Ikke alle investorer har tegnet aksjene i generalforsamlingsprotokollen ennå/);
});

/* ------------------------------------------------------------ payments */

test("a Checkout session closes before the capacity reservation it pays for", () => {
  const source = read("backend/utils/stripePayments.js");
  const minutes = Number(source.match(/const CHECKOUT_SESSION_MINUTES = (\d+)/)[1]);
  assert.ok(minutes >= 30, "Stripe's minimum");
  assert.ok(minutes < RESERVATION_TTL_MINUTES);
  assert.match(source, /expires_at: Math\.floor\(Date\.now\(\) \/ 1000\) \+ CHECKOUT_SESSION_MINUTES \* 60/);
  assert.match(source, /const hold = await holdCapacityForCheckout\(agreement\)/);
});

test("activation sets aside other investors' live reservations", () => {
  assert.match(read("backend/utils/rcPaymentActivation.js"), /getAvailableForAgreement\(connection/);
  assert.match(read("backend/routes/rcAgreementRoutes.js"), /payment_blocked: true/);
});

test("a completed Checkout session is accepted only if it is the one Raisium stored", () => {
  const source = read("backend/utils/stripePayments.js");
  for (const variable of ["payment", "request", "subscription"]) {
    assert.match(source, new RegExp(`\\|\\| ${variable}\\.stripe_checkout_session_id !== session\\.id\\)`));
  }
  assert.match(source, /handlePlanCheckoutSessionCompleted\(session, \{ connectedAccount = null \} = \{\}\) \{\n    if \(connectedAccount\) return;/);
});

test("the webhook accepts both the account and the Connect endpoint's signing secret", () => {
  const server = read("backend/server.js");
  assert.match(server, /process\.env\.STRIPE_WEBHOOK_SECRET, process\.env\.STRIPE_CONNECT_WEBHOOK_SECRET/);
  assert.match(server, /event\.type === "charge\.updated"/);
  assert.match(read("backend/.env.example"), /^STRIPE_CONNECT_WEBHOOK_SECRET=/m);
});

/* ------------------------------------------------------------ access and evidence */

test("a registration awaiting manual review does not get into an existing company", () => {
  const context = read("backend/utils/startupContext.js");
  assert.match(context, /pending_manual_review/);
  assert.equal((context.match(/\$\{ACTIVE_MEMBERSHIP_SQL\}/g) || []).length, 2, "company lookup and same-company check");
  assert.match(read("backend/utils/startupPlanAccess.js"), /return getCompanyForUserWithConnection\(pool, userId\)/);
  assert.match(read("backend/utils/roundActivationReadiness.js"), /Rollen din i selskapet er ikke bekreftet ennå/);
});

test("no route lists every startup that is raising", () => {
  assert.doesNotMatch(read("backend/routes/startupRoutes.js"), /\/raising/);
  assert.doesNotMatch(read("backend/controllers/startupController.js"), /WHERE is_raising=1/);
});

test("signing an RC and locking a document are recorded as evidence", () => {
  const signing = read("backend/routes/documentRoutes.js");
  assert.match(signing, /AUDIT_EVENTS\.RC_SIGNED/);
  assert.match(signing, /AUDIT_EVENTS\.DOCUMENT_LOCKED/);
  assert.match(signing, /AUDIT_EVENTS\.SUBSCRIPTION_COMPLETED/);
  assert.match(read("backend/utils/stripePayments.js"), /AUDIT_EVENTS\.PAR_CONFIRMED/);
});

test("links in e-mails open the agreement page with the parameter it reads", () => {
  const emails = read("backend/utils/notificationEmailFlow.js");
  assert.doesNotMatch(emails, /rc-detail\.html\?id=/);
  assert.match(read("frontend/script.js"), /new URLSearchParams\(window\.location\.search\)\.get\("agreement"\)/);
});

test("the admin script has no default password", () => {
  assert.doesNotMatch(read("backend/scripts/createAdminUser.js"), /ADMIN_PASSWORD \|\| "[^"]+"/);
});

test("the conversion reads the uploaded articles, not the list of rows", () => {
  const source = read("backend/routes/conversionRoutes.js");
  assert.match(source, /const rawArticles = articlesRows\[0\]\?\.\[0\] \|\| null;/);
});
