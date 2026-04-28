const STATUS_REASON_MAP = {
  target_reached: "TARGET_REACHED",
  manually_closed: "CLOSED",
  conversion_downloaded: "CLOSED",
  expired: "EXPIRED",
  cancelled: "CANCELLED"
};

const CLOSED_MESSAGE_MAP = {
  target_reached: "Målbeløpet er nådd. Det er ikke lenger mulig å investere i denne runden.",
  manually_closed: "Runden er avsluttet.",
  conversion_downloaded: "Runden er avsluttet etter at dokumentpakken ble lastet ned.",
  expired: "Runden er utløpt.",
  cancelled: "Runden er kansellert."
};

const SAFE_CLOSED_REASONS = new Set([
  "target_reached",
  "manually_closed",
  "conversion_downloaded",
  "expired",
  "cancelled"
]);

function normalizeAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

export function buildRoundAvailability(round = {}) {
  const targetAmount = normalizeAmount(round.target_amount);
  const committedAmount = normalizeAmount(round.committed_amount);
  const confirmedPaidAmount = normalizeAmount(round.amount_raised);
  const closedReason = SAFE_CLOSED_REASONS.has(round.closed_reason)
    ? round.closed_reason
    : null;
  const remainingCapacity = Math.max(targetAmount - committedAmount, 0);
  const targetReached = targetAmount > 0 && committedAmount >= targetAmount;
  const isClosed = closedReason === "target_reached"
    || closedReason === "manually_closed"
    || closedReason === "conversion_downloaded"
    || closedReason === "expired"
    || closedReason === "cancelled";
  const canInvest = !isClosed && Number(round.open) === 1 && remainingCapacity > 0;

  return {
    targetAmount,
    committedAmount,
    confirmedPaidAmount,
    remainingCapacity,
    closedReason,
    isClosed,
    targetReached,
    canInvest,
    status: isClosed
      ? (STATUS_REASON_MAP[closedReason] || "CLOSED")
      : (Number(round.open) === 1 ? "LIVE" : "DRAFT"),
    message: isClosed
      ? (CLOSED_MESSAGE_MAP[closedReason] || "Runden er avsluttet.")
      : null
  };
}

export async function getEmissionRoundColumns(connection) {
  const [columnRows] = await connection.query("SHOW COLUMNS FROM emission_rounds");
  return new Set(columnRows.map((column) => column.Field));
}

async function updateRoundClosure(connection, roundId, closedReason, columns) {
  const updates = ["open = 0"];
  const params = [];

  if (columns.has("status")) {
    updates.push("status = ?");
    params.push(STATUS_REASON_MAP[closedReason] || "CLOSED");
  }

  if (columns.has("closed_at")) {
    updates.push("closed_at = COALESCE(closed_at, NOW())");
  }

  if (columns.has("closed_reason")) {
    updates.push("closed_reason = ?");
    params.push(closedReason);
  }

  params.push(roundId);

  await connection.query(
    `UPDATE emission_rounds SET ${updates.join(", ")} WHERE id = ?`,
    params
  );
}

async function reopenRoundAfterCapacityDrop(connection, roundId, columns) {
  const updates = ["open = 1"];

  if (columns.has("status")) {
    updates.push("status = 'LIVE'");
  }

  if (columns.has("closed_at")) {
    updates.push("closed_at = NULL");
  }

  if (columns.has("closed_reason")) {
    updates.push("closed_reason = NULL");
  }

  await connection.query(
    `UPDATE emission_rounds SET ${updates.join(", ")} WHERE id = ?`,
    [roundId]
  );
}

export async function syncEmissionRoundAvailability(connection, roundId, options = {}) {
  const { lock = false } = options;
  const columns = await getEmissionRoundColumns(connection);
  const actualCommittedSelect = `(SELECT COALESCE(SUM(a.investment_amount), 0)
      FROM rc_agreements a
      WHERE a.round_id = er.id
        AND a.status = 'Active RC')`;
  const select = `
    SELECT
      er.id,
      er.startup_id,
      er.target_amount,
      er.amount_raised,
      ${columns.has("discount_rate") ? "er.discount_rate" : "NULL AS discount_rate"},
      ${columns.has("valuation_cap") ? "er.valuation_cap" : "NULL AS valuation_cap"},
      ${columns.has("conversion_years") ? "er.conversion_years" : "NULL AS conversion_years"},
      ${columns.has("trigger_period") ? "er.trigger_period" : "NULL AS trigger_period"},
      ${actualCommittedSelect} AS committed_amount,
      er.deadline,
      er.open,
      ${columns.has("status") ? "status" : "NULL AS status"},
      ${columns.has("closed_at") ? "closed_at" : "NULL AS closed_at"},
      ${columns.has("closed_reason") ? "closed_reason" : "NULL AS closed_reason"}
    FROM emission_rounds er
    WHERE er.id = ?
    ${lock ? "FOR UPDATE" : ""}
  `;

  const [rows] = await connection.query(select, [roundId]);

  if (!rows.length) {
    return null;
  }

  let round = rows[0];
  if (columns.has("committed_amount")) {
    await connection.query(
      `
      UPDATE emission_rounds
      SET committed_amount = ?
      WHERE id = ?
      `,
      [normalizeAmount(round.committed_amount), roundId]
    );
  }
  const now = Date.now();
  const deadlineTime = round.deadline ? new Date(round.deadline).getTime() : null;
  const expired = deadlineTime && !Number.isNaN(deadlineTime) && deadlineTime < now;
  const targetReached = normalizeAmount(round.target_amount) > 0
    && normalizeAmount(round.committed_amount) >= normalizeAmount(round.target_amount);

  if (
    round.closed_reason !== "cancelled" &&
    round.closed_reason !== "manually_closed" &&
    round.closed_reason !== "conversion_downloaded"
  ) {
    if (targetReached && round.closed_reason !== "target_reached") {
      await updateRoundClosure(connection, roundId, "target_reached", columns);
    } else if (!targetReached && round.closed_reason === "target_reached") {
      await reopenRoundAfterCapacityDrop(connection, roundId, columns);
    } else if (!targetReached && expired && round.closed_reason !== "expired") {
      await updateRoundClosure(connection, roundId, "expired", columns);
    }
  }

  if (
    (targetReached && round.closed_reason !== "target_reached") ||
    (!targetReached && round.closed_reason === "target_reached") ||
    (!targetReached && expired && round.closed_reason !== "expired")
  ) {
    const [updatedRows] = await connection.query(select, [roundId]);
    round = updatedRows[0];
  }

  if (!round.closed_reason) {
    if (targetReached) {
      round.closed_reason = "target_reached";
    } else if (expired && Number(round.open) === 0) {
      round.closed_reason = "expired";
    }
  }

  return {
    ...round,
    ...buildRoundAvailability(round)
  };
}

export function getCapacityExceededMessage(remainingCapacity) {
  const safeRemaining = Math.max(normalizeAmount(remainingCapacity), 0);
  const formatted = safeRemaining.toLocaleString("no-NO");
  return `Beløpet overstiger tilgjengelig kapasitet. Maks tilgjengelig beløp er ${formatted} NOK.`;
}
