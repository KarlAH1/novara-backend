import db from "../config/db.js";
import { AUDIT_EVENTS, recordAuditEvent } from "./auditLogger.js";

/*
  Durable delivery for legally critical audit events.

  For ordinary telemetry it is fine that a failed audit write does not roll back
  the operation it describes — losing a log line is better than failing a
  capital increase. But for the events that constitute the evidentiary record of
  an RC round, silently losing one is not acceptable: if a dispute later turns on
  when the calculation was frozen or when the par amount was confirmed, "we
  think it happened but the write failed" is not an answer.

  So a critical event is written to an outbox row inside the SAME transaction as
  the business mutation. If the transaction commits, the evidence of it exists.
  A worker then finalises the durable audit event from the outbox, retrying
  until it succeeds.

  This is deliberately the smallest reliable pattern that MySQL supports — one
  table, a claim-and-process loop, and an idempotency key. No message broker.

  Delivery is at-least-once, so the idempotency key is what makes the *semantic*
  event exactly-once: a unique key means a retry cannot produce a second audit
  row for the same event.
*/

export const CRITICAL_AUDIT_EVENTS = new Set([
  AUDIT_EVENTS.RC_SIGNED,
  AUDIT_EVENTS.INVESTMENT_CONFIRMED,
  AUDIT_EVENTS.ROUND_CLOSED,
  AUDIT_EVENTS.TRIGGER_DETECTED,
  AUDIT_EVENTS.CALCULATION_FROZEN,
  AUDIT_EVENTS.DOCUMENT_LOCKED,
  AUDIT_EVENTS.BOARD_PROPOSAL_GENERATED,
  AUDIT_EVENTS.GF_GENERATED,
  AUDIT_EVENTS.SUBSCRIPTION_COMPLETED,
  AUDIT_EVENTS.PAR_CONFIRMED,
  AUDIT_EVENTS.SHARE_CONTRIBUTION_CONFIRMED,
  AUDIT_EVENTS.REGISTRATION_COMPLETED,
  AUDIT_EVENTS.CONVERSION_COMPLETED
]);

export const OUTBOX_STATUS = {
  PENDING: "pending",
  PROCESSED: "processed",
  FAILED: "failed"
};

// Stop retrying after this many attempts and surface it to admin instead of
// hammering a permanently broken write.
export const MAX_OUTBOX_ATTEMPTS = 10;

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureAuditOutboxSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "rc_audit_outbox")) return;

    await connection.query(`
      CREATE TABLE rc_audit_outbox (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        idempotency_key VARCHAR(190) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME NULL,
        UNIQUE KEY uniq_outbox_idempotency (idempotency_key),
        INDEX idx_outbox_pending (status, created_at)
      )
    `);
  } finally {
    connection.release();
  }
}

/*
  Builds the key that makes a semantic event unique. Two attempts to record the
  same thing collapse to one row; two genuinely different events do not.
*/
export function buildIdempotencyKey(eventType, details = {}) {
  const parts = [
    eventType,
    details.startupId ?? "-",
    details.roundId ?? "-",
    details.agreementId ?? "-",
    details.investorId ?? "-",
    details.documentId ?? "-",
    details.metadata?.conversion_event_id ?? "-"
  ];
  return parts.join(":").slice(0, 190);
}

/*
  Enqueues a critical event. MUST be called on the transaction connection that
  carries the business mutation, so the two commit or fail together.

  Falls back to writing the audit event directly when the outbox table does not
  exist yet, so an older database keeps working.
*/
export async function enqueueCriticalAuditEvent(connection, eventType, details = {}) {
  if (!(await tableExists(connection, "rc_audit_outbox"))) {
    await recordAuditEvent(connection, eventType, details);
    return { enqueued: false, fallback: true };
  }

  const key = buildIdempotencyKey(eventType, details);

  // INSERT IGNORE: re-running the same operation does not enqueue a duplicate.
  const [result] = await connection.query(
    `INSERT IGNORE INTO rc_audit_outbox (idempotency_key, event_type, payload)
     VALUES (?, ?, ?)`,
    [key, String(eventType).slice(0, 64), JSON.stringify(details)]
  );

  return { enqueued: result.affectedRows > 0, idempotencyKey: key, duplicate: result.affectedRows === 0 };
}

/*
  Finalises pending outbox rows into durable audit events. Safe to run
  repeatedly and concurrently: each row is claimed with a conditional update, so
  two workers cannot process the same one.
*/
export async function processAuditOutbox({ limit = 50 } = {}) {
  const connection = await db.getConnection();
  const summary = { claimed: 0, processed: 0, failed: 0 };

  try {
    if (!(await tableExists(connection, "rc_audit_outbox"))) return summary;

    const [rows] = await connection.query(
      `SELECT id, idempotency_key, event_type, payload, attempts
       FROM rc_audit_outbox
       WHERE status = ? AND attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [OUTBOX_STATUS.PENDING, MAX_OUTBOX_ATTEMPTS, Number(limit)]
    );

    for (const row of rows) {
      // Claim it. If another worker got there first, affectedRows is 0.
      const [claim] = await connection.query(
        `UPDATE rc_audit_outbox SET attempts = attempts + 1
         WHERE id = ? AND status = ? AND attempts = ?`,
        [row.id, OUTBOX_STATUS.PENDING, row.attempts]
      );
      if (!claim.affectedRows) continue;
      summary.claimed += 1;

      try {
        const details = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        await recordAuditEvent(connection, row.event_type, {
          ...details,
          metadata: { ...(details.metadata || {}), outbox_key: row.idempotency_key }
        });

        await connection.query(
          `UPDATE rc_audit_outbox SET status = ?, processed_at = NOW(), last_error = NULL WHERE id = ?`,
          [OUTBOX_STATUS.PROCESSED, row.id]
        );
        summary.processed += 1;
      } catch (err) {
        const exhausted = row.attempts + 1 >= MAX_OUTBOX_ATTEMPTS;
        await connection.query(
          `UPDATE rc_audit_outbox SET status = ?, last_error = ? WHERE id = ?`,
          [exhausted ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING, String(err?.message || err).slice(0, 2000), row.id]
        );
        summary.failed += 1;
      }
    }

    return summary;
  } finally {
    connection.release();
  }
}

/*
  Health signal for admin: critical events that have not yet been finalised.
  A non-zero backlog is an operational issue, not something to show investors.
*/
export async function getPendingCriticalAuditCount(connection) {
  const target = connection || db;
  try {
    const [rows] = await target.query(
      `SELECT status, COUNT(*) AS count FROM rc_audit_outbox
       WHERE status IN (?, ?) GROUP BY status`,
      [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.FAILED]
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    return {
      pending: byStatus[OUTBOX_STATUS.PENDING] || 0,
      failed: byStatus[OUTBOX_STATUS.FAILED] || 0
    };
  } catch {
    return { pending: 0, failed: 0 };
  }
}
