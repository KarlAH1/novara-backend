import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
    startEmission,
    getEmissionById,
    updateEmissionConfig,
    activateEmission,
    generateInvite,
    investInEmission
} from "../controllers/emissionController.js";

const router = express.Router();

router.post("/start", authMiddleware, startEmission);
router.get("/:emissionId", authMiddleware, getEmissionById);
router.post("/:emissionId/invite", authMiddleware, generateInvite);
router.post("/:emissionId/invest", authMiddleware, investInEmission);
router.put("/:emissionId/config", authMiddleware, updateEmissionConfig);
router.post("/:emissionId/activate", authMiddleware, activateEmission);
router.post("/:id/activate", authMiddleware, activateEmission);

export default router;