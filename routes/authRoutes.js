import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import {
    register,
    login,
    companyRoleCheck,
    getMe,
    updateMe,
    changePassword,
    forgotPassword,
    resetPassword,
    verifyEmail,
    resendVerification
} from "../controllers/authController.js";

const router = express.Router();

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
router.post("/register", async (req, res, next) => {
    try {
        await register(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/company-role-check", async (req, res, next) => {
    try {
        await companyRoleCheck(req, res);
    } catch (err) {
        next(err);
    }
});

/* =========================================
   LOGIN
========================================= */
router.post("/login", async (req, res, next) => {
    try {
        await login(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/forgot-password", async (req, res, next) => {
    try {
        await forgotPassword(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/reset-password", async (req, res, next) => {
    try {
        await resetPassword(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/verify-email", async (req, res, next) => {
    try {
        await verifyEmail(req, res);
    } catch (err) {
        next(err);
    }
});

router.post("/resend-verification", async (req, res, next) => {
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

export default router;
