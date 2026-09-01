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
  if (await columnExists("investor_legal_profiles", "national_id_encrypted")) {
    console.log("investor_legal_profiles.national_id_encrypted already exists, skipping.");
  } else {
    console.log("Adding investor_legal_profiles.national_id_encrypted...");
    await pool.query(
      `ALTER TABLE investor_legal_profiles ADD COLUMN national_id_encrypted TEXT NULL`
    );
  }
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
