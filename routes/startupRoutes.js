import express from "express";
import { auth as authMiddleware, requireRole } from "../middleware/authMiddleware.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

import {
  createOrUpdateStartupProfile,
  getStartupByUser,
  getAllRaisingStartups,
  deleteMyStartup,
  getMyOrganization,
  uploadStartupPitchDeck,
  uploadStartupArticlesOfAssociation,
  getStartupDocumentFile,
  getStartupPlanStatus,
  selectStartupPlan,
  startStartupPlanPayment,
  applyStartupDiscountCode,
  generateStartupDiscountCode,
  reportStartupIssue,
  improveStartupPitchCopy
} from "../controllers/startupController.js";

const router = express.Router();
const aiLimiter = createRateLimiter({
  keyPrefix: "startup-ai",
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: "For mange AI-forespørsler. Vent litt og prøv igjen."
});
const uploadLimiter = createRateLimiter({
  keyPrefix: "startup-upload",
  windowMs: 10 * 60 * 1000,
  maxRequests: 12,
  message: "For mange filopplastinger. Vent litt og prøv igjen."
});
const startupOnly = requireRole(["startup"]);

/* =========================================
   HEALTH CHECK
========================================= */
router.get("/ping", (req, res) =>
  res.json({ message: "Startup API OK" })
);

/* =========================================
   CREATE OR UPDATE MY STARTUP
   (One startup per user)
========================================= */
router.post("/profile", authMiddleware, startupOnly, createOrUpdateStartupProfile);
router.post("/improve-pitch", authMiddleware, startupOnly, aiLimiter, improveStartupPitchCopy);
router.post("/pitch-deck", authMiddleware, startupOnly, uploadLimiter, uploadStartupPitchDeck);
router.post("/articles-of-association", authMiddleware, startupOnly, uploadLimiter, uploadStartupArticlesOfAssociation);
router.get("/documents/:id(\\d+)/file", authMiddleware, getStartupDocumentFile);
router.get("/plan", authMiddleware, startupOnly, getStartupPlanStatus);
router.post("/plan/select", authMiddleware, startupOnly, selectStartupPlan);
router.post("/plan/payment/start", authMiddleware, startupOnly, startStartupPlanPayment);
router.post("/plan/discount-code", authMiddleware, startupOnly, applyStartupDiscountCode);
router.post("/plan/codes/generate", authMiddleware, startupOnly, generateStartupDiscountCode);
router.post("/issues", authMiddleware, startupOnly, reportStartupIssue);

/* =========================================
   GET MY STARTUP
========================================= */
router.get("/my", authMiddleware, startupOnly, getStartupByUser);
router.get("/organization", authMiddleware, startupOnly, getMyOrganization);

/* =========================================
   DELETE MY STARTUP
========================================= */
router.delete("/my", authMiddleware, startupOnly, deleteMyStartup);

/* =========================================
   PUBLIC – GET ALL RAISING STARTUPS
========================================= */
router.get("/raising", authMiddleware, getAllRaisingStartups);

export default router;
