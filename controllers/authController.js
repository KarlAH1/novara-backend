import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.js";
import { fetchBrregCompany } from "../utils/brreg.js";
import { checkCompanyRoleMatch } from "../utils/companyRoleCheck.js";
import { ensureCompanyAndMembership } from "../utils/companyMembership.js";
import {
  isEmailVerificationRequired,
  sendPasswordResetEmail,
  sendVerificationEmail
} from "../utils/authEmailFlow.js";
import { hashToken, validatePasswordRequirements } from "../utils/authSecurity.js";

/* =========================================
   REGISTER
========================================= */
export const register = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;
  const requireEmailVerification = isEmailVerificationRequired();

  try {
    let { name, email, password, orgnr } = req.body;
    name = String(name || "").trim();
    email = String(email || "").trim().toLowerCase();
    password = String(password || "");
    orgnr = String(orgnr || "").trim();

    if (!name || !email || !password || !orgnr) {
      return res.status(400).json({
        success: false,
        error: "Navn, e-post, passord og organisasjonsnummer er påkrevd"
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
    const company = roleCheck.company || await fetchBrregCompany(orgnr);

    if (!roleCheck.matched) {
      return res.status(400).json({
        success: false,
        error: "Vi fant ingen registrert rolle i virksomheten som matcher opplysningene du oppga.",
        code: "COMPANY_ROLE_MATCH_NOT_FOUND"
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

    const [result] = await connection.execute(
      `INSERT INTO users
       (name, email, password, role, email_verified, company_role_check_status, company_role_check_checked_at, company_role_check_orgnr)
       VALUES (?, ?, ?, ?, ?, 'matched', NOW(), ?)`,
      [name, email, hashedPassword, role, requireEmailVerification ? 0 : 1, company.orgnr]
    );

    const userId = result.insertId;
    await ensureCompanyAndMembership(connection, {
      userId,
      orgnr: company.orgnr,
      companyName: company.name
    });

    if (requireEmailVerification) {
      await sendVerificationEmail(connection, {
        userId,
        email,
        name
      });
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: requireEmailVerification
        ? "Startup registrert. Bekreft e-posten din før du logger inn."
        : "Startup registrert. Du kan logge inn med en gang i dev.",
      requiresEmailVerification: requireEmailVerification,
      company
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
      roleCount: result.roles.length
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
      return res.status(400).json({
        success: false,
        error: "Feil e-post eller passord"
      });
    }

    const user = users[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        error: "Feil e-post eller passord"
      });
    }

    if (requireEmailVerification && !user.email_verified) {
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

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role.toLowerCase(),
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

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
    const token = jwt.sign(
      {
        id: user.id,
        role: normalizedRole,
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

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
