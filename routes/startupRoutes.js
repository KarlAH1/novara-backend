import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
  createOrUpdateStartupProfile,
  getStartupByUser,
  getAllRaisingStartups,
  deleteMyStartup
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

/* =========================================
   GET MY STARTUP
========================================= */
router.get("/my", authMiddleware, getStartupByUser);

/* =========================================
   DELETE MY STARTUP
========================================= */
router.delete("/my", authMiddleware, deleteMyStartup);

/* =========================================
   PUBLIC – GET ALL RAISING STARTUPS
========================================= */
router.get("/raising", getAllRaisingStartups);

export default router;