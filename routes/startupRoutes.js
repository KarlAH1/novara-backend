import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
  saveSlipSetup,
  saveStartupProfile,
  listPublicStartups,
  stopRaising,
  getMyStartupProfile
} from "../controllers/startupController.js";

const router = express.Router();

// Enkel ping for testing
router.get("/ping", (req, res) => {
  res.json({ message: "Startup API is working" });
});

// Startup-oppsett for SLIP (beløp + horisont)
router.post("/slip-setup", auth, saveSlipSetup);

// Startup-profil (sektor, pitch, land, visjon, navn)
router.post("/profile", auth, saveStartupProfile);

// Stoppe kapitalinnhenting
router.post("/stop-raising", auth, stopRaising);

// Hente egen startup-profil + SLIP-data (til "Din startup" på profil-siden)
router.get("/me", auth, getMyStartupProfile);

// Liste offentlige startups som henter kapital (forsiden)
router.get("/list", listPublicStartups);

export default router;

import { createStartupProfile, getMyStartups } from "../controllers/startupController.js";

router.post("/create", createStartupProfile);
router.get("/mine/:userId", getMyStartups);

