import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import {
  createStartupProfile,
  getMyStartups,
  getPublicStartups
} from "../controllers/startupController.js";

const router = express.Router();   // <-- MÅ KOMME FØRST

// Test endpoint
router.get("/ping", (req, res) => {
  res.json({ message: "Startup API is working" });
});

// Create startup profile
router.post("/create", authMiddleware, createStartupProfile);

// Get startups owned by logged-in user
router.get("/mine/:userId", getMyStartups);

// Public list of startups raising money
router.get("/public", getPublicStartups);

export default router;
