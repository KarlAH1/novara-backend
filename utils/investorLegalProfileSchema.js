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

export async function ensureInvestorLegalProfileSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "investor_legal_profiles");
    if (!exists) {
      await connection.query(`
        CREATE TABLE investor_legal_profiles (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          full_name VARCHAR(255) NULL,
          birth_date DATE NULL,
          digital_address VARCHAR(255) NULL,
          residential_address VARCHAR(255) NULL,
          postal_code VARCHAR(32) NULL,
          city VARCHAR(128) NULL,
          country VARCHAR(128) NULL,
          completed_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_investor_legal_profile_user (user_id)
        )
      `);
      return;
    }

    const additions = [
      ["full_name", "ALTER TABLE investor_legal_profiles ADD COLUMN full_name VARCHAR(255) NULL"],
      ["birth_date", "ALTER TABLE investor_legal_profiles ADD COLUMN birth_date DATE NULL"],
      ["digital_address", "ALTER TABLE investor_legal_profiles ADD COLUMN digital_address VARCHAR(255) NULL"],
      ["residential_address", "ALTER TABLE investor_legal_profiles ADD COLUMN residential_address VARCHAR(255) NULL"],
      ["postal_code", "ALTER TABLE investor_legal_profiles ADD COLUMN postal_code VARCHAR(32) NULL"],
      ["city", "ALTER TABLE investor_legal_profiles ADD COLUMN city VARCHAR(128) NULL"],
      ["country", "ALTER TABLE investor_legal_profiles ADD COLUMN country VARCHAR(128) NULL"],
      ["completed_at", "ALTER TABLE investor_legal_profiles ADD COLUMN completed_at DATETIME NULL"]
    ];

    for (const [columnName, sql] of additions) {
      if (!(await columnExists(connection, "investor_legal_profiles", columnName))) {
        await connection.query(sql);
      }
    }
  } finally {
    connection.release();
  }
}
