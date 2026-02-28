import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =====================================================
   1️⃣ ADD SIGNER TO DOCUMENT
===================================================== */
router.post("/:documentId/add", auth, async (req, res) => {

    try {
        const { email, role } = req.body;
        const documentId = req.params.documentId;

        if (!email || !role) {
            return res.status(400).json({ error: "Email and role required" });
        }

        // Check if user exists
        const [users] = await pool.query(
            "SELECT id FROM users WHERE email=?",
            [email]
        );

        const userId = users.length > 0 ? users[0].id : null;

        await pool.query(
            `INSERT INTO document_signers 
            (document_id, user_id, email, role, status) 
            VALUES (?, ?, ?, ?, 'INVITED')`,
            [documentId, userId, email, role]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("Add signer error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
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
router.post("/:documentId/sign", auth, async (req, res) => {

    try {

        const documentId = req.params.documentId;

        // Check if user is invited
        const [signer] = await pool.query(
            `SELECT id FROM document_signers
             WHERE document_id=? AND user_id=?`,
            [documentId, req.user.id]
        );

        if (signer.length === 0) {
            return res.status(403).json({ error: "Not authorized to sign this document" });
        }

        await pool.query(
            `UPDATE document_signers 
             SET signed_at=NOW(), status='SIGNED', ip_address=? 
             WHERE document_id=? AND user_id=?`,
            [req.ip, documentId, req.user.id]
        );

        // Check if all signed
        const [remaining] = await pool.query(
            `SELECT id FROM document_signers 
             WHERE document_id=? AND status!='SIGNED'`,
            [documentId]
        );

        if (remaining.length === 0) {
            await pool.query(
                `UPDATE documents SET status='LOCKED' WHERE id=?`,
                [documentId]
            );
        }

        res.json({ success: true });

    } catch (err) {
        console.error("Sign document error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;