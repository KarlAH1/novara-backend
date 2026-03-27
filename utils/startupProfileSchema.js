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

export async function ensureStartupProfileSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "startup_profiles");
    if (!exists) {
      return;
    }

    const textColumns = ["sector", "pitch", "vision"];

    for (const columnName of textColumns) {
      const exists = await columnExists(connection, "startup_profiles", columnName);
      if (!exists) {
        continue;
      }

      await connection.query(
        `ALTER TABLE startup_profiles MODIFY COLUMN ${columnName} TEXT NULL`
      );
    }

    const additions = [
      ["nominal_value_per_share", "ALTER TABLE startup_profiles ADD COLUMN nominal_value_per_share DECIMAL(12,2) NULL"],
      ["current_share_count", "ALTER TABLE startup_profiles ADD COLUMN current_share_count INT NULL"],
      ["share_basis_temporary", "ALTER TABLE startup_profiles ADD COLUMN share_basis_temporary TINYINT(1) NOT NULL DEFAULT 0"]
    ];

    for (const [columnName, sql] of additions) {
      if (!(await columnExists(connection, "startup_profiles", columnName))) {
        await connection.query(sql);
      }
    }
  } finally {
    connection.release();
  }
}
