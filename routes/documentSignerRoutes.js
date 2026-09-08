import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =====================================================
   1️⃣ ADD SIGNER TO DOCUMENT
===================================================== */
router.post("/:documentId(\\d+)/add", auth, async (req, res) => {
    // This legacy route allowed any authenticated user to add themselves to
    // any document. Signers must be created by the owning document workflow.
    res.status(410).json({
        success: false,
        error: "Denne signeringsflyten er ikke lenger tilgjengelig."
    });
});

/* =====================================================
   2️⃣ ACCEPT INVITATION (when user registers)
===================================================== */
router.post("/accept-invites", auth, async (req, res) => {

    try {

        await pool.query(
            `UPDATE document_signers 
             SET user_id=?, status='ACCEPTED'
             WHERE email=? AND user_id IS NULL`,
            [req.user.id, req.user.email]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("Accept invite error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

/* =====================================================
   3️⃣ SIGN DOCUMENT
===================================================== */
router.post("/:documentId(\\d+)/sign", auth, async (req, res) => {
    // The canonical endpoint creates the immutable signature block and hash.
    res.status(410).json({
        success: false,
        error: "Bruk /api/documents/:id/sign for signering."
    });
});

export default router;
