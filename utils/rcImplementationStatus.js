import db from "../config/db.js";
import { AUDIT_EVENTS, recordAuditEvent } from "./auditLogger.js";

/*
  Visibility for RC implementations that have stalled.

  A trigger event obliges the company to start the Chapter 10 process. If it
  simply does not, the RC does not quietly disappear — clause 6.4 and 10.1 say
  the agreement survives. But an obligation nobody can see is not much of an
  obligation, so the state has to be visible in the product to the investor,
  the company and Raisium support.

  What this records is FACTUAL and nothing more:

      a trigger was registered on this date
      the process has not advanced in N days
      an investor has reported that implementation is outstanding

  Raisium does not, and must not, decide whether anyone acted in bad faith,
  whether a breach occurred, or what anyone owes anyone. Those are questions for
  the parties, their advisers and ultimately a court. The platform's job is to
  hold an accurate record of what happened and when.
*/

export const IMPLEMENTATION_STATUS = {
  ON_TRACK: "on_track",
  ACTION_OUTSTANDING: "action_outstanding",
  IMPLEMENTATION_BLOCKED: "implementation_blocked",
  DISPUTE_REPORTED: "dispute_reported",
  RESOLVED: "resolved"
};

// How long after a trigger the process may sit untouched before the product
// says so. A deliberately generous window: corporate steps take time, and the
// point is to surface neglect, not to nag.
export const IMPLEMENTATION_GRACE_DAYS = 45;

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureImplementationStatusSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "rc_implementation_issues")) return;

    await connection.query(`
      CREATE TABLE rc_implementation_issues (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        startup_id INT NOT NULL,
        round_id INT NOT NULL,
        agreement_id INT NULL,
        conversion_event_id INT NULL,
        raised_by_user_id INT NULL,
        raised_by_role VARCHAR(32) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'action_outstanding',
        reason VARCHAR(64) NOT NULL,
        description TEXT NULL,
        trigger_recorded_at DATETIME NULL,
        days_since_trigger INT NULL,
        resolved_at DATETIME NULL,
        resolution_note TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_impl_issue_round (round_id, status),
        INDEX idx_impl_issue_startup (startup_id, status)
      )
    `);
  } finally {
    connection.release();
  }
}

function daysBetween(from, to = new Date()) {
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return null;
  return Math.floor((to.getTime() - start.getTime()) / 86400000);
}

/*
  Derives the current implementation state from facts already in the system.
  Deliberately descriptive: it reports which step is outstanding and for how
  long, and draws no conclusion about why.
*/
export function deriveImplementationStatus(conversion, { openIssues = [] } = {}) {
  if (openIssues.length) {
    const disputed = openIssues.some((i) => i.status === IMPLEMENTATION_STATUS.DISPUTE_REPORTED);
    return {
      status: disputed ? IMPLEMENTATION_STATUS.DISPUTE_REPORTED : IMPLEMENTATION_STATUS.IMPLEMENTATION_BLOCKED,
      open_issue_count: openIssues.length,
      outstanding_step: openIssues[0]?.reason || null,
      days_since_trigger: openIssues[0]?.days_since_trigger ?? null
    };
  }

  if (!conversion?.id) {
    return { status: IMPLEMENTATION_STATUS.ON_TRACK, open_issue_count: 0, outstanding_step: null, days_since_trigger: null };
  }

  const triggeredAt = conversion.preparation_started_at || conversion.created_at || null;
  const days = triggeredAt ? daysBetween(triggeredAt) : null;

  const outstanding =
    !conversion.board_document_id ? "styrets_forslag"
    : !conversion.gf_document_id ? "generalforsamling"
    : !conversion.capital_confirmation_document_id ? "bekreftelse_aksjeinnskudd"
    : !conversion.altinn_package_document_id ? "dokumentpakke"
    : null;

  if (!outstanding) {
    return { status: IMPLEMENTATION_STATUS.ON_TRACK, open_issue_count: 0, outstanding_step: null, days_since_trigger: days };
  }

  return {
    status: days != null && days > IMPLEMENTATION_GRACE_DAYS
      ? IMPLEMENTATION_STATUS.ACTION_OUTSTANDING
      : IMPLEMENTATION_STATUS.ON_TRACK,
    open_issue_count: 0,
    outstanding_step: outstanding,
    days_since_trigger: days
  };
}

/*
  Records that someone reported implementation as outstanding. Stores what was
  reported, by whom and when — never an assessment of it.
*/
export async function raiseImplementationIssue(connection, {
  startupId, roundId, agreementId = null, conversionEventId = null,
  raisedByUserId = null, raisedByRole = null,
  reason, description = null, triggerRecordedAt = null
}) {
  if (!(await tableExists(connection, "rc_implementation_issues"))) {
    return { ok: false, error: "Sporing av gjennomføring er ikke tilgjengelig." };
  }

  const [existing] = await connection.query(
    `SELECT id FROM rc_implementation_issues
     WHERE round_id = ? AND reason = ? AND resolved_at IS NULL
       AND (agreement_id <=> ?)
     LIMIT 1`,
    [roundId, reason, agreementId]
  );
  if (existing.length) {
    return { ok: true, id: existing[0].id, alreadyOpen: true };
  }

  const [result] = await connection.query(
    `INSERT INTO rc_implementation_issues
     (startup_id, round_id, agreement_id, conversion_event_id, raised_by_user_id,
      raised_by_role, status, reason, description, trigger_recorded_at, days_since_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      startupId, roundId, agreementId, conversionEventId, raisedByUserId,
      raisedByRole,
      raisedByRole === "investor" ? IMPLEMENTATION_STATUS.DISPUTE_REPORTED : IMPLEMENTATION_STATUS.ACTION_OUTSTANDING,
      String(reason).slice(0, 64),
      description ? String(description).slice(0, 4000) : null,
      triggerRecordedAt,
      triggerRecordedAt ? daysBetween(triggerRecordedAt) : null
    ]
  );

  await recordAuditEvent(connection, AUDIT_EVENTS.IMPLEMENTATION_ISSUE_RAISED, {
    startupId, roundId, agreementId,
    actorUserId: raisedByUserId, actorRole: raisedByRole,
    newStatus: raisedByRole === "investor" ? IMPLEMENTATION_STATUS.DISPUTE_REPORTED : IMPLEMENTATION_STATUS.ACTION_OUTSTANDING,
    metadata: { reason, conversion_event_id: conversionEventId }
  });

  return { ok: true, id: result.insertId, alreadyOpen: false };
}

export async function getOpenImplementationIssues(connection, roundId) {
  if (!(await tableExists(connection, "rc_implementation_issues"))) return [];

  const [rows] = await connection.query(
    `SELECT * FROM rc_implementation_issues
     WHERE round_id = ? AND resolved_at IS NULL
     ORDER BY created_at ASC`,
    [roundId]
  );
  return rows;
}

export async function resolveImplementationIssue(connection, { issueId, resolvedByUserId, note = null }) {
  if (!(await tableExists(connection, "rc_implementation_issues"))) return false;

  const [result] = await connection.query(
    `UPDATE rc_implementation_issues
     SET status = ?, resolved_at = NOW(), resolution_note = ?
     WHERE id = ? AND resolved_at IS NULL`,
    [IMPLEMENTATION_STATUS.RESOLVED, note ? String(note).slice(0, 4000) : null, issueId]
  );

  if (result.affectedRows) {
    await recordAuditEvent(connection, AUDIT_EVENTS.IMPLEMENTATION_ISSUE_UPDATED, {
      actorUserId: resolvedByUserId, newStatus: IMPLEMENTATION_STATUS.RESOLVED,
      metadata: { issue_id: issueId }
    });
  }
  return result.affectedRows > 0;
}
