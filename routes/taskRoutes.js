import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { resolveNextTasks } from "../utils/nextTaskResolver.js";

const router = express.Router();

router.get("/next", authMiddleware, async (req, res) => {
    try {
        const tasks = await resolveNextTasks(req.user.id, req.user.role);
        res.json({
            tasks,
            // Kept during the frontend rollout for older clients.
            task: tasks[0] || null
        });
    } catch (err) {
        console.error("Resolve next task error:", err);
        res.status(500).json({ error: "Kunne ikke hente neste oppgave." });
    }
});

export default router;
