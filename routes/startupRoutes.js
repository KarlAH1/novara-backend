// backend/routes/startupRoutes.js
import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
  saveSlipSetup,
  saveStartupProfile,
  listPublicStartups,
} from "../controllers/startupController.js";

const router = express.Router();

// Healthcheck / enkel test
router.get("/ping", (req, res) => {
  res.json({ message: "Startup API is working" });
});

// Startups lagrer sitt SLIP-oppsett
router.post("/slip-setup", auth, saveSlipSetup);

// Startups lagrer sin profil
router.post("/profile", auth, saveStartupProfile);

// Alle kan hente liste over startups som henter nå
router.get("/list", listPublicStartups);

export default router;
