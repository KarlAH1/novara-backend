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

export async function ensureAuthSchema() {
  const connection = await db.getConnection();

  try {
    const userColumns = [
      {
        name: "email_verified",
        sql: "ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0"
      },
      {
        name: "email_verification_token",
        sql: "ALTER TABLE users ADD COLUMN email_verification_token VARCHAR(64) NULL"
      },
      {
        name: "email_verification_expires",
        sql: "ALTER TABLE users ADD COLUMN email_verification_expires DATETIME NULL"
      },
      {
        name: "reset_password_token",
        sql: "ALTER TABLE users ADD COLUMN reset_password_token VARCHAR(64) NULL"
      },
      {
        name: "reset_password_expires",
        sql: "ALTER TABLE users ADD COLUMN reset_password_expires DATETIME NULL"
      },
      {
        name: "company_role_check_status",
        sql: "ALTER TABLE users ADD COLUMN company_role_check_status VARCHAR(32) NULL"
      },
      {
        name: "company_role_check_checked_at",
        sql: "ALTER TABLE users ADD COLUMN company_role_check_checked_at DATETIME NULL"
      },
      {
        name: "company_role_check_orgnr",
        sql: "ALTER TABLE users ADD COLUMN company_role_check_orgnr VARCHAR(9) NULL"
      },
      {
        name: "vipps_sub",
        sql: "ALTER TABLE users ADD COLUMN vipps_sub VARCHAR(128) NULL"
      },
      {
        name: "vipps_phone",
        sql: "ALTER TABLE users ADD COLUMN vipps_phone VARCHAR(32) NULL"
      },
      {
        name: "last_login_provider",
        sql: "ALTER TABLE users ADD COLUMN last_login_provider VARCHAR(32) NULL"
      },
      {
        name: "last_login_at",
        sql: "ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL"
      },
      {
        name: "last_login_ip",
        sql: "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(64) NULL"
      },
      {
        name: "startup_identity_provider",
        sql: "ALTER TABLE users ADD COLUMN startup_identity_provider VARCHAR(32) NULL"
      }
    ];

    for (const column of userColumns) {
      const exists = await columnExists(connection, "users", column.name);
      if (!exists) {
        await connection.query(column.sql);
      }
    }

    await connection.query(
      "ALTER TABLE users MODIFY COLUMN role ENUM('investor','startup','admin') NOT NULL"
    );

    const [indexes] = await connection.query(
      "SHOW INDEX FROM users WHERE Key_name = 'idx_users_vipps_sub'"
    );
    if (!indexes.length) {
      await connection.query("CREATE INDEX idx_users_vipps_sub ON users (vipps_sub)");
    }
  } finally {
    connection.release();
  }
}
