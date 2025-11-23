import express from "express";
import { auth } from "../middleware/authMiddleware.js";
import {
    createStartup,
    getMyStartups,
    deleteStartup
} from "../controllers/startupController.js";

const router = express.Router();

router.post("/create", auth, createStartup);
router.get("/my", auth, getMyStartups);
router.delete("/:id", auth, deleteStartup);

export default router;
