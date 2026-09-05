import db from "../config/db.js";

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [tableName, columnName]
  );
  return rows.length > 0;
}

/*
  Terms snapshot on the executed RC.

  Round terms are locked once the first investment exists, and the signed
  agreement HTML is locked at signature — but the company's share basis
  (par value, issued share count) lives in startup_profiles and can still be
  edited afterwards. Since the share price is Valuation Cap divided by the
  issued share count, an edit there would silently re-price an agreement that
  someone has already signed and paid for.

  So the economically relevant terms are copied onto the agreement when it is
  created. The snapshot is what the agreement was executed under; nothing later
  rewrites it.
*/
const COLUMNS = [
  ["terms_valuation_cap", "ALTER TABLE rc_agreements ADD COLUMN terms_valuation_cap DECIMAL(18,2) NULL"],
  ["terms_discount_rate", "ALTER TABLE rc_agreements ADD COLUMN terms_discount_rate DECIMAL(6,2) NULL"],
  ["terms_trigger_period_years", "ALTER TABLE rc_agreements ADD COLUMN terms_trigger_period_years INT NULL"],
  ["terms_par_value_per_share", "ALTER TABLE rc_agreements ADD COLUMN terms_par_value_per_share DECIMAL(12,4) NULL"],
  ["terms_capitalization_base_share_count", "ALTER TABLE rc_agreements ADD COLUMN terms_capitalization_base_share_count INT NULL"],
  ["terms_snapshot_at", "ALTER TABLE rc_agreements ADD COLUMN terms_snapshot_at DATETIME NULL"],
  ["legal_model_version", "ALTER TABLE rc_agreements ADD COLUMN legal_model_version VARCHAR(16) NULL"],
  ["calculation_version", "ALTER TABLE rc_agreements ADD COLUMN calculation_version VARCHAR(16) NULL"],
  ["agreement_template_version", "ALTER TABLE rc_agreements ADD COLUMN agreement_template_version VARCHAR(32) NULL"],

  /*
    Completion of the Chapter 10 process, recorded rather than inferred.

    The status column is deliberately left alone: eleven queries filter on
    'Active RC', and repurposing it would drop converted agreements out of the
    investor's and the company's history. RC history is never deleted, so
    completion is recorded alongside the agreement instead.
  */
  ["conversion_event_id", "ALTER TABLE rc_agreements ADD COLUMN conversion_event_id INT NULL"],
  ["converted_at", "ALTER TABLE rc_agreements ADD COLUMN converted_at DATETIME NULL"],
  ["converted_share_count", "ALTER TABLE rc_agreements ADD COLUMN converted_share_count INT NULL"],
  ["converted_par_amount", "ALTER TABLE rc_agreements ADD COLUMN converted_par_amount DECIMAL(12,2) NULL"]
];

export async function ensureRcAgreementSchema() {
  const connection = await db.getConnection();

  try {
    const [tables] = await connection.query(
      `
      SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rc_agreements'
      LIMIT 1
      `
    );
    if (!tables.length) return;

    for (const [columnName, sql] of COLUMNS) {
      if (!(await columnExists(connection, "rc_agreements", columnName))) {
        await connection.query(sql);
      }
    }
  } finally {
    connection.release();
  }
}
