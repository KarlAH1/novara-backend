import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";

import {
    createOrUpdateStartupProfile,
    getStartupByUser,
    getAllRaisingStartups,
    deleteMyStartup
} from "../controllers/startupController.js";

const router = express.Router();

// Lagre / oppdatere profil
router.post("/profile", authMiddleware, createOrUpdateStartupProfile);

// Hente egen startup
router.get("/my", authMiddleware, getStartupByUser);

// Vise alle som henter kapital
router.get("/raising", getAllRaisingStartups);

// Slette en startup
router.delete("/delete", authMiddleware, deleteMyStartup);

export default router;
