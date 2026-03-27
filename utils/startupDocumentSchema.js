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

export async function ensureStartupDocumentSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "startup_documents");
    if (!exists) {
      return;
    }

    const additions = [
      ["document_type", "ALTER TABLE startup_documents ADD COLUMN document_type VARCHAR(64) NOT NULL DEFAULT 'pitch_deck'"],
      ["mime_type", "ALTER TABLE startup_documents ADD COLUMN mime_type VARCHAR(128) NULL"],
      ["uploaded_by_user_id", "ALTER TABLE startup_documents ADD COLUMN uploaded_by_user_id INT NULL"],
      ["status", "ALTER TABLE startup_documents ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'uploaded'"],
      ["visible_in_document_room", "ALTER TABLE startup_documents ADD COLUMN visible_in_document_room TINYINT(1) NOT NULL DEFAULT 1"],
      ["used_for_conversion", "ALTER TABLE startup_documents ADD COLUMN used_for_conversion TINYINT(1) NOT NULL DEFAULT 0"],
      ["parse_status", "ALTER TABLE startup_documents ADD COLUMN parse_status VARCHAR(32) NOT NULL DEFAULT 'not_started'"],
      ["parsed_fields_json", "ALTER TABLE startup_documents ADD COLUMN parsed_fields_json LONGTEXT NULL"],
      ["extracted_text", "ALTER TABLE startup_documents ADD COLUMN extracted_text LONGTEXT NULL"]
    ];

    for (const [columnName, sql] of additions) {
      if (!(await columnExists(connection, "startup_documents", columnName))) {
        await connection.query(sql);
      }
    }

    await connection.query(
      `
      UPDATE startup_documents
      SET document_type = 'pitch_deck'
      WHERE document_type IS NULL OR document_type = ''
      `
    );
  } finally {
    connection.release();
  }
}
