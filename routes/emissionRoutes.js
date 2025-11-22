import express from "express";
import {
    getRoundByStartup,
    investInRound,
    sendUpdate,
    closeRound
} from "../controllers/emissionController.js";

const router = express.Router();

// Hent emisjon for en startup
router.get("/round/:startupId", getRoundByStartup);

// Invester i runden
router.post("/invest/:roundId", investInRound);

// Send oppdatering
router.post("/update/:roundId", sendUpdate);

// Stopp emisjonen
router.post("/close/:roundId", closeRound);

export default router;
