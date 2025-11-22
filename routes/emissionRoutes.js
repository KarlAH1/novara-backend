// backend/routes/emissionRoutes.js
import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
    createEmissionRound,
    getRoundByStartup,
    investInRound,
    sendUpdate,
    closeRound
} from "../controllers/emissionController.js";

const router = express.Router();

router.get("/ping", (req, res) => res.json({ message: "Emission API OK" }));

router.post("/create", authMiddleware, createEmissionRound);
router.get("/round/:startupId", getRoundByStartup);
router.post("/invest/:roundId", authMiddleware, investInRound);
router.post("/update/:roundId", authMiddleware, sendUpdate);
router.post("/close/:roundId", authMiddleware, closeRound);

export default router;
