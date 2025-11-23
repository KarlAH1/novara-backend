import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";

import {
    createOrUpdateStartupProfile,
    getStartupByUser,
    getAllRaisingStartups,
    deleteMyStartup
} from "../controllers/startupController.js";

const router = express.Router();

router.get("/ping", (req, res) => res.json({ message: "Startup API OK" }));

router.post("/profile", authMiddleware, createOrUpdateStartupProfile);

router.get("/my", authMiddleware, getStartupByUser);

router.get("/raising", getAllRaisingStartups);

router.delete("/:id", authMiddleware, deleteMyStartup);

export default router;
