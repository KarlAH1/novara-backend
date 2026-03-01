import express from "express";
import { auth } from "../middleware/authMiddleware.js";

import {
    startEmission,
    getEmissionById,
    updateEmissionConfig,
    activateEmission,
    generateInvite,
    investInEmission
} from "../controllers/emissionController.js";

const router = express.Router();

router.post("/start", auth, startEmission);
router.get("/:emissionId", auth, getEmissionById);
router.post("/:emissionId/invite", auth, generateInvite);
router.post("/:emissionId/invest", auth, investInEmission);
router.put("/:emissionId/config", auth, updateEmissionConfig);
router.post("/:emissionId/activate", auth, activateEmission);
router.post("/:id/activate", auth, activateEmission);

router.post("/:id/activate", auth, async (req, res) => {
    try {

        await pool.query(
            `UPDATE emission_rounds
             SET open = 1
             WHERE id = ? AND startup_id = ?`,
            [req.params.id, req.user.id]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("Activate emission error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

export default router;