import "../config/env.js";
import bcrypt from "bcryptjs";
import pool, { closePool } from "../config/db.js";

const email = String(process.env.ADMIN_EMAIL || "karl.admin@raisium.io").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "Abcdef1243-1");
const name = String(process.env.ADMIN_NAME || "Karl Admin").trim();

async function createAdminUser() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET mangler. Last miljøvariabler før admin-bruker opprettes.");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `
    INSERT INTO users (name, email, password, role, email_verified, last_login_provider)
    VALUES (?, ?, ?, 'admin', 1, 'password')
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      password = VALUES(password),
      role = 'admin',
      email_verified = 1,
      last_login_provider = 'password'
    `,
    [name, email, passwordHash]
  );

  console.log(`Admin user ready: ${email}`);
}

createAdminUser()
  .catch((error) => {
    console.error("Could not create admin user:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
