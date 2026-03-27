import db from "../config/db.js";

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );

  return rows.length > 0;
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `
    SELECT 1
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    LIMIT 1
    `,
    [tableName]
  );

  return rows.length > 0;
}

export async function ensureEmissionRoundSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "emission_rounds");
    if (!exists) {
      return;
    }

    const columns = [
      {
        name: "trigger_period",
        sql: "ALTER TABLE emission_rounds ADD COLUMN trigger_period INT NULL"
      },
      {
        name: "committed_amount",
        sql: "ALTER TABLE emission_rounds ADD COLUMN committed_amount INT NOT NULL DEFAULT 0"
      },
      {
        name: "closed_at",
        sql: "ALTER TABLE emission_rounds ADD COLUMN closed_at DATETIME NULL"
      },
      {
        name: "closed_reason",
        sql: "ALTER TABLE emission_rounds ADD COLUMN closed_reason VARCHAR(32) NULL"
      }
    ];

    for (const column of columns) {
      const exists = await columnExists(connection, "emission_rounds", column.name);
      if (!exists) {
        await connection.query(column.sql);
      }
    }

    await connection.query(
      `
      UPDATE emission_rounds er
      LEFT JOIN (
        SELECT
          round_id,
          COALESCE(SUM(investment_amount), 0) AS committed_amount
        FROM rc_agreements
        WHERE status = 'Active RC'
        GROUP BY round_id
      ) committed ON committed.round_id = er.id
      SET er.committed_amount = COALESCE(committed.committed_amount, 0)
      `
    );

    if (await columnExists(connection, "emission_rounds", "trigger_period")) {
      await connection.query(
        `
        UPDATE emission_rounds
        SET trigger_period = COALESCE(trigger_period, conversion_years)
        `
      );
    }
  } finally {
    connection.release();
  }
}
