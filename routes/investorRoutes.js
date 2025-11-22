import express from "express";
import { investorPing } from "../controllers/investorController.js";

const router = express.Router();

router.get("/ping", investorPing);

export default router;
