import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";

import {
    createEmissionRound,
    getRoundByStartup,
    investInRound,
    sendUpdate,
    closeRound
} from "../controllers/emissionController.js";

const router = express.Router();

// Opprett emisjonsrunde
router.post("/create", authMiddleware, createEmissionRound);

// Hent runde for startup
router.get("/round/:startupId", getRoundByStartup);

// Invester i runden
router.post("/invest/:roundId", authMiddleware, investInRound);

// Startup sender oppdatering
router.post("/update/:roundId", authMiddleware, sendUpdate);

// Stenge runden
router.post("/close/:roundId", authMiddleware, closeRound);

export default router;
