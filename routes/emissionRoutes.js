import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
    createEmissionRound,
    getRoundByStartup,
    investInRound,
    closeRound
} from "../controllers/emissionController.js";

const router = express.Router();

router.post("/create", authMiddleware, createEmissionRound);
router.get("/round/:startupId", getRoundByStartup);
router.post("/invest/:roundId", authMiddleware, investInRound);
router.post("/close/:roundId", authMiddleware, closeRound);

export default router;
