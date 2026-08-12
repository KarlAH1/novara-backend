import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { resolveNextTask } from "../utils/nextTaskResolver.js";

const router = express.Router();

router.get("/next", authMiddleware, async (req, res) => {
    try {
        const task = await resolveNextTask(req.user.id, req.user.role);
        res.json({ task: task || null });
    } catch (err) {
        console.error("Resolve next task error:", err);
        res.status(500).json({ error: "Kunne ikke hente neste oppgave." });
    }
});

export default router;
