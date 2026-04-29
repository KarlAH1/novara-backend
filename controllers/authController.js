import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.js";
import { checkCompanyRoleMatch } from "../utils/companyRoleCheck.js";
import { ensureCompanyAndMembership } from "../utils/companyMembership.js";
import {
  isEmailVerificationRequired,
  sendStartupRegistrationCodeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail
} from "../utils/authEmailFlow.js";
import { createExpiry, createRawToken, hashToken, validatePasswordRequirements } from "../utils/authSecurity.js";
import { sendTelegramAdminAlert } from "../utils/telegramNotifier.js";
import {
  buildVippsAuthorizationUrl,
  createVippsState,
  exchangeVippsCodeForTokens,
  fetchVippsUserinfo,
  isVippsLoginConfigured,
  verifyVippsIdToken,
  verifyVippsState
} from "../utils/vippsLogin.js";
import { getClientIp, logAuditEvent } from "../utils/auditLogger.js";

function createAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: String(user.role || "").toLowerCase(),
      email: user.email
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function createSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function consumeStartupEmailVerification(connection, email, rawVerificationToken) {
  const safeEmail = String(email || "").trim().toLowerCase();
  const safeTokenHash = hashToken(rawVerificationToken);

  const [rows] = await connection.query(
    `
    SELECT id, expires_at, verified_at, consumed_at
    FROM startup_email_verifications
    WHERE email = ?
      AND verification_token_hash = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [safeEmail, safeTokenHash]
  );

  const record = rows[0];
  if (!record) {
    return { ok: false, error: "E-postkoden er ikke verifisert eller har utløpt." };
  }

  const expiresAt = new Date(record.expires_at);
  if (!record.verified_at || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "E-postkoden er ikke verifisert eller har utløpt." };
  }

  if (record.consumed_at) {
    return { ok: false, error: "E-postkoden er allerede brukt. Be om en ny kode." };
  }

  await connection.query(
    `
    UPDATE startup_email_verifications
    SET consumed_at = NOW()
    WHERE id = ?
    `,
    [record.id]
  );

  return { ok: true };
}

export const sendStartupRegistrationCode = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Skriv inn en gyldig e-postadresse." });
    }

    const [existing] = await connection.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    if (existing.length) {
      return res.status(400).json({ success: false, error: "E-post er allerede registrert." });
    }

    const code = createSixDigitCode();
    const expiresAt = createExpiry(0.25);

    await connection.query(
      `
      INSERT INTO startup_email_verifications (email, code_hash, verification_token_hash, expires_at)
      VALUES (?, ?, NULL, ?)
      `,
      [email, hashToken(code), expiresAt]
    );

    await sendStartupRegistrationCodeEmail({ email, code });

    res.json({
      success: true,
      message: "Vi har sendt en kode til e-posten din.",
      expiresAt
    });
  } catch (error) {
    console.error("Send startup registration code error:", {
      message: error?.message || String(error),
      email: String(req.body?.email || "").trim().toLowerCase(),
      hasResendKey: Boolean(String(process.env.RESEND_API_KEY || process.env.RESEND_KEY || "").trim()),
      hasEmailFrom: Boolean(String(process.env.EMAIL_FROM || process.env.RESEND_FROM || process.env.FROM_EMAIL || process.env.MAIL_FROM || "").trim()),
      environment: process.env.NODE_ENV || "development"
    });
    res.status(500).json({ success: false, error: "Kunne ikke sende kode akkurat nå." });
  } finally {
    connection.release();
  }
};

export const verifyStartupRegistrationCode = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();

    if (!email || !code) {
      return res.status(400).json({ success: false, error: "E-post og kode er påkrevd." });
    }

    const [rows] = await connection.query(
      `
      SELECT id, code_hash, expires_at, attempts
      FROM startup_email_verifications
      WHERE email = ?
        AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1
      `,
      [email]
    );

    const record = rows[0];
    if (!record) {
      return res.status(400).json({ success: false, error: "Fant ingen aktiv kode. Be om en ny kode." });
    }

    const expiresAt = new Date(record.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: "Koden har utløpt. Be om en ny kode." });
    }

    const providedHash = hashToken(code);
    if (providedHash !== record.code_hash) {
      await connection.query(
        `
        UPDATE startup_email_verifications
        SET attempts = attempts + 1
        WHERE id = ?
        `,
        [record.id]
      );
      return res.status(400).json({ success: false, error: "Koden er ugyldig." });
    }

    const verificationToken = createRawToken();
    await connection.query(
      `
      UPDATE startup_email_verifications
      SET verified_at = NOW(),
          verification_token_hash = ?
      WHERE id = ?
      `,
      [hashToken(verificationToken), record.id]
    );

    res.json({
      success: true,
      message: "E-posten er verifisert. Du kan fortsette.",
      verificationToken
    });
  } catch (error) {
    console.error("Verify startup registration code error:", error);
    res.status(500).json({ success: false, error: "Kunne ikke verifisere koden." });
  } finally {
    connection.release();
  }
};

function escapeScriptString(value) {
  return JSON.stringify(String(value ?? ""));
}

function sendVippsLoginResult(res, { token, user, redirect }) {
  const safeRedirect = String(redirect || "profile.html").startsWith("/")
    ? "profile.html"
    : String(redirect || "profile.html");

  res.type("html").send(`
<!doctype html>
<html lang="no">
<head><meta charset="utf-8"><title>Vipps Login</title></head>
<body>
<script>
localStorage.setItem("token", ${escapeScriptString(token)});
localStorage.setItem("user", ${JSON.stringify(JSON.stringify(user))});
window.location.replace(${escapeScriptString(safeRedirect)});
</script>
</body>
</html>`);
}

/* =========================================
   REGISTER
========================================= */
export const register = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    let { name, email, password, orgnr, emailVerificationToken, allowRoleCheckFallback } = req.body;
    name = String(name || "").trim();
    email = String(email || "").trim().toLowerCase();
    password = String(password || "");
    orgnr = String(orgnr || "").trim();
    allowRoleCheckFallback = allowRoleCheckFallback === true;

    if (!name || !email || !password || !orgnr || !emailVerificationToken) {
      return res.status(400).json({
        success: false,
        error: "Navn, e-post, passord, organisasjonsnummer og verifisert e-postkode er påkrevd"
      });
    }

    const passwordError = validatePasswordRequirements(password);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        error: passwordError
      });
    }

    const role = "startup";
    const roleCheck = await checkCompanyRoleMatch({
      fullName: name,
      orgnr
    });
    const company = roleCheck.company;
    const roleCheckStatus = roleCheck.matched ? "matched" : "pending_manual_review";

    if (!roleCheck.matched && !allowRoleCheckFallback) {
      return res.status(400).json({
        success: false,
        error: "Vi fant ingen registrert rolle i virksomheten som matcher opplysningene du oppga.",
        code: "COMPANY_ROLE_MATCH_NOT_FOUND",
        fallbackAvailable: true,
        company,
        roleCount: roleCheck.roles.length
      });
    }

    const [existing] = await connection.execute(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        error: "E-post er allerede registrert"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await connection.beginTransaction();
    transactionStarted = true;

    const verification = await consumeStartupEmailVerification(connection, email, emailVerificationToken);
    if (!verification.ok) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(400).json({
        success: false,
        error: verification.error
      });
    }

    const [result] = await connection.execute(
      `INSERT INTO users
       (name, email, password, role, email_verified, company_role_check_status, company_role_check_checked_at, company_role_check_orgnr)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [name, email, hashedPassword, role, 1, roleCheckStatus, company.orgnr]
    );

    const userId = result.insertId;
    await ensureCompanyAndMembership(connection, {
      userId,
      orgnr: company.orgnr,
      companyName: company.name
    });

    await connection.commit();

    const user = {
      id: userId,
      name,
      email,
      role
    };
    const token = createAuthToken(user);

    await sendTelegramAdminAlert("Ny startup registrert", [
      `Navn: ${name}`,
      `E-post: ${email}`,
      `Selskap: ${company.name || "-"}`,
      `Orgnr: ${company.orgnr || "-"}`,
      `Rollematch: ${roleCheckStatus === "matched" ? "Automatisk" : "Manuell vurdering"}`
    ]);

    res.status(201).json({
      success: true,
      message: roleCheck.matched
        ? "Startup registrert."
        : "Startup registrert. Selskapsrollen må vurderes manuelt.",
      requiresEmailVerification: false,
      company,
      roleCheckStatus,
      token,
      user
    });

  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("Register error:", error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || "Serverfeil"
    });
  } finally {
    connection.release();
  }
};

export const completeStartupRegistration = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    const userId = req.user?.id;
    const orgnr = String(req.body.orgnr || "").trim();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated"
      });
    }

    if (!orgnr) {
      return res.status(400).json({
        success: false,
        error: "Organisasjonsnummer er påkrevd"
      });
    }

    const [users] = await connection.execute(
      `SELECT id, name, email, role, vipps_sub
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({
        success: false,
        error: "Bruker ikke funnet"
      });
    }

    const user = users[0];

    if (!user.vipps_sub) {
      return res.status(403).json({
        success: false,
        error: "Startup-registrering krever verifisert innlogging med Vipps i steg 1."
      });
    }

    const roleCheck = await checkCompanyRoleMatch({
      fullName: user.name,
      orgnr
    });
    const company = roleCheck.company;

    if (!roleCheck.matched) {
      logAuditEvent("startup_orgnr_match_failed", {
        userId,
        orgnr,
        name: user.name,
        ip: getClientIp(req)
      });
      return res.status(400).json({
        success: false,
        error: "Vi fant ingen registrert rolle i virksomheten som matcher navnet fra Vipps.",
        code: "COMPANY_ROLE_MATCH_NOT_FOUND"
      });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    await connection.execute(
      `UPDATE users
       SET role = 'startup',
           email_verified = 1,
           company_role_check_status = 'matched',
           company_role_check_checked_at = NOW(),
           company_role_check_orgnr = ?,
           startup_identity_provider = 'vipps'
       WHERE id = ?`,
      [company.orgnr, userId]
    );

    await ensureCompanyAndMembership(connection, {
      userId,
      orgnr: company.orgnr,
      companyName: company.name
    });

    await connection.commit();

    const normalizedUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "startup"
    };

    logAuditEvent("startup_registration_completed", {
      userId,
      orgnr: company.orgnr,
      companyName: company.name,
      ip: getClientIp(req)
    });

    res.json({
      success: true,
      message: "Startup er registrert og verifisert.",
      token: createAuthToken(normalizedUser),
      user: normalizedUser,
      company
    });
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("completeStartupRegistration error:", error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || "Serverfeil"
    });
  } finally {
    connection.release();
  }
};

export const companyRoleCheck = async (req, res) => {
  try {
    const fullName = String(req.body.name || "").trim();
    const orgnr = String(req.body.orgnr || "").trim();

    if (!fullName || !orgnr) {
      return res.status(400).json({
        success: false,
        error: "Navn og organisasjonsnummer er påkrevd"
      });
    }

    const result = await checkCompanyRoleMatch({ fullName, orgnr });

    res.json({
      success: true,
      matched: result.matched,
      message: result.matched
        ? "Match funnet. Du kan gå videre."
        : "Vi fant ingen registrert rolle i virksomheten som matcher opplysningene du oppga.",
      company: result.company,
      matchedRoles: result.matchedRoles.slice(0, 5),
      roleCount: result.roles.length,
      fallbackAvailable: !result.matched,
      sampleRoles: result.roles.slice(0, 5)
    });
  } catch (error) {
    console.error("companyRoleCheck error:", error);
    res.status(error.status || 500).json({
      success: false,
      error: error.message || "Serverfeil"
    });
  }
};


/* =========================================
   LOGIN
========================================= */
export const login = async (req, res) => {
  try {
    const requireEmailVerification = isEmailVerificationRequired();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "E-post og passord er påkrevd"
      });
    }

    const [users] = await db.execute(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (users.length === 0) {
      logAuditEvent("login_failed_unknown_email", {
        email,
        ip: getClientIp(req)
      });
      return res.status(400).json({
        success: false,
        error: "Feil e-post eller passord"
      });
    }

    const user = users[0];

    if (!user.password) {
      logAuditEvent("login_password_missing", {
        userId: user.id,
        email,
        ip: getClientIp(req)
      });
      return res.status(400).json({
        success: false,
        error: "Denne brukeren er opprettet med Vipps. Logg inn med Vipps, eller bruk glemt passord for å sette passord."
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      logAuditEvent("login_failed_bad_password", {
        userId: user.id,
        email,
        ip: getClientIp(req)
      });
      return res.status(400).json({
        success: false,
        error: "Feil e-post eller passord"
      });
    }

    if (requireEmailVerification && !user.email_verified) {
      logAuditEvent("login_blocked_unverified_email", {
        userId: user.id,
        email,
        ip: getClientIp(req)
      });
      return res.status(403).json({
        success: false,
        error: "Bekreft e-posten din før du logger inn",
        code: "EMAIL_NOT_VERIFIED"
      });
    }
    
    // 🔹 Koble bruker til eventuelle dokumentinvitasjoner
await db.execute(
    `UPDATE document_signers
     SET user_id = ?, status = 'ACCEPTED'
     WHERE email = ? AND user_id IS NULL`,
    [user.id, user.email]
  );

    await db.execute(
      "UPDATE users SET last_login_provider = 'password', last_login_at = NOW(), last_login_ip = ? WHERE id = ?",
      [getClientIp(req), user.id]
    );

    const token = createAuthToken(user);
    logAuditEvent("login_succeeded", {
      userId: user.id,
      role: user.role,
      provider: "password",
      ip: getClientIp(req)
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.toLowerCase()
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const vippsStart = async (req, res) => {
  try {
    if (!isVippsLoginConfigured()) {
      return res.status(503).json({
        success: false,
        error: "Vipps Login er ikke konfigurert i dette miljøet"
      });
    }

    const redirect = String(req.query.redirect || "profile.html").trim() || "profile.html";
    const role = String(req.query.role || "investor").toLowerCase() === "startup" ? "startup" : "investor";
    const state = createVippsState({ redirect, role });
    const authorizationUrl = await buildVippsAuthorizationUrl({ state });
    logAuditEvent("vipps_login_started", {
      role,
      redirect,
      ip: getClientIp(req)
    });

    res.redirect(authorizationUrl);
  } catch (error) {
    console.error("vippsStart error:", error);
    res.status(500).json({
      success: false,
      error: "Kunne ikke starte Vipps Login"
    });
  }
};

export const vippsCallback = async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const error = String(req.query.error || "").trim();

    if (error) {
      return res.redirect(`/login.html?vipps_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.redirect("/login.html?vipps_error=missing_code");
    }

    const decodedState = verifyVippsState(state);
    const { config, tokens } = await exchangeVippsCodeForTokens(code);
    const idClaims = await verifyVippsIdToken({ idToken: tokens.id_token, config });
    const userinfo = await fetchVippsUserinfo({
      accessToken: tokens.access_token,
      userinfoEndpoint: config.userinfo_endpoint
    });

    const vippsSub = String(userinfo?.sub || idClaims.sub || "").trim();
    const email = String(userinfo?.email || idClaims.email || "").trim().toLowerCase();
    const name = String(userinfo?.name || [userinfo?.given_name, userinfo?.family_name].filter(Boolean).join(" ") || "").trim();
    const phone = String(userinfo?.phone_number || idClaims.phone_number || "").trim();

    if (!vippsSub) {
      return res.redirect("/login.html?vipps_error=missing_identity");
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [byVipps] = await connection.execute(
        "SELECT * FROM users WHERE vipps_sub = ? LIMIT 1",
        [vippsSub]
      );
      const [byEmail] = email
        ? await connection.execute("SELECT * FROM users WHERE email = ? LIMIT 1", [email])
        : [[]];

      let user = byVipps[0] || byEmail[0];

      if (!user) {
        if (!email) {
          await connection.rollback();
          return res.redirect("/login.html?vipps_error=missing_email");
        }

        const role = decodedState.role === "startup" ? "startup" : "investor";
        const vippsPasswordPlaceholder = await bcrypt.hash(`vipps:${vippsSub}:${Date.now()}`, 10);
        const [result] = await connection.execute(
          `INSERT INTO users
           (name, email, password, role, email_verified, vipps_sub, vipps_phone, last_login_provider)
           VALUES (?, ?, ?, ?, 1, ?, ?, 'vipps')`,
          [name || email, email, vippsPasswordPlaceholder, role, vippsSub, phone || null]
        );

        user = {
          id: result.insertId,
          name: name || email,
          email,
          role
        };
      } else {
        await connection.execute(
          `
          UPDATE users
          SET vipps_sub = COALESCE(vipps_sub, ?),
              vipps_phone = ?,
              email_verified = 1,
              last_login_provider = 'vipps',
              last_login_at = NOW(),
              last_login_ip = ?
          WHERE id = ?
          `,
          [vippsSub, phone || user.vipps_phone || null, getClientIp(req), user.id]
        );
      }

      await connection.execute(
        `UPDATE users
         SET last_login_provider = 'vipps',
             last_login_at = NOW(),
             last_login_ip = ?
         WHERE id = ?`,
        [getClientIp(req), user.id]
      );

      await connection.commit();

      const normalizedUser = {
        id: user.id,
        name: user.name || name || email || "Vipps-bruker",
        email: user.email || email,
        role: String(user.role || decodedState.role || "investor").toLowerCase()
      };

      const token = createAuthToken(normalizedUser);
      logAuditEvent("vipps_login_succeeded", {
        userId: normalizedUser.id,
        role: normalizedUser.role,
        redirect: decodedState.redirect,
        ip: getClientIp(req)
      });
      sendVippsLoginResult(res, {
        token,
        user: normalizedUser,
        redirect: decodedState.redirect
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("vippsCallback error:", error);
    logAuditEvent("vipps_login_failed", {
      reason: error.message,
      ip: getClientIp(req)
    });
    res.redirect("/login.html?vipps_error=callback_failed");
  }
};

export const resendVerification = async (req, res) => {
  try {
    if (!isEmailVerificationRequired()) {
      return res.json({
        success: true,
        message: "E-postbekreftelse er slått av i dette miljøet."
      });
    }

    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "E-post er påkrevd"
      });
    }

    const [users] = await db.execute(
      "SELECT id, name, email, email_verified FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (users.length > 0 && !users[0].email_verified) {
      await sendVerificationEmail(db, {
        userId: users[0].id,
        email: users[0].email,
        name: users[0].name
      });
    }

    res.json({
      success: true,
      message: "Hvis e-posten finnes hos oss, har vi sendt en ny bekreftelseslenke."
    });
  } catch (error) {
    console.error("resendVerification error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const verifyEmail = async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token mangler"
      });
    }

    const hashedToken = hashToken(token);
    const [users] = await db.execute(
      `
      SELECT id
      FROM users
      WHERE email_verification_token = ?
        AND email_verification_expires IS NOT NULL
        AND email_verification_expires > NOW()
      LIMIT 1
      `,
      [hashedToken]
    );

    if (!users.length) {
      return res.status(400).json({
        success: false,
        error: "Bekreftelseslenken er ugyldig eller utløpt"
      });
    }

    await db.execute(
      `
      UPDATE users
      SET email_verified = 1,
          email_verification_token = NULL,
          email_verification_expires = NULL
      WHERE id = ?
      `,
      [users[0].id]
    );

    res.json({
      success: true,
      message: "E-posten din er bekreftet. Du kan nå logge inn."
    });
  } catch (error) {
    console.error("verifyEmail error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "E-post er påkrevd"
      });
    }

    const [users] = await db.execute(
      "SELECT id, name, email FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (users.length > 0) {
      await sendPasswordResetEmail(db, {
        userId: users[0].id,
        email: users[0].email,
        name: users[0].name
      });
    }

    res.json({
      success: true,
      message: "Hvis e-posten finnes hos oss, har vi sendt en lenke for å sette nytt passord."
    });
  } catch (error) {
    console.error("forgotPassword error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: "Token og passord er påkrevd"
      });
    }

    const passwordError = validatePasswordRequirements(password);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        error: passwordError
      });
    }

    const hashedToken = hashToken(token);
    const [users] = await db.execute(
      `
      SELECT id
      FROM users
      WHERE reset_password_token = ?
        AND reset_password_expires IS NOT NULL
        AND reset_password_expires > NOW()
      LIMIT 1
      `,
      [hashedToken]
    );

    if (!users.length) {
      return res.status(400).json({
        success: false,
        error: "Lenken for nytt passord er ugyldig eller utløpt"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute(
      `
      UPDATE users
      SET password = ?,
          reset_password_token = NULL,
          reset_password_expires = NULL
      WHERE id = ?
      `,
      [hashedPassword, users[0].id]
    );

    res.json({
      success: true,
      message: "Passordet er oppdatert. Du kan nå logge inn."
    });
  } catch (error) {
    console.error("resetPassword error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const updateMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    let name = String(req.body.name || "").trim();
    let email = String(req.body.email || "").trim().toLowerCase();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated"
      });
    }

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: "Navn og e-post er påkrevd"
      });
    }

    const [existing] = await db.execute(
      "SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1",
      [email, userId]
    );

    if (existing.length) {
      return res.status(400).json({
        success: false,
        error: "E-post er allerede registrert"
      });
    }

    await db.execute(
      "UPDATE users SET name = ?, email = ? WHERE id = ?",
      [name, email, userId]
    );

    const [users] = await db.execute(
      "SELECT id, name, email, role FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({
        success: false,
        error: "Bruker ikke funnet"
      });
    }

    const user = users[0];
    const normalizedRole = String(user.role || "").toLowerCase();
    const token = createAuthToken({
      id: user.id,
      role: normalizedRole,
      email: user.email
    });

    res.json({
      success: true,
      message: "Profilen er oppdatert.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: normalizedRole
      }
    });
  } catch (error) {
    console.error("updateMe error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};

export const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated"
      });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: "Nåværende passord og nytt passord er påkrevd"
      });
    }

    const passwordError = validatePasswordRequirements(newPassword);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        error: passwordError
      });
    }

    const [users] = await db.execute(
      "SELECT id, password FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (!users.length) {
      return res.status(404).json({
        success: false,
        error: "Bruker ikke funnet"
      });
    }

    const isMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        error: "Nåværende passord er feil"
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        error: "Nytt passord må være forskjellig fra det gamle"
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.execute(
      "UPDATE users SET password = ? WHERE id = ?",
      [hashedPassword, userId]
    );

    res.json({
      success: true,
      message: "Passordet er oppdatert."
    });
  } catch (error) {
    console.error("changePassword error:", error);
    res.status(500).json({
      success: false,
      error: "Serverfeil"
    });
  }
};


/* =========================================
   GET ME
========================================= */
export const getMe = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated"
      });
    }

    res.json({
      success: true,
      user: req.user
    });

  } catch (error) {
    console.error("getMe error:", error);
    res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
};
