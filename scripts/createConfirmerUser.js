import "../config/env.js";
import bcrypt from "bcryptjs";
import pool, { closePool } from "../config/db.js";

/*
  Creates or updates the account of a revisor Raisium pays to confirm
  payments (see utils/paymentConfirmations.js). The confirmer signs in at
  login.html and lands on bekreftelser.html.

    CONFIRMER_EMAIL=… CONFIRMER_NAME="…" CONFIRMER_PASSWORD=… npm run confirmer:create
*/

const email = String(process.env.CONFIRMER_EMAIL || "").trim().toLowerCase();
const name = String(process.env.CONFIRMER_NAME || "").trim();
const password = String(process.env.CONFIRMER_PASSWORD || "");

async function createConfirmerUser() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
    throw new Error("Sett CONFIRMER_EMAIL og CONFIRMER_NAME.");
  }
  if (password.length < 12) {
    throw new Error("Sett CONFIRMER_PASSWORD (minst 12 tegn).");
  }

  const [existing] = await pool.query("SELECT id, role FROM users WHERE email = ? LIMIT 1", [email]);
  if (existing.length && existing[0].role !== "confirmer") {
    throw new Error(`${email} finnes allerede som ${existing[0].role}. Bruk en egen e-postadresse for bekrefteren.`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (name, email, password, role, email_verified, last_login_provider)
     VALUES (?, ?, ?, 'confirmer', 1, 'password')
     ON DUPLICATE KEY UPDATE name = VALUES(name), password = VALUES(password), email_verified = 1`,
    [name, email, passwordHash]
  );
  console.log(`Confirmer ready: ${email}`);
}

createConfirmerUser()
  .catch((error) => {
    console.error("Could not create confirmer:", error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
