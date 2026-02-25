import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { register, login, getMe } from "../controllers/authController.js";

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