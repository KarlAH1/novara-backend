import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRcConversions, calculateRcConversion } from "../utils/rcConversionCalculator.js";
import { AUDIT_EVENTS } from "../utils/auditLogger.js";
import {
  buildIdempotencyKey,
  CRITICAL_AUDIT_EVENTS,
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_STATUS
} from "../utils/auditOutbox.js";
import {
  deriveImplementationStatus,
  IMPLEMENTATION_REASON,
  IMPLEMENTATION_STATUS
} from "../utils/rcImplementationStatus.js";
import { EVIDENCE_PACKAGE_TITLE } from "../utils/evidenceExport.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readFrontend = (rel) => fs.readFileSync(path.join(root, "..", "frontend", rel), "utf8");
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const rc = () => plain(read("templates/rc-template.html"));

/* ============================================ change of control: the successor */

test("the company must try to complete the RC before or as part of a transaction", () => {
  const text = rc();
  assert.match(
    text,
    /så langt dette er rettslig og praktisk mulig, sørge for at gjennomføringen av RC-en skjer før eller som ledd i gjennomføringen av den aktuelle transaksjonen/
  );
});

test("if the transaction closes first, the successor must be asked to assume the obligations", () => {
  const text = rc();
  assert.match(
    text,
    /medvirke til at den overtakende eller videreførende enheten uttrykkelig anerkjenner og, der det er nødvendig, overtar de relevante forpliktelsene/
  );
});

test("the successor mechanism is cooperation, never a guarantee about the buyer", () => {
  const text = rc();
  assert.match(text, /Dette er en forpliktelse til å medvirke/);
  assert.match(text, /garanterer ikke for handlinger eller beslutninger hos en motpart de ikke rår over/);
  assert.match(text, /ikke en garanti for at en erverver aksepterer slike vilkår/);
});

test("the transaction forms are covered without assuming a buyer becomes a shareholder", () => {
  const text = rc();
  // Merger, demerger, an asset sale and a liquidation are not share purchases.
  assert.match(text, /fusjon, fisjon, salg av hele eller det vesentligste av virksomheten eller eiendelene, og oppløsning eller avvikling/);
  assert.match(text, /Der en transaksjon ikke innebærer at en erverver blir aksjeeier i Selskapet/);
  assert.match(text, /overtakende eller videreførende enheten/);
});

test("a closing transaction never silently ends the RC", () => {
  const text = rc();
  assert.match(text, /opphører RC-en ikke som følge av transaksjonen/);
  assert.match(text, /Investors rettigheter etter avtalen består/);

  // And the platform has a factual state for exactly this situation.
  assert.equal(
    IMPLEMENTATION_REASON.TRANSACTION_CLOSED_BEFORE_IMPLEMENTATION,
    "transaksjon_sluttfort_for_gjennomforing"
  );
  assert.ok(IMPLEMENTATION_REASON.SUCCESSOR_ACKNOWLEDGEMENT_OUTSTANDING);
});

test("an unimplemented RC stays visible instead of disappearing", () => {
  const longAgo = new Date(Date.now() - 200 * 86400000).toISOString();
  const status = deriveImplementationStatus(
    { id: 1, created_at: longAgo },
    { openIssues: [{
        status: IMPLEMENTATION_STATUS.IMPLEMENTATION_BLOCKED,
        reason: IMPLEMENTATION_REASON.TRANSACTION_CLOSED_BEFORE_IMPLEMENTATION,
        days_since_trigger: 200
      }] }
  );
  assert.equal(status.status, IMPLEMENTATION_STATUS.IMPLEMENTATION_BLOCKED);
  assert.equal(status.outstanding_step, IMPLEMENTATION_REASON.TRANSACTION_CLOSED_BEFORE_IMPLEMENTATION);
});

/* ==================================================== audit outbox durability */

test("the legally critical events all go through the outbox", () => {
  for (const key of [
    "RC_SIGNED", "INVESTMENT_CONFIRMED", "ROUND_CLOSED", "TRIGGER_DETECTED",
    "CALCULATION_FROZEN", "DOCUMENT_LOCKED", "BOARD_PROPOSAL_GENERATED",
    "GF_GENERATED", "SUBSCRIPTION_COMPLETED", "PAR_CONFIRMED",
    "SHARE_CONTRIBUTION_CONFIRMED", "REGISTRATION_COMPLETED", "CONVERSION_COMPLETED"
  ]) {
    assert.ok(
      CRITICAL_AUDIT_EVENTS.has(AUDIT_EVENTS[key]),
      `${key} must be treated as a critical audit event`
    );
  }
});

test("the outbox row is written in the same transaction as the mutation", () => {
  const source = read("utils/auditOutbox.js");
  // The enqueue takes the caller's transaction connection, so the evidence
  // commits with the thing it describes or not at all.
  assert.match(source, /export async function enqueueCriticalAuditEvent\(connection, eventType/);
  assert.match(source, /INSERT IGNORE INTO rc_audit_outbox/);

  // And the callers pass their transaction connection, not the pool.
  assert.match(read("utils/rcPaymentActivation.js"), /enqueueCriticalAuditEvent\(connection, AUDIT_EVENTS\.INVESTMENT_CONFIRMED/);
  assert.match(read("routes/conversionRoutes.js"), /enqueueCriticalAuditEvent\(connection, AUDIT_EVENTS\.CALCULATION_FROZEN/);
  assert.match(read("routes/conversionRoutes.js"), /enqueueCriticalAuditEvent\(connection, AUDIT_EVENTS\.CONVERSION_COMPLETED/);
});

test("the same semantic event enqueued twice collapses to one row", () => {
  const details = { startupId: 1, roundId: 2, agreementId: 3, investorId: 4 };
  const a = buildIdempotencyKey(AUDIT_EVENTS.INVESTMENT_CONFIRMED, details);
  const b = buildIdempotencyKey(AUDIT_EVENTS.INVESTMENT_CONFIRMED, { ...details });
  assert.equal(a, b);

  // A different agreement is a different event.
  const other = buildIdempotencyKey(AUDIT_EVENTS.INVESTMENT_CONFIRMED, { ...details, agreementId: 9 });
  assert.notEqual(a, other);

  // The uniqueness is enforced in the schema, not only in the key builder.
  assert.match(read("utils/auditOutbox.js"), /UNIQUE KEY uniq_outbox_idempotency \(idempotency_key\)/);
});

test("a failed finalisation is retried rather than lost", () => {
  const source = read("utils/auditOutbox.js");
  assert.match(source, /attempts INT NOT NULL DEFAULT 0/);
  assert.match(source, /last_error TEXT NULL/);
  assert.match(source, /processed_at DATETIME NULL/);

  // A row that fails goes back to pending until the attempt budget is spent.
  assert.match(source, /exhausted \? OUTBOX_STATUS\.FAILED : OUTBOX_STATUS\.PENDING/);
  assert.ok(MAX_OUTBOX_ATTEMPTS >= 3);
  assert.deepEqual(Object.values(OUTBOX_STATUS).sort(), ["failed", "pending", "processed"]);
});

test("two workers cannot process the same outbox row", () => {
  const source = read("utils/auditOutbox.js");
  // The claim is a conditional update on the attempt count.
  assert.match(source, /WHERE id = \? AND status = \? AND attempts = \?/);
  assert.match(source, /if \(!claim\.affectedRows\) continue;/);
});

test("an unfinalised critical event is surfaced to admin, not to users", () => {
  const source = read("utils/auditOutbox.js");
  assert.match(source, /export async function getPendingCriticalAuditCount/);
});

test("audit event substance is never updated after the fact", () => {
  const logger = read("utils/auditLogger.js");
  // Only inserts. A correction is a new row.
  assert.match(logger, /INSERT INTO rc_audit_events/);
  assert.ok(
    !/UPDATE rc_audit_events/.test(logger),
    "audit events must be append-only"
  );
});

/* ======================================================= evidence export */

test("the evidence package is titled as documentation, not as proof of breach", () => {
  assert.equal(EVIDENCE_PACKAGE_TITLE, "Dokumentasjon for RC-avtale");

  const source = read("utils/evidenceExport.js");
  assert.match(source, /inneholder ingen vurdering av partenes rettigheter eller plikter/);
  assert.match(source, /stilling til om noen har misligholdt avtalen/);
  assert.ok(!/[Bb]evis på mislighold/.test(source));
});

test("the evidence package is limited to the parties, and redacts identifiers", () => {
  const source = read("utils/evidenceExport.js");
  assert.match(source, /export async function canAccessEvidence/);
  assert.match(source, /user\.role === "admin"/);
  assert.match(source, /Number\(agreement\.investor_id\) === Number\(user\.id\)/);
  assert.match(source, /isUserInSameCompany/);

  for (const key of ["national_id", "fodselsnummer", "personnummer", "password", "token", "cvc"]) {
    assert.match(source, new RegExp(`"${key}"`), `${key} must be redacted from the evidence package`);
  }

  // An investor sees their own allocation and their own events, not everyone's.
  assert.match(source, /scope !== "investor"/);
});

/* ================================================ documents reconcile numerically */

test("the whole Chapter 10 package reconciles on the canonical example", () => {
  const investors = Array.from({ length: 10 }, () => calculateRcConversion({
    investment_amount: 10000,
    valuation_cap: 1000000,
    trigger_type: "time_elapsed",
    capitalization_base_share_count: 30000,
    nominal_value_per_share: 1
  }));
  const totals = aggregateRcConversions(
    investors.map((i) => ({ ...i, investment_amount: 10000 }))
  );

  const oldShares = 30000;
  const oldCapital = 30000;
  const par = 1;

  // Board proposal and GF resolution: the increase.
  assert.equal(totals.total_conversion_share_count, 3090);
  assert.equal(totals.total_share_capital_increase, 3090);
  assert.equal(totals.total_share_premium, 0);

  // Subscription: par per share, and every investor the same.
  investors.forEach((investor) => {
    assert.equal(investor.final_share_count, 309);
    assert.equal(investor.par_amount, 309);
    assert.equal(investor.par_value_per_share, par);
  });

  // Updated articles.
  const newShares = oldShares + totals.total_conversion_share_count;
  const newCapital = oldCapital + totals.total_par_amount;
  assert.equal(newShares, 33090);
  assert.equal(newCapital, 33090);
  assert.equal(newCapital, newShares * par);

  // Shareholder register.
  const registerTotal = oldShares + investors.reduce((sum, i) => sum + i.final_share_count, 0);
  assert.equal(registerTotal, newShares);

  // No document may present the historical cash as share capital.
  const historicalCash = totals.total_investment_amount + totals.total_par_amount;
  assert.equal(historicalCash, 103090);
  assert.notEqual(newCapital, historicalCash);
});

/* ================================================== user-facing copy invariants */

const INVESTOR_PAGES = ["invest.html", "juridisk.html", "rc-copy.js"];

test("investor-facing copy never promises safety, a refund or a repayment", () => {
  /*
    Only AFFIRMATIVE claims are prohibited. "Ingen garantert avkastning" and
    "gir deg ikke krav på å få pengene tilbake" are exactly the sentences this
    product should contain, so a bare keyword search would flag the correct
    copy and push someone to delete it. Each pattern therefore requires the
    claim without a preceding negation.
  */
  const FORBIDDEN = [
    { label: "safe investment", pattern: /(?<!ikke )(?:trygg|sikker) investering/i },
    { label: "risk free", pattern: /(?<!ikke )risikofri/i },
    { label: "capital protected", pattern: /(?<!ikke )kapitalbeskytt/i },
    { label: "money back promise", pattern: /(?:du får|vi gir deg|rett til) pengene tilbake/i },
    { label: "guaranteed return", pattern: /(?:gir|har|med) garantert avkastning/i },
    { label: "we guarantee", pattern: /[Vv]i garanterer(?! ikke)/ },
    { label: "legally watertight", pattern: /juridisk vanntett/i },
    { label: "100% safe/legal", pattern: /100\s*% (?:sikker|trygg|lovlig)/i },
    { label: "guaranteed shares", pattern: /garantert(?:e)? aksjer/i },
    { label: "guaranteed settlement", pattern: /garantert oppgjør/i }
  ];

  for (const page of INVESTOR_PAGES) {
    const text = plain(readFrontend(page));
    for (const { label, pattern } of FORBIDDEN) {
      assert.ok(!pattern.test(text), `${page} makes a "${label}" claim`);
    }
  }
});

test("investor-facing copy never tells them they are buying shares now", () => {
  for (const page of INVESTOR_PAGES) {
    const text = plain(readFrontend(page));
    assert.ok(!/Kjøp aksjer/i.test(text), `${page} presents the RC as buying shares`);
    assert.ok(
      !/du eier nå aksjene/i.test(text),
      `${page} claims ownership before the increase is registered`
    );
  }
});

test("the shared copy states the three things an investor must not miss", () => {
  const copy = readFrontend("rc-copy.js");
  assert.match(copy, /Du kan tape hele beløpet du investerer/);
  assert.match(copy, /Du får ikke aksjer når du investerer/);
  assert.match(copy, /betaler du aksjenes samlede pålydende/);
});

test("the long-stop is never described as a due date or a repayment date", () => {
  const copy = readFrontend("rc-copy.js");
  assert.match(copy, /Seneste tidspunkt for utløsning/);
  assert.match(copy, /Dette betyr ikke at investeringen tilbakebetales etter 24 måneder/);
  // "forfallsdato" may appear only where it is being denied.
  assert.match(copy, /Perioden er ingen forfallsdato/);
  assert.ok(
    !/(?<!ingen )(?<!ikke en )forfallsdato for investeringen/i.test(copy),
    "the long-stop must never be presented as a due date"
  );
});

test("Raisium's role is stated without claiming to decide disputes", () => {
  const copy = readFrontend("rc-copy.js");
  assert.match(copy, /Raisium tar ikke stilling til hvem som har rett i en tvist/);
  assert.match(copy, /garanterer verken avkastning, verdi eller at du mottar aksjer/);
  assert.ok(!/bad faith|ond tro|avgjør tvisten/i.test(copy));
});

test("backend error codes are mapped to something a person can act on", () => {
  const copy = readFrontend("rc-copy.js");
  for (const code of [
    "SHARE_PRICE_NOT_ABOVE_PAR", "ARTICLES_NOT_CONFIRMED",
    "BOARD_CHAIR_NOT_CONFIRMED", "CAPACITY_EXCEEDED"
  ]) {
    assert.match(copy, new RegExp(code), `${code} has no human-readable message`);
  }
  assert.match(copy, /function rcErrorMessage/);
});

test("substantive legal wording lives in one place", () => {
  // The pages render the shared constants rather than restating them, so a
  // correction in one place cannot leave three pages contradicting it.
  const invest = readFrontend("invest.html");
  assert.match(invest, /rc-copy\.js/);
  assert.match(invest, /id="rcRiskPoints"/);
  assert.match(invest, /window\.RC_COPY/);
});
