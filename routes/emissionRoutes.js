import express from "express";
import { auth, requireRole } from "../middleware/authMiddleware.js";
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
const startupOnly = requireRole(["startup"]);
const investorOnly = requireRole(["investor"]);

// Start emission
router.post("/start", auth, startupOnly, startEmission);

router.get("/active", auth, startupOnly, getActiveEmission);

router.get("/history", auth, startupOnly, getPreviousEmissions);

// Share basis read from the articles, and the company's confirmation of it
router.get("/articles/share-basis", auth, startupOnly, getArticlesShareBasis);
router.post("/articles/share-basis/confirm", auth, startupOnly, confirmArticlesShareBasis);

// Get emission
router.get("/:id(\\d+)", auth, getEmissionById);

// Update config
router.put("/:id(\\d+)/config", auth, startupOnly, updateEmissionConfig);

// Update bank account only — allowed anytime, even after investments exist
router.put("/:id(\\d+)/bank-account", auth, startupOnly, updateEmissionBankAccount);

// Activation readiness (authoritative backend gate)
router.get("/:id(\\d+)/readiness", auth, startupOnly, getEmissionReadiness);

// Activate emission
router.post("/:id(\\d+)/activate", auth, startupOnly, activateEmission);

// Close emission early (before target reached)
router.post("/:id(\\d+)/close-early", auth, startupOnly, closeEmissionEarly);

// Delete emission
router.delete("/:id(\\d+)", auth, startupOnly, deleteEmissionByStartup);

// Report issue
router.post("/:id(\\d+)/issues", auth, reportEmissionIssue);

// Invite investor
router.post("/:id(\\d+)/invite", auth, startupOnly, generateInvite);

// Investor invests
router.post("/:id(\\d+)/invest", auth, investorOnly, investInEmission);

export default router;
