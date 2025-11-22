import express from "express";
import { investorPing } from "../controllers/investorController.js";

const router = express.Router();

// Kun en enkel route foreløpig
router.get("/ping", investorPing);

export default router;
