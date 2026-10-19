import db from "../config/db.js";

/*
  Columns the Stripe integration and the payment flow write to.

  These were never created by any migration in the repository: a database
  built from scripts/bootstrapLocalDb.js plus the ensure*Schema functions did
  not have them, so Stripe Connect onboarding, RC checkout, par amount checkout
  and plan checkout all failed with "Unknown column" on a fresh database. If
  production received them by hand, this is a no-op there; if it did not, the
  first real payment would have failed.

  Every column is nullable or defaulted and only added when missing, so this is
  safe to run on every boot.
*/

const STRIPE_SESSION_COLUMNS = [
  ["stripe_checkout_session_id", "VARCHAR(255) NULL"],
  ["stripe_payment_intent_id", "VARCHAR(255) NULL"],
  ["stripe_paid_at", "DATETIME NULL"]
];

// Stripe's processing fee on a direct charge and what reached the company.
const STRIPE_FEE_COLUMNS = [
  ["stripe_fee_amount", "DECIMAL(10,2) NULL"],
  ["stripe_net_amount", "DECIMAL(10,2) NULL"]
];

export const PAYMENT_COLUMNS = {
  companies: [
    ["stripe_account_id", "VARCHAR(255) NULL"],
    ["stripe_charges_enabled", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["stripe_payouts_enabled", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["stripe_onboarded_at", "DATETIME NULL"]
  ],
  rc_agreements: [
    ["payment_method", "VARCHAR(32) NULL"],
    ...STRIPE_SESSION_COLUMNS,
    ...STRIPE_FEE_COLUMNS,
    ["investor_marked_paid_at", "DATETIME NULL"],
    ["payment_reminder_sent_at", "DATETIME NULL"],
    ["cancelled_at", "DATETIME NULL"],
    ["cancelled_by", "VARCHAR(32) NULL"],
    ["cancellation_reason", "VARCHAR(255) NULL"]
  ],
  conversion_par_value_requests: [...STRIPE_SESSION_COLUMNS, ...STRIPE_FEE_COLUMNS],
  startup_plan_subscriptions: STRIPE_SESSION_COLUMNS
};

async function tableExists(connection, tableName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

// Runs after the schemas that create these tables.
export async function ensurePaymentSchema() {
  const connection = await db.getConnection();
  try {
    for (const [tableName, columns] of Object.entries(PAYMENT_COLUMNS)) {
      if (!(await tableExists(connection, tableName))) continue;
      for (const [columnName, definition] of columns) {
        if (!(await columnExists(connection, tableName, columnName))) {
          await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
        }
      }
    }
  } finally {
    connection.release();
  }
}
