import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";

const router = express.Router();

/* =========================================
   LEGAL STATUS (BOARD + GF)
========================================= */

router.get("/legal-status", auth, async (req, res) => {
    try {

        const startupId = req.user.id;

        /* =========================
           BOARD
        ========================= */

        const [boardRows] = await pool.query(
            `SELECT id, status
             FROM documents
             WHERE startup_id = ?
             AND type = 'BOARD'
             ORDER BY id DESC
             LIMIT 1`,
            [startupId]
        );

        let board = {
            exists: false,
            signed: false,
            documentId: null
        };

        if (boardRows.length > 0) {
            board.exists = true;
            board.documentId = boardRows[0].id;
            board.signed =
                boardRows[0].status === "SIGNED" ||
                boardRows[0].status === "LOCKED";
        }

        /* =========================
           GF
        ========================= */

        const [gfRows] = await pool.query(
            `SELECT id, status
             FROM documents
             WHERE startup_id = ?
             AND type = 'GF'
             ORDER BY id DESC
             LIMIT 1`,
            [startupId]
        );

        let gf = {
            exists: false,
            signed: false,
            documentId: null
        };

        if (gfRows.length > 0) {
            gf.exists = true;
            gf.documentId = gfRows[0].id;
            gf.signed =
                gfRows[0].status === "SIGNED" ||
                gfRows[0].status === "LOCKED";
        }

        res.json({ board, gf });

    } catch (err) {
        console.error("Legal status error:", err);
        res.status(500).json({ error: "Server error" });
    }
});


/* =========================================
   GET DOCUMENT
========================================= */

router.get("/:id", auth, async (req, res) => {

    const [rows] = await pool.query(
        "SELECT * FROM documents WHERE id=?",
        [req.params.id]
    );

    if (rows.length === 0) {
        return res.status(404).json({ error: "Document not found" });
    }

    res.json(rows[0]);
});


/* =========================================
   SIGN DOCUMENT
========================================= */

router.post("/:id/sign", auth, async (req, res) => {

    try {

        const documentId = req.params.id;

        const [result] = await pool.query(
            `UPDATE document_signers
             SET signed_at = NOW(),
                 ip_address = ?,
                 user_id = ?
             WHERE document_id = ?
             AND (
                 user_id = ?
                 OR email = ?
             )`,
            [
                req.ip,
                req.user.id,
                documentId,
                req.user.id,
                req.user.email
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(400).json({
                error: "You are not a signer for this document"
            });
        }

        const [remaining] = await pool.query(
            "SELECT id FROM document_signers WHERE document_id=? AND signed_at IS NULL",
            [documentId]
        );

        if (remaining.length === 0) {

            const [docRows] = await pool.query(
                "SELECT type, startup_id, html_content FROM documents WHERE id=?",
                [documentId]
            );

            const doc = docRows[0];

            const crypto = await import("crypto");

            const hash = crypto.default
                .createHash("sha256")
                .update(doc.html_content)
                .digest("hex");

            await pool.query(
                `UPDATE documents
                 SET status='LOCKED',
                     document_hash=?,
                     locked_at=NOW()
                 WHERE id=?`,
                [hash, documentId]
            );

            /* =====================================================
               AUTO CREATE CAPITAL DECISION WHEN GF LOCKED
            ===================================================== */

            if (doc.type === "GF") {

                // Extract amount from GF HTML
                const match = doc.html_content.match(/inntil\s*<strong>([\d\s]+)\s*NOK/i);

                if (match) {

                    const approvedAmount =
                        parseInt(match[1].replace(/\s/g, ""));

                    // Get latest LOCKED BOARD
                    const [boardRows] = await pool.query(
                        `SELECT id
                         FROM documents
                         WHERE startup_id=?
                         AND type='BOARD'
                         AND status='LOCKED'
                         ORDER BY id DESC
                         LIMIT 1`,
                        [doc.startup_id]
                    );

                    if (boardRows.length > 0) {

                        // Check if already exists
                        const [existing] = await pool.query(
                            `SELECT id
                             FROM capital_decisions
                             WHERE startup_id=?`,
                            [doc.startup_id]
                        );

                        if (existing.length === 0) {

                            await pool.query(
                                `INSERT INTO capital_decisions
                                (startup_id, approved_amount, board_document_id, gf_document_id)
                                VALUES (?, ?, ?, ?)`,
                                [
                                    doc.startup_id,
                                    approvedAmount,
                                    boardRows[0].id,
                                    documentId
                                ]
                            );

                            console.log("Capital decision created automatically.");
                        }
                    }
                } else {
                    console.error("Could not extract approved amount from GF");
                }
            }
        }

        res.json({ success: true });

    } catch (err) {
        console.error("Sign document error:", err);
        res.status(500).json({ error: "Server error" });
    }
});


/* =========================================
   GET LATEST GF
========================================= */

router.get("/latest-gf", auth, async (req, res) => {
    try {

        const [rows] = await pool.query(
            `SELECT id
             FROM documents
             WHERE type = 'GF' AND startup_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "No GF document found" });
        }

        res.json({ documentId: rows[0].id });

    } catch (err) {
        console.error("Error fetching latest GF:", err);
        res.status(500).json({ error: "Server error" });
    }
});

export default router;