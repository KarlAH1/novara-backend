import express from "express";
import pool from "../config/db.js";
import { auth } from "../middleware/authMiddleware.js";
import {
    isUserInSameCompany,
    resolveCompanyStartupOwner
} from "../utils/startupContext.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import { renderHtmlToPdfBuffer } from "../utils/pdfRenderer.js";
import { lockDocumentWithSignatures, applySignatureBlockToHtml } from "../utils/documentSigning.js";
import { getLegalResetCutoff } from "../utils/legalRoundReset.js";
import { buildConversionState } from "./conversionRoutes.js";

const router = express.Router();

const tableExists = async (connection, tableName) => {
    const [rows] = await connection.query(
        `
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
        LIMIT 1
        `,
        [tableName]
    );

    return rows.length > 0;
};

const columnExists = async (connection, tableName, columnName) => {
    const [rows] = await connection.query(
        `
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
        `,
        [tableName, columnName]
    );

    return rows.length > 0;
};

const getRcAgreementColumns = async (connection) => {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_agreements");
    return new Set(columnRows.map((column) => column.Field));
};

const getRcPaymentColumns = async (connection) => {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_payments");
    return new Set(columnRows.map((column) => column.Field));
};

function buildExistingShareholderSeedRows(shareholders, currentShareCount) {
    const normalizedCurrentShareCount = Number(currentShareCount || 0);
    if (!Array.isArray(shareholders) || !shareholders.length || normalizedCurrentShareCount <= 0) {
        return [];
    }

    let allocatedShares = 0;

    return shareholders.map((holder, index) => {
        const isLast = index === shareholders.length - 1;
        const percentage = Number(holder.ownership_percent || 0);
        let shareCount = Math.floor((normalizedCurrentShareCount * percentage) / 100);

        if (isLast) {
            shareCount = Math.max(normalizedCurrentShareCount - allocatedShares, 0);
        }

        allocatedShares += shareCount;

        return {
            emission_shareholder_id: Number(holder.id || 0) || null,
            shareholder_name: holder.shareholder_name || `Aksjonær ${index + 1}`,
            share_count: shareCount,
            display_order: index + 1
        };
    });
}

function isExistingShareholderTaskComplete(rows = []) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return true;
    }

    return rows.every((row) =>
        String(row.shareholder_name || "").trim() &&
        String(row.birth_date || "").trim() &&
        String(row.digital_address || "").trim() &&
        String(row.residential_address || "").trim()
    );
}

async function getOrCreateExistingShareholderTask(connection, startupId) {
    if (!(await tableExists(connection, "conversion_events"))) {
        return null;
    }

    const [conversionRows] = await connection.query(
        `
        SELECT id, round_id
        FROM conversion_events
        WHERE startup_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `,
        [startupId]
    );

    const conversion = conversionRows[0] || null;
    if (!conversion?.id || !conversion?.round_id) {
        return null;
    }

    if (!(await tableExists(connection, "conversion_existing_shareholders"))) {
        return null;
    }

    if (!(await tableExists(connection, "emission_shareholders"))) {
        return {
            conversion_event_id: conversion.id,
            round_id: conversion.round_id,
            rows: [],
            total: 0,
            completed: 0,
            is_complete: true
        };
    }

    const [existingRows] = await connection.query(
        `
        SELECT id, emission_shareholder_id, shareholder_name, birth_date, digital_address,
               residential_address, share_count, share_numbers, share_class, display_order, completed_at
        FROM conversion_existing_shareholders
        WHERE conversion_event_id = ?
        ORDER BY display_order ASC, id ASC
        `,
        [conversion.id]
    );

    let rows = existingRows;

    if (!rows.length) {
        const [[profileRow]] = await connection.query(
            `
            SELECT current_share_count
            FROM startup_profiles
            WHERE user_id = ?
            LIMIT 1
            `,
            [startupId]
        );

        const [shareholderRows] = await connection.query(
            `
            SELECT id, shareholder_name, ownership_percent
            FROM emission_shareholders
            WHERE emission_id = ?
            ORDER BY id ASC
            `,
            [conversion.round_id]
        );

        const seedRows = buildExistingShareholderSeedRows(
            shareholderRows,
            Number(profileRow?.current_share_count || 0)
        );

        for (const row of seedRows) {
            await connection.query(
                `
                INSERT INTO conversion_existing_shareholders
                (conversion_event_id, emission_shareholder_id, shareholder_name, share_count, share_class, display_order)
                VALUES (?, ?, ?, ?, ?, ?)
                `,
                [conversion.id, row.emission_shareholder_id, row.shareholder_name, row.share_count, "A", row.display_order]
            );
        }

        const [createdRows] = await connection.query(
            `
            SELECT id, emission_shareholder_id, shareholder_name, birth_date, digital_address,
                   residential_address, share_count, share_numbers, share_class, display_order, completed_at
            FROM conversion_existing_shareholders
            WHERE conversion_event_id = ?
            ORDER BY display_order ASC, id ASC
            `,
            [conversion.id]
        );
        rows = createdRows;
    }

    return {
        conversion_event_id: conversion.id,
        round_id: conversion.round_id,
        rows,
        total: rows.length,
        completed: rows.filter((row) => row.completed_at).length,
        is_complete: isExistingShareholderTaskComplete(rows)
    };
}

const normalizePersonName = (value) =>
    String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

const ensureRcStartupSigner = async (connection, documentId, agreementId) => {
    const [existingRows] = await connection.query(
        `
        SELECT id
        FROM document_signers
        WHERE document_id = ?
          AND role = 'Startup'
        LIMIT 1
        `,
        [documentId]
    );

    if (existingRows.length > 0) {
        return;
    }

    const [agreementRows] = await connection.query(
        `
        SELECT a.startup_id, a.created_at, u.email
        FROM rc_agreements a
        JOIN users u ON u.id = a.startup_id
        WHERE a.id = ?
        LIMIT 1
        `,
        [agreementId]
    );

    const agreement = agreementRows[0];
    if (!agreement?.startup_id) {
        return;
    }

    await connection.query(
        `
        INSERT INTO document_signers (document_id, user_id, email, role, status, signed_at)
        VALUES (?, ?, ?, 'Startup', 'SIGNED', ?)
        `,
        [documentId, agreement.startup_id, agreement.email, agreement.created_at || new Date()]
    );
};

const syncRcAgreementSignatures = async (connection, documentId, htmlContent, documentHash) => {
    const agreementMatch = htmlContent.match(/rc_agreement_id:(\d+)/i);

    if (!agreementMatch) {
        return;
    }

    const agreementId = Number(agreementMatch[1]);

    await ensureRcStartupSigner(connection, documentId, agreementId);

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
        investorSignedAt && startupSignedAt
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
        const legalResetCutoff = await getLegalResetCutoff(pool, startupId);

        /* =========================
           BOARD
        ========================= */

        const [boardRows] = await pool.query(
            `SELECT id, status
             FROM documents
             WHERE startup_id = ?
             AND type = 'BOARD'
             AND (? IS NULL OR created_at > ?)
             ORDER BY id DESC
             LIMIT 1`,
            [startupId, legalResetCutoff, legalResetCutoff]
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
             AND (? IS NULL OR created_at > ?)
             ORDER BY id DESC
             LIMIT 1`,
            [startupId, legalResetCutoff, legalResetCutoff]
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
                          AND (? IS NULL OR created_at > ?)
                        ORDER BY created_at DESC
                        LIMIT 1
                        `,
                        [startupId, legalResetCutoff, legalResetCutoff]
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
        let conversionState = null;
        try {
            conversionState = await buildConversionState(pool, startupContext, req.user);
        } catch (error) {
            console.error("Document room conversion state fallback:", error);
            conversionState = null;
        }

        let documents = [];
        try {
            const [rows] = await pool.query(
                `
                SELECT
                  d.id,
                  d.type,
                  d.title,
                  d.status,
                  d.created_at,
                  d.locked_at,
                  COALESCE(
                    d.locked_at,
                    (
                      SELECT MAX(ds.signed_at)
                      FROM document_signers ds
                      WHERE ds.document_id = d.id
                    )
                  ) AS signed_at
                FROM documents
                WHERE d.startup_id = ?
                ORDER BY d.created_at DESC, d.id DESC
                `,
                [startupId]
            );
            documents = rows;
        } catch (error) {
            console.error("Document room documents fallback:", error);
            documents = [];
        }

        let startupDocuments = [];
        try {
            if (await tableExists(pool, "startup_documents")) {
                const hasDocumentType = await columnExists(pool, "startup_documents", "document_type");
                const hasMimeType = await columnExists(pool, "startup_documents", "mime_type");
                const hasStatus = await columnExists(pool, "startup_documents", "status");
                const hasParseStatus = await columnExists(pool, "startup_documents", "parse_status");
                const hasParsedFields = await columnExists(pool, "startup_documents", "parsed_fields_json");
                const hasVisibleInRoom = await columnExists(pool, "startup_documents", "visible_in_document_room");

                const [rows] = await pool.query(
                    `
                    SELECT
                      id,
                      ${hasDocumentType ? "document_type" : "'pitch_deck' AS document_type"},
                      filename,
                      url,
                      ${hasMimeType ? "mime_type" : "NULL AS mime_type"},
                      ${hasStatus ? "status" : "'uploaded' AS status"},
                      ${hasParseStatus ? "parse_status" : "'not_started' AS parse_status"},
                      ${hasParsedFields ? "parsed_fields_json" : "NULL AS parsed_fields_json"},
                      uploaded_at
                    FROM startup_documents
                    WHERE startup_id = ?
                      ${hasVisibleInRoom ? "AND visible_in_document_room = 1" : ""}
                    ORDER BY uploaded_at DESC, id DESC
                    `,
                    [startupId]
                );
                startupDocuments = rows;
            }
        } catch (error) {
            console.error("Document room startup documents fallback:", error);
            startupDocuments = [];
        }

        let conversionRows = [];
        try {
            if (await tableExists(pool, "conversion_events")) {
                const hasUpdatedArticles = await columnExists(pool, "conversion_events", "updated_articles_document_id");
                const hasShareholderRegister = await columnExists(pool, "conversion_events", "shareholder_register_document_id");
                const hasCapitalConfirmation = await columnExists(pool, "conversion_events", "capital_confirmation_document_id");
                const hasAltinnPackage = await columnExists(pool, "conversion_events", "altinn_package_document_id");

                const [rows] = await pool.query(
                    `
                    SELECT id, trigger_type, status, board_document_id, gf_document_id, created_at
                           , ${hasUpdatedArticles ? "updated_articles_document_id" : "NULL AS updated_articles_document_id"}
                           , ${hasShareholderRegister ? "shareholder_register_document_id" : "NULL AS shareholder_register_document_id"}
                           , ${hasCapitalConfirmation ? "capital_confirmation_document_id" : "NULL AS capital_confirmation_document_id"}
                           , ${hasAltinnPackage ? "altinn_package_document_id" : "NULL AS altinn_package_document_id"}
                    FROM conversion_events
                    WHERE startup_id = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT 1
                    `,
                    [startupId]
                );
                conversionRows = rows;
            }
        } catch (error) {
            console.error("Document room conversion rows fallback:", error);
            conversionRows = [];
        }

        const conversion = conversionRows[0] || null;
        let existingShareholdersTask = null;
        try {
            existingShareholdersTask = conversion
                ? await getOrCreateExistingShareholderTask(pool, startupId)
                : null;
        } catch (error) {
            console.error("Document room existing shareholders fallback:", error);
            existingShareholdersTask = null;
        }
        const existingShareholdersTaskComplete = Boolean(
            existingShareholdersTask &&
            Number(existingShareholdersTask.total || 0) > 0 &&
            Number(existingShareholdersTask.completed || 0) >= Number(existingShareholdersTask.total || 0)
        );

        let rcInvestorByAgreement = new Map();
        const rcDocs = documents.filter((doc) => doc.type === "RC");
        if (rcDocs.length) {
            const ids = rcDocs.map((doc) => doc.id);
            const [rcHtmlRows] = await pool.query(
                `
                SELECT id, html_content
                FROM documents
                WHERE id IN (${ids.map(() => "?").join(",")})
                `,
                ids
            );

            const agreementIds = [];
            const rcDocAgreementMap = new Map();
            rcHtmlRows.forEach((row) => {
                const match = String(row.html_content || "").match(/rc_agreement_id:(\d+)/i);
                if (match) {
                    const agreementId = Number(match[1]);
                    if (Number.isFinite(agreementId)) {
                        rcDocAgreementMap.set(row.id, agreementId);
                        agreementIds.push(agreementId);
                    }
                }
            });

            if (agreementIds.length) {
                const [agreementRows] = await pool.query(
                    `
                    SELECT a.id, u.name AS investor_name, u.email AS investor_email
                    FROM rc_agreements a
                    JOIN users u ON u.id = a.investor_id
                    WHERE a.id IN (${agreementIds.map(() => "?").join(",")})
                    `,
                    agreementIds
                );
                agreementRows.forEach((row) => {
                    rcInvestorByAgreement.set(row.id, row);
                });

                documents.forEach((doc) => {
                    const agreementId = rcDocAgreementMap.get(doc.id);
                    if (agreementId && rcInvestorByAgreement.has(agreementId)) {
                        const investor = rcInvestorByAgreement.get(agreementId);
                        doc.investor_name = investor.investor_name || null;
                        doc.investor_email = investor.investor_email || null;
                    }
                });
            }
        }

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
            existing_shareholders_task: existingShareholdersTask,
            placeholders: [
                {
                    key: "conversion_share_register",
                    category: "Konverteringsdokumenter",
                    title: "Eierregister etter konvertering",
                    status: conversionState?.steps?.shareholder_register?.status === "ready"
                        ? "klar"
                        : conversion?.shareholder_register_document_id
                        ? "klar"
                        : (existingShareholdersTask
                            ? (existingShareholdersTaskComplete || existingShareholdersTask.is_complete ? "klar" : "venter på startup")
                            : "ikke klar")
                },
                {
                    key: "conversion_articles",
                    category: "Konverteringsdokumenter",
                    title: "Vedtekter etter kapitalforhøyelse",
                    status: conversion?.updated_articles_document_id ? "klar" : "ikke klar"
                },
                {
                    key: "conversion_capital_confirmation",
                    category: "Konverteringsdokumenter",
                    title: "Revisorbekreftelse for paribeløp og motregning",
                    status: conversionState?.steps?.third_party_confirmation?.status === "signed"
                        ? "revisor_bekreftet"
                        : (conversion?.capital_confirmation_document_id ? "avventer_revisorbekreftelse" : "ikke klar")
                },
                {
                    key: "conversion_package",
                    category: "Altinn-pakke",
                    title: "Altinn-pakke for konvertering",
                    status: conversionState?.steps?.package?.status === "ready" || conversion?.altinn_package_document_id
                        ? "klar"
                        : "ikke klar"
                }
            ]
        });
    } catch (err) {
        console.error("Startup documents list error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

router.get("/conversion/existing-shareholders", auth, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;
        const task = await getOrCreateExistingShareholderTask(connection, startupId);

        if (!task) {
            return res.json({
                conversion_event_id: null,
                rows: [],
                total: 0,
                completed: 0,
                is_complete: true
            });
        }

        res.json(task);
    } catch (err) {
        console.error("Get existing shareholders task error:", err);
        res.status(500).json({ error: "Kunne ikke hente aksjonæroppgaven." });
    } finally {
        connection.release();
    }
});

router.post("/conversion/existing-shareholders/:id(\\d+)", auth, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const rowId = Number(req.params.id || 0);
        if (!rowId) {
            return res.status(400).json({ error: "Ugyldig aksjonærvalg." });
        }

        const startupContext = await resolveCompanyStartupOwner(pool, req.user.id);
        const startupId = startupContext.startupUserId;
        const task = await getOrCreateExistingShareholderTask(connection, startupId);

        if (!task?.conversion_event_id) {
            return res.status(404).json({ error: "Fant ikke aktiv konverteringsoppgave." });
        }

        const [rows] = await connection.query(
            `
            SELECT id
            FROM conversion_existing_shareholders
            WHERE id = ?
              AND conversion_event_id = ?
            LIMIT 1
            `,
            [rowId, task.conversion_event_id]
        );

        if (!rows.length) {
            return res.status(404).json({ error: "Fant ikke aksjonæren i denne oppgaven." });
        }

        const payload = {
            shareholder_name: String(req.body.shareholder_name || "").trim(),
            birth_date: String(req.body.birth_date || "").trim(),
            digital_address: String(req.body.digital_address || "").trim(),
            residential_address: String(req.body.residential_address || "").trim()
        };

        if (!payload.shareholder_name || !payload.birth_date || !payload.digital_address || !payload.residential_address) {
            return res.status(400).json({ error: "Fyll inn alle feltene for aksjonæren før du lagrer." });
        }

        const parsedBirthDate = new Date(payload.birth_date);
        if (Number.isNaN(parsedBirthDate.getTime())) {
            return res.status(400).json({ error: "Ugyldig fødselsdato." });
        }

        await connection.query(
            `
            UPDATE conversion_existing_shareholders
            SET shareholder_name = ?,
                birth_date = ?,
                digital_address = ?,
                residential_address = ?,
                completed_at = NOW()
            WHERE id = ?
              AND conversion_event_id = ?
            `,
            [
                payload.shareholder_name,
                payload.birth_date,
                payload.digital_address,
                payload.residential_address,
                rowId,
                task.conversion_event_id
            ]
        );

        const refreshedTask = await getOrCreateExistingShareholderTask(connection, startupId);
        res.json({
            success: true,
            message: "Aksjonæropplysningene er lagret.",
            task: refreshedTask
        });
    } catch (err) {
        console.error("Save existing shareholders task error:", err);
        res.status(500).json({ error: "Kunne ikke lagre aksjonæropplysningene." });
    } finally {
        connection.release();
    }
});


/* =========================================
   GET DOCUMENT
========================================= */

router.get("/:id/pdf", auth, async (req, res) => {
    try {
        const documentId = req.params.id;
        const [rows] = await pool.query(
            "SELECT id, type, title, html_content, startup_id FROM documents WHERE id=?",
            [documentId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Document not found" });
        }

        const doc = rows[0];
        const userId = req.user.id;
        let hasAccess = Number(doc.startup_id) === Number(userId);

        if (!hasAccess) {
            const [signerRows] = await pool.query(
                `
                SELECT id
                FROM document_signers
                WHERE document_id = ?
                  AND (user_id = ? OR email = ?)
                LIMIT 1
                `,
                [documentId, userId, req.user.email]
            );
            hasAccess = signerRows.length > 0;
        }

        if (!hasAccess) {
            return res.status(403).json({ error: "Access denied" });
        }

        const pdfOptions = doc.type === "CONVERSION_SHARE_REGISTER"
            ? {
                landscape: true,
                margin: {
                    top: "18px",
                    right: "18px",
                    bottom: "18px",
                    left: "18px"
                }
            }
            : {};
        const pdfBuffer = await renderHtmlToPdfBuffer(doc.html_content || "", pdfOptions);
        const safeTitle = String(doc.title || `dokument-${documentId}`)
            .toLowerCase()
            .replace(/[^a-z0-9æøå\-]+/gi, "-")
            .replace(/^-+|-+$/g, "");
        const filename = `${safeTitle || `dokument-${documentId}`}.pdf`;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error("Document pdf error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/:id", auth, async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM documents WHERE id=?",
        [req.params.id]
    );

    if (rows.length === 0) {
        return res.status(404).json({ error: "Document not found" });
    }

    const document = rows[0];
    const [signers] = await pool.query(
        `
        SELECT
            ds.id,
            ds.role,
            ds.email,
            ds.user_id,
            ds.signed_at,
            COALESCE(u.name, ds.email) AS signer_name
        FROM document_signers ds
        LEFT JOIN users u ON u.id = ds.user_id
        WHERE ds.document_id = ?
        ORDER BY ds.id ASC
        `,
        [req.params.id]
    );

    const signedCount = signers.filter((signer) => !!signer.signed_at).length;
    const totalSigners = signers.length;
    const currentSigner = signers.find(
        (signer) => Number(signer.user_id) === Number(req.user.id)
            || String(signer.email || "").toLowerCase() === String(req.user.email || "").toLowerCase()
    );
    const currentUserSigned = !!currentSigner?.signed_at;
    const previewHtml = signedCount > 0 && document.status !== "LOCKED"
        ? applySignatureBlockToHtml(document.html_content || "", signers.filter((signer) => signer.signed_at))
        : document.html_content;

    res.json({
        ...document,
        html_content: previewHtml,
        signing_progress: {
            signed_count: signedCount,
            total_signers: totalSigners,
            current_user_signed: currentUserSigned,
            is_partially_signed: signedCount > 0 && signedCount < totalSigners,
            all_signed: totalSigners > 0 && signedCount === totalSigners
        }
    });
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
        let updatedHtml = null;

        if (remaining.length === 0) {
            const locked = await lockDocumentWithSignatures(connection, documentId);
            documentHash = locked.documentHash;
            updatedHtml = locked.htmlContent;
        }

        if (doc.type === "RC") {
            await syncRcAgreementSignatures(
                connection,
                documentId,
                updatedHtml,
                documentHash
            );
        }

        if (remaining.length === 0 && ["SFC", "GFC", "CONVERSION_CAPITAL_CONFIRMATION"].includes(doc.type)) {
            const [conversionRows] = await connection.query(
                `
                SELECT id, board_document_id, gf_document_id, capital_confirmation_document_id, altinn_package_document_id
                FROM conversion_events
                WHERE board_document_id = ?
                   OR gf_document_id = ?
                   OR capital_confirmation_document_id = ?
                ORDER BY id DESC
                LIMIT 1
                `,
                [documentId, documentId, documentId]
            );

            if (conversionRows.length > 0) {
                const conversion = conversionRows[0];

                if (doc.type === "SFC" && conversion.board_document_id === Number(documentId)) {
                    await connection.query(
                        "UPDATE conversion_events SET status = 'board_signed' WHERE id = ?",
                        [conversion.id]
                    );
                }

                if (doc.type === "GFC" && conversion.gf_document_id === Number(documentId)) {
                    await connection.query(
                        "UPDATE conversion_events SET status = 'gf_signed' WHERE id = ?",
                        [conversion.id]
                    );
                }

                if (doc.type === "CONVERSION_CAPITAL_CONFIRMATION" && conversion.capital_confirmation_document_id === Number(documentId)) {
                    await connection.query(
                        `
                        UPDATE conversion_events
                        SET third_party_confirmed_at = NOW(),
                            status = 'third_party_confirmed'
                        WHERE id = ?
                        `,
                        [conversion.id]
                    );
                }
            }
        }

        /* =====================================================
           AUTO CREATE CAPITAL DECISION WHEN GF LOCKED
        ===================================================== */

        if (remaining.length === 0 && doc.type === "GF") {
            const legalResetCutoff = await getLegalResetCutoff(connection, doc.startup_id);
            const [legalRows] = await connection.query(
                `SELECT amount
                 FROM startup_legal_data
                 WHERE startup_id=?
                 AND (? IS NULL OR created_at > ?)
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [doc.startup_id, legalResetCutoff, legalResetCutoff]
            );

            const [boardRows] = await connection.query(
                `SELECT id
                 FROM documents
                 WHERE startup_id=?
                 AND type='BOARD'
                 AND status='LOCKED'
                 AND (? IS NULL OR created_at > ?)
                 ORDER BY id DESC
                 LIMIT 1`,
                [doc.startup_id, legalResetCutoff, legalResetCutoff]
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
                         AND (? IS NULL OR created_at > ?)
                         ORDER BY id DESC
                         LIMIT 1`,
                        [doc.startup_id, legalResetCutoff, legalResetCutoff]
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
