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

export async function ensureStartupPlanSchema() {
  const connection = await db.getConnection();

  try {
    const subscriptionsExists = await tableExists(connection, "startup_plan_subscriptions");
    if (!subscriptionsExists) {
      await connection.query(`
        CREATE TABLE startup_plan_subscriptions (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          company_id INT NOT NULL,
          user_id INT NOT NULL,
          plan_code VARCHAR(32) NOT NULL,
          billing_period VARCHAR(32) NOT NULL DEFAULT 'annual',
          list_price_nok INT NOT NULL DEFAULT 0,
          final_price_nok INT NOT NULL DEFAULT 0,
          status VARCHAR(32) NOT NULL DEFAULT 'payment_required',
          activation_source VARCHAR(32) NULL,
          payment_reference VARCHAR(128) NULL,
          discount_code_id INT NULL,
          starts_at DATETIME NULL,
          expires_at DATETIME NULL,
          activated_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_startup_plan_company_status (company_id, status),
          INDEX idx_startup_plan_company_created (company_id, created_at)
        )
      `);
    }

    const codesExists = await tableExists(connection, "startup_discount_codes");
    if (!codesExists) {
      await connection.query(`
        CREATE TABLE startup_discount_codes (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(64) NOT NULL UNIQUE,
          active TINYINT(1) NOT NULL DEFAULT 1,
          allowed_plan VARCHAR(32) NOT NULL DEFAULT 'normal',
          discount_type VARCHAR(32) NOT NULL DEFAULT 'full',
          discount_percent INT NOT NULL DEFAULT 100,
          max_redemptions INT NOT NULL DEFAULT 1,
          times_redeemed INT NOT NULL DEFAULT 0,
          created_by_user_id INT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_startup_discount_active (active, allowed_plan)
        )
      `);
    }

    const redemptionsExists = await tableExists(connection, "startup_discount_redemptions");
    if (!redemptionsExists) {
      await connection.query(`
        CREATE TABLE startup_discount_redemptions (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          discount_code_id INT NOT NULL,
          company_id INT NOT NULL,
          user_id INT NOT NULL,
          subscription_id INT NULL,
          plan_code VARCHAR(32) NOT NULL,
          redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_startup_discount_company (discount_code_id, company_id),
          INDEX idx_startup_discount_redemptions_company (company_id, redeemed_at)
        )
      `);
    }
  } finally {
    connection.release();
  }
}
