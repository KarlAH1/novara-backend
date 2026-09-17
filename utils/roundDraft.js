export const ROUND_DRAFT_STEP_COUNT = 3;

function draftText(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function positiveNumberOrNull(value, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return integer ? Math.round(parsed) : parsed;
}

export function normalizeRoundDraftPayload(input = {}) {
  const requestedStep = Number(input.lastStep ?? input.last_step ?? 1);
  const lastStep = Number.isFinite(requestedStep)
    ? Math.min(ROUND_DRAFT_STEP_COUNT, Math.max(1, Math.round(requestedStep)))
    : 1;

  const shareholders = Array.isArray(input.shareholders)
    ? input.shareholders.slice(0, 200).map((shareholder) => {
        const source = shareholder?.source === "shares" ? "shares" : "percent";
        return {
          name: draftText(shareholder?.name, 200).trim(),
          source,
          ownership_percent: source === "percent"
            ? positiveNumberOrNull(shareholder?.ownership_percent)
            : null,
          share_count: source === "shares"
            ? positiveNumberOrNull(shareholder?.share_count, { integer: true })
            : null
        };
      })
    : [];

  return {
    lastStep,
    fields: {
      conversion_years: draftText(input.fields?.conversion_years, 16),
      discount_rate: draftText(input.fields?.discount_rate, 24),
      valuation_cap: draftText(input.fields?.valuation_cap, 48),
      bank_account: draftText(input.fields?.bank_account, 64)
    },
    shareholders
  };
}

export function parseRoundDraftRow(row) {
  if (!row) return null;
  try {
    const stored = typeof row.draft_json === "string"
      ? JSON.parse(row.draft_json)
      : row.draft_json;
    return {
      ...normalizeRoundDraftPayload({ ...stored, lastStep: row.last_step }),
      roundId: Number(row.round_id),
      updatedAt: row.updated_at || null
    };
  } catch {
    return null;
  }
}

export async function loadRoundDraft(connection, roundId) {
  const [rows] = await connection.query(
    `SELECT round_id, draft_json, last_step, updated_at
     FROM emission_round_drafts
     WHERE round_id = ?
     LIMIT 1`,
    [roundId]
  );
  return parseRoundDraftRow(rows[0]);
}

export async function saveRoundDraft(connection, { roundId, startupId, draft }) {
  const normalized = normalizeRoundDraftPayload(draft);
  await connection.query(
    `INSERT INTO emission_round_drafts
       (round_id, startup_id, draft_json, last_step, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       startup_id = VALUES(startup_id),
       draft_json = VALUES(draft_json),
       last_step = VALUES(last_step),
       updated_at = NOW()`,
    [roundId, startupId, JSON.stringify(normalized), normalized.lastStep]
  );
  return loadRoundDraft(connection, roundId);
}

export async function deleteRoundDraft(connection, roundId) {
  await connection.query("DELETE FROM emission_round_drafts WHERE round_id = ?", [roundId]);
}

export async function getLatestStartupRoundDraft(connection, startupId) {
  const [rows] = await connection.query(
    `SELECT d.round_id, d.draft_json, d.last_step, d.updated_at
     FROM emission_round_drafts d
     JOIN emission_rounds r ON r.id = d.round_id
     WHERE d.startup_id = ?
       AND r.open = 0
       AND (r.closed_reason IS NULL OR r.closed_reason = '')
     ORDER BY d.updated_at DESC
     LIMIT 1`,
    [startupId]
  );
  return parseRoundDraftRow(rows[0]);
}
