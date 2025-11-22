import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { register, login, getMe } from "../controllers/authController.js";

const router = express.Router();

// Test
router.get("/ping", (req, res) => {
  res.json({ message: "Auth API is working" });
});

// Protected route
router.get("/me", authMiddleware, getMe);

// Auth routes
router.post("/register", register);
router.post("/login", login);

export default router;
