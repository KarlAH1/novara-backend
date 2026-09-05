import db from "../config/db.js";

function scrubValue(value) {
  if (value == null) return value;

  if (typeof value === "string") {
    if (value.length > 220) {
      return `${value.slice(0, 220)}…`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map(scrubValue);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 20);
    return Object.fromEntries(entries.map(([key, nested]) => [key, scrubValue(nested)]));
  }

  return value;
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function logAuditEvent(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...scrubValue(details)
  };

  console.info("[audit]", JSON.stringify(payload));
}

/* ==========================================================================
   DURABLE AUDIT TRAIL

   console.info survives only until the container restarts, which on Render is
   every deploy. If a dispute arises about what happened in an RC round — when
   the trigger was recorded, what the calculation said, who signed what, when
   the par amount was received — the answer has to outlive the process.

   These events are the evidentiary record of the round. They are append-only:
   nothing here is ever updated or deleted, and a correction is a new row.
   ========================================================================== */

export const AUDIT_EVENTS = {
  ROUND_CREATED: "round.created",
  ROUND_TERMS_CHANGED: "round.terms_changed",
  ROUND_ACTIVATED: "round.activated",
  ROUND_CLOSED: "round.closed",

  ARTICLES_UPLOADED: "articles.uploaded",
  ARTICLES_EXTRACTED: "articles.extracted",
  ARTICLES_CONFIRMED: "articles.confirmed",

  INVITE_CREATED: "invite.created",
  INVITE_CLAIMED: "invite.claimed",

  CAPACITY_RESERVED: "capacity.reserved",
  CAPACITY_RESERVATION_REFUSED: "capacity.refused",
  CAPACITY_COMMITTED: "capacity.committed",
  CAPACITY_RELEASED: "capacity.released",

  RC_GENERATED: "rc.generated",
  RC_SIGNED: "rc.signed",
  RC_CANCELLED: "rc.cancelled",

  INVESTMENT_INITIATED: "investment.initiated",
  INVESTMENT_CONFIRMED: "investment.confirmed",

  TRIGGER_DETECTED: "trigger.detected",
  TRIGGER_ACKNOWLEDGED: "trigger.acknowledged",
  CALCULATION_FROZEN: "calculation.frozen",

  BOARD_PROPOSAL_GENERATED: "document.board_proposal_generated",
  GF_GENERATED: "document.gf_generated",
  DOCUMENT_SIGNED: "document.signed",
  DOCUMENT_LOCKED: "document.locked",

  SUBSCRIPTION_COMPLETED: "subscription.completed",
  PAR_REQUESTED: "par.requested",
  PAR_CONFIRMED: "par.confirmed",
  SHARE_CONTRIBUTION_CONFIRMED: "par.contribution_confirmed",

  REGISTRATION_READINESS_CHECKED: "registration.readiness_checked",
  REGISTRATION_COMPLETED: "registration.completed",
  CONVERSION_COMPLETED: "conversion.completed",

  IMPLEMENTATION_ISSUE_RAISED: "dispute.issue_raised",
  IMPLEMENTATION_ISSUE_UPDATED: "dispute.issue_updated"
};

/*
  Never written to the audit trail. Identity numbers, credentials and raw card
  or account data have no evidentiary value here and every reason not to be
  duplicated into a second store.
*/
const FORBIDDEN_KEYS = new Set([
  "national_id", "nationalId", "fodselsnummer", "personnummer",
  "password", "password_hash", "token", "access_token", "api_key",
  "card", "card_number", "cvc", "iban", "national_id_encrypted"
]);

function stripSensitive(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSensitive);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORBIDDEN_KEYS.has(key))
      .map(([key, nested]) => [key, stripSensitive(nested)])
  );
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureAuditLogSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "rc_audit_events")) return;

    await connection.query(`
      CREATE TABLE rc_audit_events (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(64) NOT NULL,
        startup_id INT NULL,
        round_id INT NULL,
        agreement_id INT NULL,
        investor_id INT NULL,
        actor_user_id INT NULL,
        actor_role VARCHAR(32) NULL,
        previous_status VARCHAR(64) NULL,
        new_status VARCHAR(64) NULL,
        document_id INT NULL,
        document_hash VARCHAR(128) NULL,
        calculation_version VARCHAR(32) NULL,
        legal_model_version VARCHAR(32) NULL,
        payment_reference VARCHAR(128) NULL,
        trigger_type VARCHAR(64) NULL,
        metadata JSON NULL,
        ip_address VARCHAR(64) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_round (round_id, created_at),
        INDEX idx_audit_agreement (agreement_id, created_at),
        INDEX idx_audit_startup (startup_id, created_at),
        INDEX idx_audit_event (event_type, created_at)
      )
    `);
  } finally {
    connection.release();
  }
}

/*
  Records one event. Never throws: an audit write that fails must not roll back
  or block the business operation it is describing — a missing audit row is bad,
  a failed capital increase is worse. Failures are surfaced on the console.

  Pass a transaction connection to have the event committed atomically with the
  change it records; omit it to write on the pool.
*/
export async function recordAuditEvent(connection, eventType, details = {}) {
  const {
    startupId = null, roundId = null, agreementId = null, investorId = null,
    actorUserId = null, actorRole = null, previousStatus = null, newStatus = null,
    documentId = null, documentHash = null, calculationVersion = null,
    legalModelVersion = null, paymentReference = null, triggerType = null,
    ipAddress = null, metadata = null
  } = details;

  logAuditEvent(eventType, { startupId, roundId, agreementId, newStatus });

  const target = connection || db;

  try {
    await target.query(
      `INSERT INTO rc_audit_events
       (event_type, startup_id, round_id, agreement_id, investor_id, actor_user_id,
        actor_role, previous_status, new_status, document_id, document_hash,
        calculation_version, legal_model_version, payment_reference, trigger_type,
        metadata, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(eventType).slice(0, 64),
        startupId, roundId, agreementId, investorId, actorUserId,
        actorRole ? String(actorRole).slice(0, 32) : null,
        previousStatus ? String(previousStatus).slice(0, 64) : null,
        newStatus ? String(newStatus).slice(0, 64) : null,
        documentId, documentHash, calculationVersion, legalModelVersion,
        paymentReference ? String(paymentReference).slice(0, 128) : null,
        triggerType ? String(triggerType).slice(0, 64) : null,
        metadata ? JSON.stringify(stripSensitive(scrubValue(metadata))) : null,
        ipAddress ? String(ipAddress).slice(0, 64) : null
      ]
    );
  } catch (err) {
    console.error("[audit] durable write failed:", eventType, err?.message);
  }
}

/*
  Reads the trail for one round, oldest first — the sequence of what happened.
*/
export async function getAuditTrailForRound(connection, roundId, { limit = 500 } = {}) {
  const target = connection || db;
  const [rows] = await target.query(
    `SELECT * FROM rc_audit_events WHERE round_id = ?
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    [roundId, Number(limit)]
  );
  return rows;
}
