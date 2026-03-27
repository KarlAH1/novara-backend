import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";
import {
    isUserInSameCompany,
    resolveCompanyStartupOwner
} from "../utils/startupContext.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";

const router = express.Router();

const getRcAgreementColumns = async (connection) => {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_agreements");
    return new Set(columnRows.map((column) => column.Field));
};

const getRcPaymentColumns = async (connection) => {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_payments");
    return new Set(columnRows.map((column) => column.Field));
};

const normalizePersonName = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

const syncRcAgreementSignatures = async (connection, documentId, htmlContent, documentHash) => {
    const agreementMatch = htmlContent.match(/rc_agreement_id:(\d+)/i);

    if (!agreementMatch) {
        return;
    }

    const agreementId = Number(agreementMatch[1]);

    const [signerRows] = await connection.query(
        `SELECT role, signed_at
         FROM document_signers
         WHERE document_id = ?`,
        [documentId]
    );

    const investorSignedAt =
        signerRows.find((signer) => signer.role === "Investor")?.signed_at || null;
    const startupSignedAt =
        signerRows.find((signer) => signer.role === "Startup")?.signed_at || null;

    const rcAgreementColumns = await getRcAgreementColumns(connection);
    const agreementStatus =
        investorSignedAt
            ? "Awaiting Payment"
            : "Pending Signatures";

    const updateClauses = [];
    const updateParams = [];

    if (rcAgreementColumns.has("investor_signed_at")) {
        updateClauses.push("investor_signed_at = ?");
        updateParams.push(investorSignedAt);
    }

    if (rcAgreementColumns.has("startup_signed_at")) {
        updateClauses.push("startup_signed_at = ?");
        updateParams.push(startupSignedAt);
    } else if (rcAgreementColumns.has("signed_at")) {
        updateClauses.push("signed_at = ?");
        updateParams.push(investorSignedAt || startupSignedAt);
    }

    updateClauses.push("status = ?");
    updateParams.push(agreementStatus);

    if (rcAgreementColumns.has("document_hash")) {
        updateClauses.push("document_hash = ?");
        updateParams.push(documentHash);
    }

    updateParams.push(agreementId);

    await connection.query(
        `UPDATE rc_agreements
         SET ${updateClauses.join(", ")}
         WHERE id = ?`,
        updateParams
    );

    if (investorSignedAt) {
        const rcPaymentColumns = await getRcPaymentColumns(connection);
        const [paymentRows] = await connection.query(
            "SELECT id FROM rc_payments WHERE agreement_id = ?",
            [agreementId]
        );

        if (paymentRows.length === 0) {
            const insertColumns = ["agreement_id", "amount", "status"];
            const selectValues = ["id", "investment_amount", "'Awaiting Payment'"];

            if (rcPaymentColumns.has("reference")) {
                insertColumns.push("reference");
                selectValues.push("COALESCE(NULLIF(rc_id, ''), CONCAT('RC-', id))");
            }

            if (rcPaymentColumns.has("initiated_at")) {
                insertColumns.push("initiated_at");
                selectValues.push("NOW()");
            }

            await connection.query(
                `INSERT INTO rc_payments
                (${insertColumns.join(", ")})
                SELECT ${selectValues.join(", ")}
                FROM rc_agreements
                WHERE id = ?`,
                [agreementId]
            );
        } else {
            const updateClauses = ["status = 'Awaiting Payment'"];

            if (rcPaymentColumns.has("initiated_at")) {
                updateClauses.push("initiated_at = NOW()");
            }

            await connection.query(
                `UPDATE rc_payments
                 SET ${updateClauses.join(", ")}
                 WHERE agreement_id = ?`,
                [agreementId]
            );
        }
    }
};

/* =========================================
   LEGAL STATUS (BOARD + GF)
========================================= */

router.get("/legal-status", auth, async (req, res) => {
    try {
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;

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
            documentId: null,
            canSignDirect: false,
            secretaryNameMatches: null
        };

        if (gfRows.length > 0) {
            gf.exists = true;
            gf.documentId = gfRows[0].id;
            gf.signed =
                gfRows[0].status === "SIGNED" ||
                gfRows[0].status === "LOCKED";

            if (!gf.signed) {
                const [[userRow], [signerRows], [legalRows]] = await Promise.all([
                    pool.query(
                        "SELECT name FROM users WHERE id = ? LIMIT 1",
                        [req.user.id]
                    ),
                    pool.query(
                        `
                        SELECT id
                        FROM document_signers
                        WHERE document_id = ?
                          AND role = 'Protokollunderskriver'
                          AND signed_at IS NULL
                          AND (user_id = ? OR email = ?)
                        LIMIT 1
                        `,
                        [gf.documentId, req.user.id, req.user.email]
                    ),
                    pool.query(
                        `
                        SELECT secretary_name
                        FROM startup_legal_data
                        WHERE startup_id = ?
                        ORDER BY created_at DESC
                        LIMIT 1
                        `,
                        [startupId]
                    )
                ]);

                const secretaryName = legalRows[0]?.secretary_name || "";
                const userName = userRow[0]?.name || "";
                const nameLooksRight =
                    !secretaryName ||
                    !userName ||
                    normalizePersonName(secretaryName) === normalizePersonName(userName);

                gf.canSignDirect = signerRows.length > 0;
                gf.secretaryNameMatches = signerRows.length > 0 ? nameLooksRight : null;
            }
        }

        res.json({ board, gf });

    } catch (err) {
        console.error("Legal status error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

router.get("/startup/list", auth, async (req, res) => {
    try {
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;

        const [documents] = await pool.query(
            `
            SELECT id, type, title, status, created_at, locked_at
            FROM documents
            WHERE startup_id = ?
            ORDER BY created_at DESC, id DESC
            `,
            [startupId]
        );

        const [startupDocuments] = await pool.query(
            `
            SELECT
              id,
              document_type,
              filename,
              url,
              mime_type,
              status,
              parse_status,
              parsed_fields_json,
              uploaded_at
            FROM startup_documents
            WHERE startup_id = ?
              AND visible_in_document_room = 1
            ORDER BY uploaded_at DESC, id DESC
            `,
            [startupId]
        );

        const [conversionRows] = await pool.query(
            `
            SELECT id, trigger_type, status, board_document_id, gf_document_id, created_at
            FROM conversion_events
            WHERE startup_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            `,
            [startupId]
        );

        const conversion = conversionRows[0] || null;

        res.json({
            documents: [
                ...documents,
                ...startupDocuments.map((doc) => ({
                    id: doc.id,
                    source: "startup_document",
                    type: doc.document_type,
                    title: doc.filename,
                    status: doc.status,
                    parse_status: doc.parse_status,
                    parsed_fields_json: doc.parsed_fields_json,
                    url: doc.url,
                    mime_type: doc.mime_type,
                    created_at: doc.uploaded_at
                }))
            ],
            conversion,
            placeholders: [
                {
                    key: "conversion_share_register",
                    category: "Konverteringsdokumenter",
                    title: "Eierregister etter konvertering",
                    status: conversion?.gf_document_id ? "ikke klar ennå" : "ikke klar"
                },
                {
                    key: "conversion_articles",
                    category: "Konverteringsdokumenter",
                    title: "Vedtekter etter kapitalforhøyelse",
                    status: conversion?.gf_document_id ? "ikke klar ennå" : "ikke klar"
                },
                {
                    key: "conversion_package",
                    category: "Altinn-pakke",
                    title: "Altinn-pakke for konvertering",
                    status: conversion?.gf_document_id ? "ikke klar ennå" : "ikke klar"
                }
            ]
        });
    } catch (err) {
        console.error("Startup documents list error:", err);
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

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const documentId = req.params.id;

        const [docRows] = await connection.query(
            "SELECT type, startup_id, html_content FROM documents WHERE id=?",
            [documentId]
        );

        if (docRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "Document not found" });
        }

        const doc = docRows[0];

        if (doc.type === "RC") {
            const agreementMatch = doc.html_content.match(/rc_agreement_id:(\d+)/i);

            if (agreementMatch) {
                const agreementId = Number(agreementMatch[1]);
                const [agreementRows] = await connection.query(
                    `
                    SELECT round_id
                    FROM rc_agreements
                    WHERE id = ?
                    LIMIT 1
                    `,
                    [agreementId]
                );

                if (agreementRows.length > 0) {
                    const availability = await syncEmissionRoundAvailability(connection, agreementRows[0].round_id, { lock: true });
                    if (availability?.closedReason && availability.closedReason !== "target_reached") {
                        await connection.rollback();
                        return res.status(409).json({
                            error: availability.message || "Runden er avsluttet.",
                            code: availability.closedReason
                        });
                    }
                }
            }
        }

        const [result] = await connection.query(
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
            await connection.rollback();
            return res.status(400).json({
                error: "You are not a signer for this document"
            });
        }

        const [remaining] = await connection.query(
            "SELECT id FROM document_signers WHERE document_id=? AND signed_at IS NULL",
            [documentId]
        );
        let documentHash = null;

        if (remaining.length === 0) {
            const crypto = await import("crypto");

            documentHash = crypto.default
                .createHash("sha256")
                .update(doc.html_content)
                .digest("hex");

            await connection.query(
                `UPDATE documents
                 SET status='LOCKED',
                     document_hash=?,
                     locked_at=NOW()
                 WHERE id=?`,
                [documentHash, documentId]
            );
        }

        if (doc.type === "RC") {
            await syncRcAgreementSignatures(
                connection,
                documentId,
                doc.html_content,
                documentHash
            );
        }

        /* =====================================================
           AUTO CREATE CAPITAL DECISION WHEN GF LOCKED
        ===================================================== */

        if (remaining.length === 0 && doc.type === "GF") {
            const [legalRows] = await connection.query(
                `SELECT amount
                 FROM startup_legal_data
                 WHERE startup_id=?
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [doc.startup_id]
            );

            const [boardRows] = await connection.query(
                `SELECT id
                 FROM documents
                 WHERE startup_id=?
                 AND type='BOARD'
                 AND status='LOCKED'
                 ORDER BY id DESC
                 LIMIT 1`,
                [doc.startup_id]
            );

            if (!legalRows.length || !boardRows.length) {
                console.error("Missing legal data or locked board for capital decision");
            } else {
                const approvedAmount = Number(legalRows[0].amount);

                if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
                    console.error("Invalid approved amount for capital decision:", legalRows[0].amount);
                } else {
                    const [existing] = await connection.query(
                        `SELECT id
                         FROM capital_decisions
                         WHERE startup_id=?
                         ORDER BY id DESC
                         LIMIT 1`,
                        [doc.startup_id]
                    );

                    if (existing.length === 0) {
                        await connection.query(
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
                    } else {
                        await connection.query(
                            `UPDATE capital_decisions
                             SET approved_amount=?,
                                 board_document_id=?,
                                 gf_document_id=?
                             WHERE id=?`,
                            [
                                approvedAmount,
                                boardRows[0].id,
                                documentId,
                                existing[0].id
                            ]
                        );
                    }

                    console.log("Capital decision created automatically.");
                }
            }
        }

        await connection.commit();

        res.json({ success: true });

    } catch (err) {
        await connection.rollback();
        console.error("Sign document error:", err);
        res.status(500).json({ error: "Server error" });
    } finally {
        connection.release();
    }
});


/* =========================================
   GET LATEST GF
========================================= */

router.get("/latest-gf", auth, async (req, res) => {
    try {
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);

        const [rows] = await pool.query(
            `SELECT id
             FROM documents
             WHERE type = 'GF' AND startup_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [startupContext.startupUserId]
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
