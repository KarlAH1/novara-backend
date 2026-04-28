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

export async function ensureAdminIssueSchema() {
  const connection = await db.getConnection();

  try {
    const exists = await tableExists(connection, "admin_issues");
    if (!exists) {
      await connection.query(`
        CREATE TABLE admin_issues (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          startup_id INT NOT NULL,
          emission_id INT NULL,
          source VARCHAR(64) NOT NULL DEFAULT 'dashboard',
          issue_type VARCHAR(64) NOT NULL DEFAULT 'general',
          message TEXT NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
          admin_response TEXT NULL,
          resolved_by INT NULL,
          resolved_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_admin_issues_status (status),
          INDEX idx_admin_issues_created_at (created_at),
          INDEX idx_admin_issues_emission_id (emission_id)
        )
      `);
    } else {
      const hasAdminResponse = await columnExists(connection, "admin_issues", "admin_response");
      if (!hasAdminResponse) {
        await connection.query("ALTER TABLE admin_issues ADD COLUMN admin_response TEXT NULL");
      }
      const hasResolvedBy = await columnExists(connection, "admin_issues", "resolved_by");
      if (!hasResolvedBy) {
        await connection.query("ALTER TABLE admin_issues ADD COLUMN resolved_by INT NULL");
      }
      const hasResolvedAt = await columnExists(connection, "admin_issues", "resolved_at");
      if (!hasResolvedAt) {
        await connection.query("ALTER TABLE admin_issues ADD COLUMN resolved_at DATETIME NULL");
      }
    }

    const messagesTableExists = await tableExists(connection, "admin_issue_messages");
    if (!messagesTableExists) {
      await connection.query(`
        CREATE TABLE admin_issue_messages (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          issue_id INT NOT NULL,
          sender_user_id INT NOT NULL,
          sender_role VARCHAR(32) NOT NULL,
          message TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_admin_issue_messages_issue_id (issue_id),
          INDEX idx_admin_issue_messages_created_at (created_at)
        )
      `);
    }
  } finally {
    connection.release();
  }
}
