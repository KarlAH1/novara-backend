import express from "express";
import {
    getRoundByStartup,
    investInRound,
    sendUpdate,
    closeRound
} from "../controllers/emissionController.js";

const router = express.Router();  // <-- MÅ VÆRE FØRST

router.get("/ping", (req, res) => {
  res.json({ message: "Emission API is working" });
});

// routes
router.get("/round/:startupId", getRoundByStartup);
router.post("/invest/:roundId", investInRound);
router.post("/update/:roundId", sendUpdate);
router.post("/close/:roundId", closeRound);

export default router;
