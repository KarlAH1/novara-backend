import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
  saveSlipSetup,
  saveStartupProfile,
  listPublicStartups,
  stopRaising
} from "../controllers/startupController.js";

const router = express.Router();

// Enkelt ping-endepunkt
router.get("/ping", (req, res) => {
  res.json({ message: "Startup API is working" });
});

// Startups lagrer sitt SLIP-oppsett
router.post("/slip-setup", auth, saveSlipSetup);

// Startups lagrer sin profil
router.post("/profile", auth, saveStartupProfile);

// Startups kan stoppe kapitalinnhenting (fjernes fra liste)
router.post("/stop-raising", auth, stopRaising);

// Alle kan hente liste over startups som henter nå
router.get("/list", listPublicStartups);

export default router;
