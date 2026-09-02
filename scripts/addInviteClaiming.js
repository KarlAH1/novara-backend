import pool from "../config/db.js";

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function run() {
  const additions = [
    ["claimed_by_user_id", "ALTER TABLE rc_invites ADD COLUMN claimed_by_user_id INT NULL"],
    ["claimed_at", "ALTER TABLE rc_invites ADD COLUMN claimed_at DATETIME NULL"]
  ];

  for (const [column, sql] of additions) {
    if (await columnExists("rc_invites", column)) {
      console.log(`rc_invites.${column} already exists, skipping.`);
      continue;
    }
    console.log(`Adding rc_invites.${column}...`);
    await pool.query(sql);
  }

  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
