import db from "../config/db.js";

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

export async function ensureConversionSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "conversion_events");
    if (!exists) {
      await connection.query(`
        CREATE TABLE conversion_events (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          startup_id INT NOT NULL,
          round_id INT NOT NULL,
          trigger_type VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'triggered',
          priced_round_share_price DECIMAL(12,4) NULL,
          board_document_id INT NULL,
          gf_document_id INT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_conversion_events_startup_id (startup_id),
          INDEX idx_conversion_events_round_id (round_id)
        )
      `);
    } else {
      const additions = [
        ["priced_round_share_price", "ALTER TABLE conversion_events ADD COLUMN priced_round_share_price DECIMAL(12,4) NULL"]
      ];

      for (const [columnName, sql] of additions) {
        if (!(await columnExists(connection, "conversion_events", columnName))) {
          await connection.query(sql);
        }
      }
    }
  } finally {
    connection.release();
  }
}
