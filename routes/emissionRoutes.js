import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
    startEmission,
    getEmissionById,
    updateEmissionConfig,
    getActiveEmission,
    activateEmission,
    generateInvite,
    investInEmission,
    deleteEmissionByStartup,
    reportEmissionIssue
} from "../controllers/emissionController.js";

const router = express.Router();

// Start emission
router.post("/start", auth, startEmission);

router.get("/active", auth, getActiveEmission);

// Get emission
router.get("/:id", auth, getEmissionById);

// Update config
router.put("/:id/config", auth, updateEmissionConfig);

// Activate emission
router.post("/:id/activate", auth, activateEmission);

// Delete emission
router.delete("/:id", auth, deleteEmissionByStartup);

// Report issue
router.post("/:id/issues", auth, reportEmissionIssue);

// Invite investor
router.post("/:id/invite", auth, generateInvite);

// Investor invests
router.post("/:id/invest", auth, investInEmission);

export default router;
