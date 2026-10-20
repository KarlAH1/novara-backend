import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { resolveNextTasks } from "../utils/nextTaskResolver.js";
import { getStartupJourney } from "../utils/startupJourney.js";

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

// The startup's whole road and where it is on it (see utils/startupJourney.js).
router.get("/journey", authMiddleware, async (req, res) => {
    if (req.user.role !== "startup") {
        return res.status(403).json({ error: "Bare for startups." });
    }
    try {
        res.json(await getStartupJourney(req.user.id));
    } catch (err) {
        console.error("Startup journey error:", err);
        res.status(500).json({ error: "Kunne ikke hente fremdriften." });
    }
});

export default router;
