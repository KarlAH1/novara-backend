import pool from "../config/db.js";

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function addColumnsIfMissing(table) {
  for (const column of ["stripe_fee_amount", "stripe_net_amount"]) {
    if (await columnExists(table, column)) {
      console.log(`${table}.${column} already exists, skipping.`);
      continue;
    }
    console.log(`Adding ${table}.${column}...`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} DECIMAL(10,2) NULL`);
  }
}

async function run() {
  await addColumnsIfMissing("rc_agreements");
  await addColumnsIfMissing("conversion_par_value_requests");
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
