export async function getLatestCompletedRound(connection, startupId) {
  const [rows] = await connection.query(
    `
    SELECT id, closed_at, created_at, closed_reason
    FROM emission_rounds
    WHERE startup_id = ?
      AND closed_reason IS NOT NULL
      AND closed_reason <> ''
    ORDER BY COALESCE(closed_at, created_at) DESC, id DESC
    LIMIT 1
    `,
    [startupId]
  );

  return rows[0] || null;
}

export async function getLegalResetCutoff(connection, startupId) {
  const latestCompletedRound = await getLatestCompletedRound(connection, startupId);
  return latestCompletedRound?.closed_at || latestCompletedRound?.created_at || null;
}

