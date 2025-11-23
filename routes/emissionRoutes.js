import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
    createEmission,
    getEmissionByStartup,
    invest,
    closeEmission
} from "../controllers/emissionController.js";

const router = express.Router();

router.post("/create", auth, createEmission);
router.get("/round/:startupId", getEmissionByStartup);
router.post("/invest/:roundId", auth, invest);
router.post("/close/:roundId", auth, closeEmission);

export default router;
