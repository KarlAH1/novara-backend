import "../config/env.js";
import fs from "fs";
import os from "os";
import path from "path";
import mysql from "mysql2/promise";
import { assertConfirmedTarget, describeDatabaseTarget } from "../utils/dbSafety.js";

/*
  Empties the database for a clean start. Keeps the admin accounts and the
  discount codes; every other row in every table is deleted.

  Without flags it only reports what it would delete. Deleting needs both
  --confirm=<DB_NAME>@<DB_HOST> and --yes, and writes a JSON backup of every
  table to ~/Developer/novara-backups first.

  backend/.env.local wins over backend/.env, so to reach the database in .env
  run it as:  node --env-file=.env scripts/cleanNonAdminLaunchData.js

  Rows are removed with DELETE, not TRUNCATE, so AUTO_INCREMENT keeps counting:
  Stripe idempotency keys are built from row ids, and an id reused within 24
  hours would hand back an earlier, already paid Checkout session.
*/

const KEEP_TABLES = new Set(["startup_discount_codes"]);
// Reference data, never user data.
const KEEP_PATTERN = /migration|setting|config/i;

const argv = process.argv;
const execute = argv.includes("--yes");
const target = describeDatabaseTarget();

if (execute) {
  try {
    assertConfirmedTarget("cleanNonAdminLaunchData");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

function planFor(table) {
  if (table === "users") return "behold admin, slett resten";
  if (KEEP_TABLES.has(table) || KEEP_PATTERN.test(table)) return "beholdes";
  return "tømmes";
}

async function tableCounts(conn) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  const counts = [];
  for (const { name } of tables) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
    counts.push({ name, rows: Number(n) });
  }
  return counts;
}

async function writeBackup(conn, tables) {
  const dir = path.join(os.homedir(), "Developer", "novara-backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${process.env.DB_NAME || "db"}-${stamp}.json`);
  const backup = { target, created_at: new Date().toISOString(), tables: {} };
  for (const { name } of tables) {
    const [rows] = await conn.query(`SELECT * FROM \`${name}\``);
    backup.tables[name] = rows;
  }
  // Uploaded files live in BLOB columns; keep them as base64.
  fs.writeFileSync(file, JSON.stringify(backup, (key, value) =>
    value && value.type === "Buffer" && Array.isArray(value.data)
      ? { base64: Buffer.from(value.data).toString("base64") }
      : value
  ));
  return file;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    const before = await tableCounts(conn);
    const [[{ admins }]] = await conn.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin'");

    console.log(`Database: ${target}`);
    console.log(`Admin-brukere som beholdes: ${admins}`);
    for (const { name, rows } of before) {
      if (rows) console.log(`  ${name.padEnd(40)} ${String(rows).padStart(7)}  ${planFor(name)}`);
    }

    if (!Number(admins)) {
      throw new Error("Fant ingen admin-bruker. Avbryter, så du ikke låser deg ute.");
    }

    if (!execute) {
      console.log(`\nIngenting er slettet. For å slette, kjør på nytt med:\n  --confirm=${target} --yes`);
      return;
    }

    const backupFile = await writeBackup(conn, before);
    console.log(`\nSikkerhetskopi: ${backupFile}`);

    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    await conn.beginTransaction();
    for (const { name } of before) {
      const plan = planFor(name);
      if (plan === "beholdes") continue;
      if (name === "users") {
        await conn.query("DELETE FROM users WHERE role <> 'admin'");
      } else {
        await conn.query(`DELETE FROM \`${name}\``);
      }
    }
    // The redemptions are gone, so the codes can be used again.
    const [redeemedColumn] = await conn.query("SHOW COLUMNS FROM startup_discount_codes LIKE 'times_redeemed'").catch(() => [[]]);
    if (redeemedColumn.length) {
      await conn.query("UPDATE startup_discount_codes SET times_redeemed = 0");
    }
    await conn.commit();
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");

    const after = await tableCounts(conn);
    const left = after.filter(({ rows }) => rows > 0).map(({ name, rows }) => `${name}=${rows}`);
    const [remainingAdmins] = await conn.query("SELECT email FROM users WHERE role = 'admin' ORDER BY id");
    console.log(`Ferdig. Rader igjen: ${left.join(", ") || "ingen"}`);
    console.log(`Admin-brukere: ${remainingAdmins.map((row) => row.email).join(", ")}`);
  } catch (error) {
    await conn.rollback().catch(() => {});
    await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

await main();
