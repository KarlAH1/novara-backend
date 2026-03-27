import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
  createOrUpdateStartupProfile,
  getStartupByUser,
  getAllRaisingStartups,
  deleteMyStartup,
  getMyOrganization,
  uploadStartupPitchDeck,
  uploadStartupArticlesOfAssociation,
  getStartupPlanStatus,
  selectStartupPlan,
  startStartupPlanPayment,
  confirmStartupPlanPayment,
  applyStartupDiscountCode,
  generateStartupDiscountCode
} from "../controllers/startupController.js";

const router = express.Router();

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
router.post("/profile", authMiddleware, createOrUpdateStartupProfile);
router.post("/pitch-deck", authMiddleware, uploadStartupPitchDeck);
router.post("/articles-of-association", authMiddleware, uploadStartupArticlesOfAssociation);
router.get("/plan", authMiddleware, getStartupPlanStatus);
router.post("/plan/select", authMiddleware, selectStartupPlan);
router.post("/plan/payment/start", authMiddleware, startStartupPlanPayment);
router.post("/plan/payment/confirm", authMiddleware, confirmStartupPlanPayment);
router.post("/plan/discount-code", authMiddleware, applyStartupDiscountCode);
router.post("/plan/codes/generate", authMiddleware, generateStartupDiscountCode);

/* =========================================
   GET MY STARTUP
========================================= */
router.get("/my", authMiddleware, getStartupByUser);
router.get("/organization", authMiddleware, getMyOrganization);

/* =========================================
   DELETE MY STARTUP
========================================= */
router.delete("/my", authMiddleware, deleteMyStartup);

/* =========================================
   PUBLIC – GET ALL RAISING STARTUPS
========================================= */
router.get("/raising", getAllRaisingStartups);

export default router;
