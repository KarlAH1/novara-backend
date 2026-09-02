import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsRoot = path.resolve(__dirname, "../../frontend");

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function run() {
  if (await columnExists("startup_documents", "file_data")) {
    console.log("startup_documents.file_data already exists, skipping column add.");
  } else {
    console.log("Adding startup_documents.file_data...");
    await pool.query("ALTER TABLE startup_documents ADD COLUMN file_data LONGBLOB NULL");
  }

  if (await columnExists("startup_documents", "file_size")) {
    console.log("startup_documents.file_size already exists, skipping column add.");
  } else {
    console.log("Adding startup_documents.file_size...");
    await pool.query("ALTER TABLE startup_documents ADD COLUMN file_size INT NULL");
  }

  // Pull any file that still only exists on disk into the database.
  const [rows] = await pool.query(
    "SELECT id, url, filename FROM startup_documents WHERE file_data IS NULL AND url IS NOT NULL"
  );

  let moved = 0;
  let missing = 0;

  for (const row of rows) {
    const relative = String(row.url || "").replace(/^\/+/, "");
    const absolute = path.join(uploadsRoot, relative);

    try {
      const buffer = await fs.readFile(absolute);
      await pool.query(
        "UPDATE startup_documents SET file_data = ?, file_size = ? WHERE id = ?",
        [buffer, buffer.length, row.id]
      );
      console.log(`Moved #${row.id} (${row.filename}) — ${buffer.length} bytes`);
      moved += 1;
    } catch (err) {
      console.warn(`No file on disk for #${row.id} (${row.filename}): ${absolute}`);
      missing += 1;
    }
  }

  console.log(`\nDone. Moved ${moved}, missing ${missing}.`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
