import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import {
    register,
    sendStartupRegistrationCode,
    verifyStartupRegistrationCode,
    completeStartupRegistration,
    login,
    companyRoleCheck,
    getMe,
    updateMe,
    changePassword,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification,
    vippsStart,
    vippsCallback
} from "../controllers/authController.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = express.Router();
const publicAuthLimiter = createRateLimiter({
    keyPrefix: "auth-public",
    windowMs: 10 * 60 * 1000,
    maxRequests: 40
});
const companyRoleCheckLimiter = createRateLimiter({
    keyPrefix: "auth-company-role-check",
    windowMs: 10 * 60 * 1000,
    maxRequests: 80,
    message: "For mange forsøk på selskapskontroll. Vent litt og prøv igjen."
});
const loginLimiter = createRateLimiter({
    keyPrefix: "auth-login",
    windowMs: 10 * 60 * 1000,
    maxRequests: 8,
    message: "For mange innloggingsforsøk. Vent litt før du prøver igjen."
});

/* =========================================
   HEALTH CHECK
========================================= */
router.get("/ping", (req, res) => {
    res.status(200).json({
        message: "Auth API is working",
        timestamp: new Date().toISOString()
    });
});

/* =========================================
   GET CURRENT USER (Protected)
========================================= */
router.get("/me", authMiddleware, async (req, res, next) => {
    try {
        await getMe(req, res);
    } catch (err) {
        next(err);
    }
});

router.put("/me", authMiddleware, async (req, res, next) => {
    try {
        await updateMe(req, res);
    } catch (err) {
        next(err);
    }
});

router.put("/change-password", authMiddleware, async (req, res, next) => {
    try {
        await changePassword(req, res);
    } catch (err) {
        next(err);
    }
});

/* =========================================
   REGISTER
========================================= */
router.post("/register", publicAuthLimiter, async (req, res, next) => {
    try {
        await register(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/startup-email-code/send", publicAuthLimiter, async (req, res, next) => {
    try {
        await sendStartupRegistrationCode(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/startup-email-code/verify", publicAuthLimiter, async (req, res, next) => {
    try {
        await verifyStartupRegistrationCode(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/startup/complete", authMiddleware, publicAuthLimiter, async (req, res, next) => {
    try {
        await completeStartupRegistration(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/company-role-check", companyRoleCheckLimiter, async (req, res, next) => {
    try {
        await companyRoleCheck(req, res);
    } catch (err) {
        next(err);
    }
});

/* =========================================
   LOGIN
========================================= */
router.post("/login", loginLimiter, async (req, res, next) => {
    try {
        await login(req, res);
    } catch (err) {
        next(err);
    }
});

router.get("/vipps/start", publicAuthLimiter, async (req, res, next) => {
    try {
        await vippsStart(req, res);
    } catch (err) {
        next(err);
    }
});

router.get("/vipps/callback", publicAuthLimiter, async (req, res, next) => {
    try {
        await vippsCallback(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/forgot-password", publicAuthLimiter, async (req, res, next) => {
    try {
        await forgotPassword(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/reset-password", publicAuthLimiter, async (req, res, next) => {
    try {
        await resetPassword(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/verify-email", publicAuthLimiter, async (req, res, next) => {
    try {
        await verifyEmail(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/resend-verification", publicAuthLimiter, async (req, res, next) => {
    try {
        await resendVerification(req, res);
    } catch (err) {
        next(err);
    }
});

/* =========================================
   OPTIONAL: TOKEN VALIDATION CHECK
   (Useful for frontend session validation)
========================================= */
router.get("/validate", authMiddleware, (req, res) => {
    res.status(200).json({
        valid: true,
        user: req.user
    });
});

router.get("/pending-signatures", authMiddleware, async (req, res) => {
    let connection;
    try {
        const { default: pool } = await import("../config/db.js");
        connection = await pool.getConnection();
        const frontendBase = String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "");

        const [rows] = await connection.query(
            `SELECT ds.id AS signer_id, ds.document_id, ds.role, d.title, d.type
             FROM document_signers ds
             JOIN documents d ON d.id = ds.document_id
             WHERE ds.user_id = ? AND ds.signed_at IS NULL AND d.status != 'LOCKED'
             ORDER BY ds.id DESC`,
            [req.user.id]
        );

        res.json({
            pending: rows.map((row) => ({
                signer_id: row.signer_id,
                document_id: row.document_id,
                document_title: row.title,
                document_type: row.type,
                role: row.role,
                sign_url: `${frontendBase}/sign.html?type=conversion&id=${row.document_id}`
            }))
        });
    } catch (err) {
        console.error("Pending signatures error:", err);
        res.status(500).json({ error: "Intern feil." });
    } finally {
        connection?.release();
    }
});

export default router;
