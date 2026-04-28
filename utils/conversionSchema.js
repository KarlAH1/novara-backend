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
        ["round_id", "ALTER TABLE conversion_events ADD COLUMN round_id INT NOT NULL DEFAULT 0"],
        ["priced_round_share_price", "ALTER TABLE conversion_events ADD COLUMN priced_round_share_price DECIMAL(12,4) NULL"],
        ["conversion_date", "ALTER TABLE conversion_events ADD COLUMN conversion_date DATETIME NULL"],
        ["par_value_due_date", "ALTER TABLE conversion_events ADD COLUMN par_value_due_date DATETIME NULL"],
        ["preparation_started_at", "ALTER TABLE conversion_events ADD COLUMN preparation_started_at DATETIME NULL"],
        ["started_automatically", "ALTER TABLE conversion_events ADD COLUMN started_automatically TINYINT(1) NOT NULL DEFAULT 0"],
        ["third_party_name", "ALTER TABLE conversion_events ADD COLUMN third_party_name VARCHAR(255) NULL"],
        ["third_party_email", "ALTER TABLE conversion_events ADD COLUMN third_party_email VARCHAR(255) NULL"],
        ["third_party_confirmed_at", "ALTER TABLE conversion_events ADD COLUMN third_party_confirmed_at DATETIME NULL"],
        ["calculations_json", "ALTER TABLE conversion_events ADD COLUMN calculations_json LONGTEXT NULL"],
        ["updated_articles_document_id", "ALTER TABLE conversion_events ADD COLUMN updated_articles_document_id INT NULL"],
        ["shareholder_register_document_id", "ALTER TABLE conversion_events ADD COLUMN shareholder_register_document_id INT NULL"],
        ["capital_confirmation_document_id", "ALTER TABLE conversion_events ADD COLUMN capital_confirmation_document_id INT NULL"],
        ["altinn_package_document_id", "ALTER TABLE conversion_events ADD COLUMN altinn_package_document_id INT NULL"]
      ];

      for (const [columnName, sql] of additions) {
        if (!(await columnExists(connection, "conversion_events", columnName))) {
          await connection.query(sql);
        }
      }

      if (!(await columnExists(connection, "conversion_events", "round_id"))) {
        await connection.query("ALTER TABLE conversion_events ADD INDEX idx_conversion_events_round_id (round_id)");
      }
    }

    const parValueTableExists = await tableExists(connection, "conversion_par_value_requests");
    if (!parValueTableExists) {
      await connection.query(`
        CREATE TABLE conversion_par_value_requests (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          conversion_event_id INT NOT NULL,
          agreement_id INT NOT NULL,
          investor_id INT NOT NULL,
          investor_name VARCHAR(255) NULL,
          investor_email VARCHAR(255) NULL,
          par_value_amount DECIMAL(12,2) NOT NULL,
          reference VARCHAR(128) NULL,
          due_date DATETIME NOT NULL,
          notice_sent_at DATETIME NULL,
          paid_confirmed_at DATETIME NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'pending_notice',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_conversion_agreement (conversion_event_id, agreement_id),
          INDEX idx_conversion_par_value_event (conversion_event_id)
        )
      `);
    } else if (!(await columnExists(connection, "conversion_par_value_requests", "reference"))) {
      await connection.query("ALTER TABLE conversion_par_value_requests ADD COLUMN reference VARCHAR(128) NULL AFTER par_value_amount");
    }
  } finally {
    connection.release();
  }
}
