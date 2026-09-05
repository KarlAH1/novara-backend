import db from "../config/db.js";

/*
  Capacity reservation for a private round.

  The problem this solves: committed capital was only counted once an agreement
  reached 'Active RC', which happens at payment confirmation. Until then an
  unlimited number of investors could sign agreements against the same
  remaining capacity, pay, and only then discover the round was full — leaving
  the company owing refunds it never agreed to take.

  So capacity is claimed BEFORE payment. A reservation is a short-lived,
  amount-specific hold, taken inside a transaction that locks the round row, so
  two investors racing for the last slot cannot both win. It converts to a
  committed investment when payment is confirmed server-side, and is released
  when the payment fails, is cancelled, or simply expires unused.

  Authoritative capacity is therefore:

      committed (Active RC) + live reservations

  and the frontend's view of capacity is informational only.
*/

export const RESERVATION_TTL_MINUTES = 45;

export const RESERVATION_STATUS = {
  RESERVED: "reserved",
  COMMITTED: "committed",
  RELEASED: "released",
  EXPIRED: "expired"
};

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

export async function ensureCapacityReservationSchema() {
  const connection = await db.getConnection();
  try {
    if (await tableExists(connection, "round_capacity_reservations")) return;

    await connection.query(`
      CREATE TABLE round_capacity_reservations (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        round_id INT NOT NULL,
        investor_id INT NOT NULL,
        agreement_id INT NULL,
        invite_token VARCHAR(128) NULL,
        amount INT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'reserved',
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        released_at DATETIME NULL,
        committed_at DATETIME NULL,
        release_reason VARCHAR(64) NULL,
        INDEX idx_reservation_round_status (round_id, status),
        INDEX idx_reservation_agreement (agreement_id),
        UNIQUE KEY uniq_reservation_active (round_id, investor_id, status)
      )
    `);
  } finally {
    connection.release();
  }
}

/*
  Expires stale holds. Called before any capacity read so an abandoned checkout
  cannot block the round indefinitely.
*/
export async function expireStaleReservations(connection, roundId) {
  if (!(await tableExists(connection, "round_capacity_reservations"))) return 0;

  const [result] = await connection.query(
    `UPDATE round_capacity_reservations
     SET status = ?, released_at = NOW(), release_reason = 'expired'
     WHERE round_id = ? AND status = ? AND expires_at < NOW()`,
    [RESERVATION_STATUS.EXPIRED, roundId, RESERVATION_STATUS.RESERVED]
  );
  return result.affectedRows || 0;
}

export async function getReservedAmount(connection, roundId, { lock = false } = {}) {
  if (!(await tableExists(connection, "round_capacity_reservations"))) return 0;

  const [rows] = await connection.query(
    `SELECT COALESCE(SUM(amount), 0) AS reserved
     FROM round_capacity_reservations
     WHERE round_id = ? AND status = ? AND expires_at >= NOW()
     ${lock ? "FOR UPDATE" : ""}`,
    [roundId, RESERVATION_STATUS.RESERVED]
  );
  return Number(rows[0]?.reserved || 0);
}

/*
  Claims capacity for one investor.

  The caller must already hold a lock on the round row (syncEmissionRoundAvailability
  with { lock: true }) and be inside a transaction — that lock is what serialises
  two investors competing for the same last slot.

  Idempotent: an investor who already holds a live reservation on the round gets
  that one back rather than a second hold, so a retried request cannot consume
  capacity twice.
*/
export async function reserveCapacity(connection, {
  roundId, investorId, amount, inviteToken = null, agreementId = null, remainingCapacity
}) {
  if (!(await tableExists(connection, "round_capacity_reservations"))) {
    return { ok: true, skipped: true };
  }

  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, code: "invalid_amount", error: "Ugyldig beløp." };
  }

  await expireStaleReservations(connection, roundId);

  const [existingRows] = await connection.query(
    `SELECT * FROM round_capacity_reservations
     WHERE round_id = ? AND investor_id = ? AND status = ? AND expires_at >= NOW()
     FOR UPDATE`,
    [roundId, investorId, RESERVATION_STATUS.RESERVED]
  );
  const existing = existingRows[0] || null;

  const reservedByOthers = await getReservedAmount(connection, roundId, { lock: true })
    - Number(existing?.amount || 0);

  const available = Number(remainingCapacity || 0) - reservedByOthers;

  if (requested > available) {
    return {
      ok: false,
      code: "capacity_exceeded",
      available: Math.max(available, 0),
      error: available > 0
        ? `Det er bare ${available.toLocaleString("no-NO")} NOK igjen i runden akkurat nå.`
        : "Runden er fulltegnet."
    };
  }

  if (existing) {
    await connection.query(
      `UPDATE round_capacity_reservations
       SET amount = ?, agreement_id = COALESCE(?, agreement_id),
           expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
       WHERE id = ?`,
      [requested, agreementId, RESERVATION_TTL_MINUTES, existing.id]
    );
    return { ok: true, reservationId: existing.id, reused: true };
  }

  const [result] = await connection.query(
    `INSERT INTO round_capacity_reservations
     (round_id, investor_id, agreement_id, invite_token, amount, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [roundId, investorId, agreementId, inviteToken, requested,
     RESERVATION_STATUS.RESERVED, RESERVATION_TTL_MINUTES]
  );

  return { ok: true, reservationId: result.insertId, reused: false };
}

export async function attachAgreementToReservation(connection, { reservationId, agreementId }) {
  if (!reservationId || !agreementId) return;
  if (!(await tableExists(connection, "round_capacity_reservations"))) return;

  await connection.query(
    `UPDATE round_capacity_reservations SET agreement_id = ? WHERE id = ? AND agreement_id IS NULL`,
    [agreementId, reservationId]
  );
}

/*
  Payment confirmed: the hold becomes a committed investment. Idempotent — a
  redelivered webhook finds nothing left in 'reserved' and changes nothing.
*/
export async function commitReservationForAgreement(connection, agreementId) {
  if (!agreementId) return false;
  if (!(await tableExists(connection, "round_capacity_reservations"))) return false;

  const [result] = await connection.query(
    `UPDATE round_capacity_reservations
     SET status = ?, committed_at = NOW()
     WHERE agreement_id = ? AND status = ?`,
    [RESERVATION_STATUS.COMMITTED, agreementId, RESERVATION_STATUS.RESERVED]
  );
  return (result.affectedRows || 0) > 0;
}

/*
  Payment failed, cancelled or abandoned: the capacity goes back to the round.
*/
export async function releaseReservationForAgreement(connection, agreementId, reason = "released") {
  if (!agreementId) return false;
  if (!(await tableExists(connection, "round_capacity_reservations"))) return false;

  const [result] = await connection.query(
    `UPDATE round_capacity_reservations
     SET status = ?, released_at = NOW(), release_reason = ?
     WHERE agreement_id = ? AND status = ?`,
    [RESERVATION_STATUS.RELEASED, String(reason).slice(0, 64), agreementId, RESERVATION_STATUS.RESERVED]
  );
  return (result.affectedRows || 0) > 0;
}

/*
  Capacity actually available to a new investor: the round's remaining capacity
  less everything currently held by someone else's live reservation.
*/
export function availableAfterReservations(remainingCapacity, reservedAmount) {
  return Math.max(Number(remainingCapacity || 0) - Number(reservedAmount || 0), 0);
}
