import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
    startEmission,
    getEmissionById,
    getPreviousEmissions,
    updateEmissionConfig,
    updateEmissionBankAccount,
    getActiveEmission,
    activateEmission,
    getEmissionReadiness,
    getArticlesShareBasis,
    confirmArticlesShareBasis,
    closeEmissionEarly,
    generateInvite,
    investInEmission,
    deleteEmissionByStartup,
    reportEmissionIssue
} from "../controllers/emissionController.js";

const router = express.Router();

// Start emission
router.post("/start", auth, startEmission);

router.get("/active", auth, getActiveEmission);

router.get("/history", auth, getPreviousEmissions);

// Share basis read from the articles, and the company's confirmation of it
router.get("/articles/share-basis", auth, getArticlesShareBasis);
router.post("/articles/share-basis/confirm", auth, confirmArticlesShareBasis);

// Get emission
router.get("/:id", auth, getEmissionById);

// Update config
router.put("/:id/config", auth, updateEmissionConfig);

// Update bank account only — allowed anytime, even after investments exist
router.put("/:id/bank-account", auth, updateEmissionBankAccount);

// Activation readiness (authoritative backend gate)
router.get("/:id/readiness", auth, getEmissionReadiness);

// Activate emission
router.post("/:id/activate", auth, activateEmission);

// Close emission early (before target reached)
router.post("/:id/close-early", auth, closeEmissionEarly);

// Delete emission
router.delete("/:id", auth, deleteEmissionByStartup);

// Report issue
router.post("/:id/issues", auth, reportEmissionIssue);

// Invite investor
router.post("/:id/invite", auth, generateInvite);

// Investor invests
router.post("/:id/invest", auth, investInEmission);

export default router;
