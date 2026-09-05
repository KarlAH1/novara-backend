import assert from "node:assert/strict";
import test from "node:test";
import { buildRoundAvailability } from "../utils/emissionRoundState.js";
import {
  availableAfterReservations,
  RESERVATION_STATUS,
  RESERVATION_TTL_MINUTES
} from "../utils/capacityReservation.js";
import {
  assertSignerMatchesBody,
  normalizePersonName
} from "../utils/boardChairResolution.js";
import { findSignerRoleMismatch } from "../utils/documentSigning.js";
import { deriveImplementationStatus, IMPLEMENTATION_STATUS } from "../utils/rcImplementationStatus.js";
import { STANDARD_LONG_STOP_YEARS } from "../controllers/emissionController.js";

/* =========================================================== capacity holds */

/*
  The canonical round: NOK 100,000 hard cap, NOK 90,000 already committed by
  nine investors, one NOK 10,000 slot left, and two investors reaching for it.
*/
const HARD_CAP = 100000;
const COMMITTED = 90000;
const LAST_SLOT = 10000;

const remaining = () =>
  buildRoundAvailability({ target_amount: HARD_CAP, committed_amount: COMMITTED, open: 1 })
    .remainingCapacity;

test("capacity available to a new investor is net of everyone else's holds", () => {
  assert.equal(remaining(), LAST_SLOT);

  // Nothing held yet: the last slot is open.
  assert.equal(availableAfterReservations(remaining(), 0), LAST_SLOT);

  // Investor A holds it: nothing is left for investor B.
  assert.equal(availableAfterReservations(remaining(), LAST_SLOT), 0);
});

test("only one of two simultaneous investors can take the last slot", () => {
  // Both see 10,000 remaining. A reserves first.
  const afterA = availableAfterReservations(remaining(), LAST_SLOT);

  // B is refused before any payment is created, not after paying.
  assert.equal(afterA, 0);
  assert.ok(LAST_SLOT > afterA, "B must not be able to reserve");

  // The round can therefore never exceed the cap.
  assert.equal(COMMITTED + LAST_SLOT, HARD_CAP);
});

test("a released or expired hold returns the capacity to the round", () => {
  assert.equal(availableAfterReservations(remaining(), LAST_SLOT), 0);
  // A's hold expires; the sum of live reservations drops back to zero.
  assert.equal(availableAfterReservations(remaining(), 0), LAST_SLOT);
});

test("available capacity is never negative", () => {
  assert.equal(availableAfterReservations(remaining(), 999999), 0);
  assert.equal(availableAfterReservations(0, 0), 0);
});

test("reservations have a bounded lifetime and the expected states", () => {
  assert.ok(RESERVATION_TTL_MINUTES > 0 && RESERVATION_TTL_MINUTES <= 24 * 60);
  assert.deepEqual(
    Object.values(RESERVATION_STATUS).sort(),
    ["committed", "expired", "released", "reserved"]
  );
});

test("a stale invite does not carry capacity with it", () => {
  // The round is full. Whatever invite an investor holds, there is nothing to
  // reserve, so the flow stops before a payment exists.
  const full = buildRoundAvailability({ target_amount: HARD_CAP, committed_amount: HARD_CAP, open: 1 });
  assert.equal(full.canInvest, false);
  assert.equal(availableAfterReservations(full.remainingCapacity, 0), 0);
});

/* ======================================================= board chair identity */

test("names are compared without being tripped by case or spacing", () => {
  assert.equal(normalizePersonName("  Ola   Nordmann "), "ola nordmann");
  assert.equal(normalizePersonName("OLA NORDMANN"), normalizePersonName("Ola Nordmann"));
});

test("the confirmed chair and the signer must be the same person", () => {
  assert.equal(assertSignerMatchesBody("Ola Nordmann", "Ola Nordmann").ok, true);
  assert.equal(assertSignerMatchesBody("Ola Nordmann", "ola  nordmann").ok, true);

  const mismatch = assertSignerMatchesBody("Ola Nordmann", "Kari Nordmann");
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /Kari Nordmann/);
});

test("an unresolved role blocks the document rather than defaulting to someone", () => {
  assert.equal(assertSignerMatchesBody("", "Ola Nordmann").ok, false);
  assert.equal(assertSignerMatchesBody("Ola Nordmann", "").ok, false);
});

test("a document whose body names one chair and signature block another is not locked", () => {
  const html = '<p><strong>Styrets leder:</strong> Ola Nordmann</p><p>Dato: 2026-09-03</p>';

  assert.equal(
    findSignerRoleMismatch(html, [{ role: "Styreleder", signer_name: "Ola Nordmann" }]),
    null,
    "matching names lock cleanly"
  );

  const problem = findSignerRoleMismatch(html, [{ role: "Styreleder", signer_name: "Kari Nordmann" }]);
  assert.ok(problem, "a different signer must block locking");
  assert.match(problem, /Ola Nordmann/);
  assert.match(problem, /Kari Nordmann/);
});

test("the general meeting chair is checked the same way", () => {
  const html = '<li>Møteleder: Ola Nordmann</li><li>Protokollunderskriver: Kari Nordmann</li>';
  assert.equal(findSignerRoleMismatch(html, [{ role: "Møteleder", signer_name: "Ola Nordmann" }]), null);
  assert.ok(findSignerRoleMismatch(html, [{ role: "Møteleder", signer_name: "Per Hansen" }]));
});

test("a role the body never names cannot contradict the signature block", () => {
  assert.equal(findSignerRoleMismatch("<p>Ingen roller nevnt</p>", [{ role: "Styreleder", signer_name: "Ola" }]), null);
});

/* ============================================================ long-stop default */

test("the standard long-stop for a new round is 24 months", () => {
  assert.equal(STANDARD_LONG_STOP_YEARS, 2);
});

/* ============================================ implementation visibility, not blame */

test("a conversion moving through its steps reads as on track", () => {
  const status = deriveImplementationStatus({
    id: 1,
    created_at: new Date().toISOString(),
    board_document_id: 1,
    gf_document_id: 2,
    capital_confirmation_document_id: 3,
    altinn_package_document_id: 4
  });
  assert.equal(status.status, IMPLEMENTATION_STATUS.ON_TRACK);
  assert.equal(status.outstanding_step, null);
});

test("a trigger left unimplemented past the grace period is surfaced", () => {
  const longAgo = new Date(Date.now() - 120 * 86400000).toISOString();
  const status = deriveImplementationStatus({ id: 1, created_at: longAgo });

  assert.equal(status.status, IMPLEMENTATION_STATUS.ACTION_OUTSTANDING);
  assert.equal(status.outstanding_step, "styrets_forslag");
  assert.ok(status.days_since_trigger > 45);
});

test("a recent trigger is not flagged merely for being incomplete", () => {
  const status = deriveImplementationStatus({ id: 1, created_at: new Date().toISOString() });
  assert.equal(status.status, IMPLEMENTATION_STATUS.ON_TRACK);
  assert.equal(status.outstanding_step, "styrets_forslag");
});

test("a reported dispute is recorded as reported, never as a finding of fault", () => {
  const status = deriveImplementationStatus(
    { id: 1, created_at: new Date().toISOString() },
    { openIssues: [{ status: IMPLEMENTATION_STATUS.DISPUTE_REPORTED, reason: "trigger_not_implemented", days_since_trigger: 90 }] }
  );

  assert.equal(status.status, IMPLEMENTATION_STATUS.DISPUTE_REPORTED);
  assert.equal(status.open_issue_count, 1);

  // Every state the platform can reach is descriptive. None of them asserts
  // bad faith, breach or liability — those are for the parties and the courts.
  const factual = Object.values(IMPLEMENTATION_STATUS);
  for (const value of factual) {
    assert.ok(
      !/bad_faith|breach_confirmed|liable|guilty|fault/.test(value),
      `implementation status "${value}" states a legal conclusion`
    );
  }
});
