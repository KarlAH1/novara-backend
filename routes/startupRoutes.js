// backend/routes/startupRoutes.js
import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
    createOrUpdateStartupProfile,
    getStartupByUser,
    getAllRaisingStartups,
    deleteMyStartup
} from "../controllers/startupController.js";

const router = express.Router();

// Test
router.get("/ping", (req, res) => {
    res.json({ message: "Startup API is working" });
});

// Create or update startup profile
router.post("/profile", authMiddleware, createOrUpdateStartupProfile);

// Get logged-in user's startup profile
router.get("/my", authMiddleware, getStartupByUser);

// Get all startups currently raising capital
router.get("/raising", getAllRaisingStartups);

// Delete logged-in user's startup
router.delete("/my", authMiddleware, deleteMyStartup);

export default router;
