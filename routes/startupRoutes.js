import express from "express";
import {
    createStartupProfile,
    getMyStartups
} from "../controllers/startupController.js";

const router = express.Router();

// Opprett startup-profil + emisjon
router.post("/create", createStartupProfile);

// Hent alle startups for en bruker
router.get("/my/:userId", getMyStartups);

export default router;
