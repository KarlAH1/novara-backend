import { createExpiry, createRawToken, hashToken } from "./authSecurity.js";
import { sendEmail } from "./emailService.js";

export function isEmailVerificationRequired() {
  const explicit = String(process.env.AUTH_REQUIRE_EMAIL_VERIFICATION || "").trim().toLowerCase();
  if (explicit === "true") return true;
  return false;
}

function getFrontendBase() {
  const base = String(process.env.FRONTEND_URL || "").trim();
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

async function storeEmailVerificationToken(executor, userId) {
  const rawToken = createRawToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = createExpiry(24);

  await executor.query(
    `
    UPDATE users
    SET email_verification_token = ?, email_verification_expires = ?, email_verified = 0
    WHERE id = ?
    `,
    [hashedToken, expiresAt, userId]
  );

  return rawToken;
}

export async function sendVerificationEmail(executor, { userId, email, name }) {
  const rawToken = await storeEmailVerificationToken(executor, userId);
  const verifyUrl = `${getFrontendBase()}/verify-email.html?token=${encodeURIComponent(rawToken)}`;
  const greeting = name ? `Hei ${name},` : "Hei,";

  await sendEmail({
    to: email,
    subject: "Bekreft e-posten din for Raisium",
    text: `${greeting}\n\nBekreft e-posten din ved å åpne denne lenken:\n${verifyUrl}\n\nLenken utløper om 24 timer.`,
    html: `
      <p>${greeting}</p>
      <p>Bekreft e-posten din for å aktivere innloggingen i Raisium.</p>
      <p><a href="${verifyUrl}">Bekreft e-post</a></p>
      <p>Hvis knappen ikke virker, bruk denne lenken:</p>
      <p>${verifyUrl}</p>
      <p>Lenken utløper om 24 timer.</p>
    `
  });
}

export async function sendPasswordResetEmail(executor, { userId, email, name }) {
  const rawToken = createRawToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = createExpiry(1);

  await executor.query(
    `
    UPDATE users
    SET reset_password_token = ?, reset_password_expires = ?
    WHERE id = ?
    `,
    [hashedToken, expiresAt, userId]
  );

  const resetUrl = `${getFrontendBase()}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
  const greeting = name ? `Hei ${name},` : "Hei,";

  await sendEmail({
    to: email,
    subject: "Tilbakestill passordet ditt i Raisium",
    text: `${greeting}\n\nDu kan sette et nytt passord her:\n${resetUrl}\n\nLenken utløper om 1 time.`,
    html: `
      <p>${greeting}</p>
      <p>Du ba om å tilbakestille passordet ditt i Raisium.</p>
      <p><a href="${resetUrl}">Sett nytt passord</a></p>
      <p>Hvis knappen ikke virker, bruk denne lenken:</p>
      <p>${resetUrl}</p>
      <p>Lenken utløper om 1 time.</p>
    `
  });
}

export async function sendStartupRegistrationCodeEmail({ email, code }) {
  const safeEmail = String(email || "").trim().toLowerCase();
  const safeCode = String(code || "").trim();

  await sendEmail({
    to: safeEmail,
    subject: "Din kode for startup-registrering i Raisium",
    text: `Hei,\n\nKoden din for å fortsette startup-registreringen i Raisium er: ${safeCode}\n\nKoden utløper om 15 minutter.`,
    html: `
      <p>Hei,</p>
      <p>Koden din for å fortsette startup-registreringen i Raisium er:</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:0.18em;">${safeCode}</p>
      <p>Koden utløper om 15 minutter.</p>
    `
  });
}

export async function sendInvestorInviteAccessCodeEmail({ email, code }) {
  const safeEmail = String(email || "").trim().toLowerCase();
  const safeCode = String(code || "").trim();

  await sendEmail({
    to: safeEmail,
    subject: "Din kode for investor-tilgang i Raisium",
    text: `Hei,\n\nKoden din for å åpne investorportalen i Raisium er: ${safeCode}\n\nKoden utløper om 15 minutter.`,
    html: `
      <p>Hei,</p>
      <p>Koden din for å åpne investorportalen i Raisium er:</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:0.18em;">${safeCode}</p>
      <p>Koden utløper om 15 minutter.</p>
    `
  });
}
