import express from "express";
import { register, login } from "../controllers/authController.js";

const router = express.Router();

// --------------------------------------------------
// GET /ping – for testing
// --------------------------------------------------
router.get("/ping", (req, res) => {
  res.json({ message: "Auth API is working!" });
});

// --------------------------------------------------
// Auth endpoints
// --------------------------------------------------
router.post("/register", register);
router.post("/login", login);

export default router;
