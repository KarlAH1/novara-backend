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
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_admin_issues_status (status),
          INDEX idx_admin_issues_created_at (created_at),
          INDEX idx_admin_issues_emission_id (emission_id)
        )
      `);
    }
  } finally {
    connection.release();
  }
}
