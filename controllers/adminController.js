import pool from "../config/db.js";
import { lockDocumentWithSignatures } from "../utils/documentSigning.js";

const REVIEW_ROLES = ["admin"];

async function attachIssueMessages(issues = []) {
    if (!Array.isArray(issues) || issues.length === 0) {
        return issues;
    }

    const issueIds = issues.map((issue) => Number(issue.id)).filter(Boolean);
    const [messages] = await pool.query(
        `
        SELECT
            m.id,
            m.issue_id,
            m.sender_user_id,
            m.sender_role,
            m.message,
            m.created_at,
            u.name AS sender_name,
            u.email AS sender_email
        FROM admin_issue_messages m
        LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.issue_id IN (?)
        ORDER BY m.created_at ASC, m.id ASC
        `,
        [issueIds]
    );

    const byIssueId = new Map();
    messages.forEach((message) => {
        const key = Number(message.issue_id);
        const bucket = byIssueId.get(key) || [];
        bucket.push(message);
        byIssueId.set(key, bucket);
    });

    return issues.map((issue) => ({
        ...issue,
        messages: byIssueId.get(Number(issue.id)) || []
    }));
}

function getNextAnnualExpiry() {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    return next;
}

//
// ADMIN: GET ALL USERS
//
export const adminGetUsers = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT id, name, email, role, created_at FROM users ORDER BY id DESC"
    );
    res.json(rows);
};

//
// ADMIN: CHANGE USER ROLE
//
export const adminChangeRole = async (req, res) => {
    const { id } = req.params;
    const role = String(req.body.role || "").trim().toLowerCase();

    if (!["admin", "startup", "investor", "partner"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
    }

    await pool.query("UPDATE users SET role=? WHERE id=?", [role, id]);

    res.json({ message: "Role updated" });
};

export const adminGetConversionReviews = async (req, res) => {
    const [rows] = await pool.query(
        `
        SELECT
            ce.id,
            ce.status,
            ce.trigger_type,
            ce.trigger_request_reason,
            ce.requires_admin_approval,
            ce.admin_approved_at,
            ce.admin_approval_reason,
            ce.third_party_name,
            ce.third_party_email,
            ce.third_party_confirmed_at,
            ce.capital_confirmation_document_id,
            d.status AS document_status,
            d.locked_at AS document_locked_at,
            COALESCE(c.company_name, sp.company_name, u.name) AS company_name,
            c.orgnr,
            er.id AS round_id
        FROM conversion_events ce
        JOIN emission_rounds er ON er.id = ce.round_id
        JOIN users u ON u.id = ce.startup_id
        LEFT JOIN company_memberships cm ON cm.user_id = u.id
        LEFT JOIN companies c ON c.id = cm.company_id
        LEFT JOIN startup_profiles sp ON sp.user_id = ce.startup_id
        LEFT JOIN documents d ON d.id = ce.capital_confirmation_document_id
        WHERE ce.capital_confirmation_document_id IS NOT NULL
           OR ce.status = 'pending_admin_approval'
        ORDER BY COALESCE(d.locked_at, ce.updated_at, ce.created_at) DESC, ce.id DESC
        `
    );

    res.json(rows);
};

export const adminApproveConversionReview = async (req, res) => {
    if (!REVIEW_ROLES.includes(String(req.user?.role || "").toLowerCase())) {
        return res.status(403).json({ error: "Ingen tilgang." });
    }

    const connection = await pool.getConnection();

    try {
        const conversionId = Number(req.params.id || 0);
        if (!conversionId) {
            return res.status(400).json({ error: "Ugyldig bekreftelse." });
        }

        const [rows] = await connection.query(
            `
            SELECT ce.id, ce.capital_confirmation_document_id
            FROM conversion_events ce
            WHERE ce.id = ?
            LIMIT 1
            `,
            [conversionId]
        );

        const conversion = rows[0];
        if (!conversion?.capital_confirmation_document_id) {
            return res.status(404).json({ error: "Fant ikke bekreftelsesdokumentet." });
        }

        const [signerRows] = await connection.query(
            `
            SELECT id
            FROM document_signers
            WHERE document_id = ?
              AND role = 'Revisor'
            LIMIT 1
            `,
            [conversion.capital_confirmation_document_id]
        );

        if (signerRows.length) {
            await connection.query(
                `
                UPDATE document_signers
                SET signed_at = NOW(),
                    user_id = ?,
                    email = ?,
                    status = 'SIGNED'
                WHERE id = ?
                `,
                [req.user.id, req.user.email, signerRows[0].id]
            );
        } else {
            await connection.query(
                `
                INSERT INTO document_signers (document_id, email, user_id, role, status, signed_at)
                VALUES (?, ?, ?, 'Revisor', 'SIGNED', NOW())
                `,
                [conversion.capital_confirmation_document_id, req.user.email, req.user.id]
            );
        }

        await lockDocumentWithSignatures(connection, conversion.capital_confirmation_document_id);

        await connection.query(
            `
            UPDATE conversion_events
            SET third_party_confirmed_at = NOW(),
                status = 'third_party_confirmed',
                third_party_name = COALESCE(third_party_name, ?),
                third_party_email = COALESCE(third_party_email, ?)
            WHERE id = ?
            `,
            [req.user.name || req.user.email, req.user.email, conversionId]
        );

        res.json({ message: "Bekreftelsen er godkjent og dokumentet er låst." });
    } catch (err) {
        console.error("Admin approve conversion review error:", err);
        res.status(500).json({ error: "Internal server error" });
    } finally {
        connection.release();
    }
};

export const adminApproveConversionTrigger = async (req, res) => {
    if (!REVIEW_ROLES.includes(String(req.user?.role || "").toLowerCase())) {
        return res.status(403).json({ error: "Ingen tilgang." });
    }

    const conversionId = Number(req.params.id || 0);
    if (!conversionId) {
        return res.status(400).json({ error: "Ugyldig trigger." });
    }

    const [rows] = await pool.query(
        `
        SELECT id, status, requires_admin_approval
        FROM conversion_events
        WHERE id = ?
        LIMIT 1
        `,
        [conversionId]
    );

    const conversion = rows[0];
    if (!conversion) {
        return res.status(404).json({ error: "Fant ikke trigger event." });
    }

    if (!Number(conversion.requires_admin_approval || 0) || conversion.status !== "pending_admin_approval") {
        return res.status(400).json({ error: "Denne triggeren trenger ikke admin-godkjenning." });
    }

    await pool.query(
        `
        UPDATE conversion_events
        SET status = 'triggered',
            admin_approved_at = NOW(),
            admin_approved_by_user_id = ?,
            admin_approval_reason = NULL
        WHERE id = ?
        `,
        [req.user.id, conversionId]
    );

    res.json({ message: "Trigger event er godkjent. Dokumentflyten kan nå starte." });
};

//
// ADMIN: DELETE USER
//
export const adminDeleteUser = async (req, res) => {
    await pool.query("DELETE FROM users WHERE id=?", [req.params.id]);
    res.json({ message: "User deleted" });
};

//
// ADMIN: GET ALL STARTUPS
//
export const adminGetStartups = async (req, res) => {
    const [rows] = await pool.query(
        `SELECT * FROM startup_profiles ORDER BY id DESC`
    );
    res.json(rows);
};

//
// ADMIN: DELETE STARTUP
//
export const adminDeleteStartup = async (req, res) => {
    await pool.query("DELETE FROM startup_profiles WHERE id=?", [req.params.id]);
    res.json({ message: "Startup deleted" });
};

//
// ADMIN: GET EMISSION ROUNDS
//
export const adminGetEmissions = async (req, res) => {
    const [rows] = await pool.query(
        `SELECT * FROM emission_rounds ORDER BY id DESC`
    );
    res.json(rows);
};

//
// ADMIN: DELETE EMISSION
//
export const adminDeleteEmission = async (req, res) => {
    await pool.query("DELETE FROM emission_rounds WHERE id=?", [req.params.id]);
    res.json({ message: "Emission deleted" });
};

//
// ADMIN: GET INVESTMENTS
//
export const adminGetInvestments = async (req, res) => {
    const [rows] = await pool.query(
        `SELECT * FROM investments ORDER BY id DESC`
    );
    res.json(rows);
};

export const adminGetPlanPayments = async (req, res) => {
    const status = String(req.query.status || "payment_pending").trim();
    const allowedStatuses = ["payment_required", "payment_pending", "active", "cancelled"];
    const selectedStatus = allowedStatuses.includes(status) ? status : "payment_pending";

    const [rows] = await pool.query(
        `
        SELECT
            s.id,
            s.company_id,
            s.user_id,
            s.plan_code,
            s.billing_period,
            s.list_price_nok,
            s.final_price_nok,
            s.status,
            s.payment_reference,
            s.payment_requested_at,
            s.payment_confirmed_at,
            s.payment_admin_note,
            s.created_at,
            s.updated_at,
            c.company_name,
            c.orgnr,
            u.name AS user_name,
            u.email AS user_email,
            admin.email AS confirmed_by_email
        FROM startup_plan_subscriptions s
        LEFT JOIN companies c ON c.id = s.company_id
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN users admin ON admin.id = s.payment_confirmed_by_admin_id
        WHERE s.status = ?
        ORDER BY COALESCE(s.payment_requested_at, s.created_at) DESC, s.id DESC
        `,
        [selectedStatus]
    );

    res.json(rows);
};

export const adminApprovePlanPayment = async (req, res) => {
    const subscriptionId = Number(req.params.id);
    const note = String(req.body.note || "").trim();

    if (!subscriptionId) {
        return res.status(400).json({ error: "Ugyldig betaling." });
    }

    const [rows] = await pool.query(
        `
        SELECT *
        FROM startup_plan_subscriptions
        WHERE id = ?
        LIMIT 1
        `,
        [subscriptionId]
    );

    const subscription = rows[0];
    if (!subscription) {
        return res.status(404).json({ error: "Betaling ikke funnet." });
    }

    if (!["payment_required", "payment_pending"].includes(subscription.status)) {
        return res.status(400).json({ error: "Denne betalingen kan ikke godkjennes." });
    }

    await pool.query(
        `
        UPDATE startup_plan_subscriptions
        SET status = 'active',
            activation_source = 'admin_manual_payment',
            starts_at = COALESCE(starts_at, NOW()),
            expires_at = ?,
            activated_at = NOW(),
            payment_confirmed_at = NOW(),
            payment_confirmed_by_admin_id = ?,
            payment_admin_note = ?
        WHERE id = ?
        `,
        [getNextAnnualExpiry(), req.user.id, note || null, subscriptionId]
    );

    res.json({ message: "Betaling godkjent. Startup-planen er aktivert." });
};

export const adminRejectPlanPayment = async (req, res) => {
    const subscriptionId = Number(req.params.id);
    const note = String(req.body.note || "").trim();

    if (!subscriptionId) {
        return res.status(400).json({ error: "Ugyldig betaling." });
    }

    await pool.query(
        `
        UPDATE startup_plan_subscriptions
        SET status = 'payment_required',
            payment_admin_note = ?,
            payment_requested_at = NULL
        WHERE id = ?
          AND status = 'payment_pending'
        `,
        [note || "Avvist av admin. Venter på ny betaling.", subscriptionId]
    );

    res.json({ message: "Betaling avvist og satt tilbake til betalingskrav." });
};

export const adminGetUsersByOrgnr = async (req, res) => {
    const [rows] = await pool.query(
        `
        SELECT u.id, u.name, u.email, u.role, c.orgnr, c.company_name
        FROM company_memberships cm
        JOIN companies c ON cm.company_id = c.id
        JOIN users u ON cm.user_id = u.id
        WHERE c.orgnr = ?
        ORDER BY u.created_at ASC
        `,
        [req.params.orgnr]
    );

    res.json(rows);
};

export const adminLinkUserToOrgnr = async (req, res) => {
    const connection = await pool.getConnection();
    let transactionStarted = false;

    try {
    const { userId, email } = req.body;

    const [companyRows] = await connection.query(
        "SELECT id FROM companies WHERE orgnr = ? LIMIT 1",
        [req.params.orgnr]
    );

    if (!companyRows.length) {
        return res.status(404).json({ error: "Company not found" });
    }

    let targetUserId = userId;

    if (!targetUserId && email) {
        const [userRows] = await connection.query(
            "SELECT id FROM users WHERE email = ? LIMIT 1",
            [String(email).trim().toLowerCase()]
        );
        targetUserId = userRows[0]?.id;
    }

    if (!targetUserId) {
        return res.status(400).json({ error: "userId or email is required" });
    }

    const [userRows] = await connection.query(
        "SELECT id FROM users WHERE id = ? LIMIT 1",
        [targetUserId]
    );

    if (!userRows.length) {
        return res.status(404).json({ error: "User not found" });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    await connection.query(
        "DELETE FROM company_memberships WHERE user_id = ? AND company_id <> ?",
        [targetUserId, companyRows[0].id]
    );

    await connection.query(
        `
        INSERT INTO company_memberships (company_id, user_id)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE company_id = VALUES(company_id)
        `,
        [companyRows[0].id, targetUserId]
    );

    await connection.commit();

    res.json({ message: "User linked to organization" });
    } catch (err) {
        if (transactionStarted) {
            await connection.rollback();
        }
        console.error("Link user to orgnr error:", err);
        res.status(500).json({ error: "Server error" });
    } finally {
        connection.release();
    }
};

export const adminRemoveUserFromOrgnr = async (req, res) => {
    await pool.query(
        `
        DELETE cm
        FROM company_memberships cm
        JOIN companies c ON cm.company_id = c.id
        WHERE c.orgnr = ? AND cm.user_id = ?
        `,
        [req.params.orgnr, req.params.userId]
    );

    res.json({ message: "User removed from organization" });
};

export const adminGetIssues = async (req, res) => {
    const status = String(req.query.status || "").trim().toUpperCase();
    const params = [];
    let whereClause = "";

    if (status) {
        whereClause = "WHERE UPPER(ai.status) = ?";
        params.push(status);
    }

    const [rows] = await pool.query(
        `
        SELECT
            ai.id,
            ai.user_id,
            ai.startup_id,
            ai.emission_id,
            ai.source,
            ai.issue_type,
            ai.message,
            ai.status,
            ai.admin_response,
            ai.resolved_by,
            ai.resolved_at,
            ai.created_at,
            ai.updated_at,
            u.name AS reporter_name,
            u.email AS reporter_email,
            sp.company_name AS startup_name
        FROM admin_issues ai
        LEFT JOIN users u ON ai.user_id = u.id
        LEFT JOIN startup_profiles sp ON sp.user_id = ai.startup_id
        ${whereClause}
        ORDER BY ai.created_at DESC
        `,
        params
    );

    res.json(await attachIssueMessages(rows));
};

export const adminGetMyIssues = async (req, res) => {
    const userId = req.user.id;
    const [rows] = await pool.query(
        `
        SELECT
            ai.id,
            ai.user_id,
            ai.startup_id,
            ai.emission_id,
            ai.source,
            ai.issue_type,
            ai.message,
            ai.status,
            ai.created_at,
            ai.updated_at,
            sp.company_name AS startup_name
        FROM admin_issues ai
        LEFT JOIN startup_profiles sp ON sp.user_id = ai.startup_id
        WHERE ai.user_id = ?
          AND UPPER(COALESCE(ai.status, 'OPEN')) <> 'RESOLVED'
        ORDER BY ai.updated_at DESC, ai.id DESC
        `,
        [userId]
    );

    res.json(await attachIssueMessages(rows));
};

export const adminUpdateIssue = async (req, res) => {
    const issueId = Number(req.params.id);
    const status = String(req.body.status || "").trim().toUpperCase();

    if (!issueId) {
        return res.status(400).json({ error: "Ugyldig id" });
    }

    if (status && !["OPEN", "RESOLVED", "DISMISSED"].includes(status)) {
        return res.status(400).json({ error: "Ugyldig status" });
    }

    const updates = [];
    const params = [];

    if (status) {
        updates.push("status = ?");
        params.push(status);
        if (["RESOLVED", "DISMISSED"].includes(status)) {
            updates.push("resolved_by = ?");
            params.push(req.user.id);
            updates.push("resolved_at = NOW()");
        }
    }

    if (!updates.length) {
        return res.status(400).json({ error: "Ingen oppdateringer gitt" });
    }

    params.push(issueId);
    await pool.query(
        `UPDATE admin_issues SET ${updates.join(", ")} WHERE id = ?`,
        params
    );

    res.json({ message: "Oppdatert" });
};

export const adminDeleteIssue = async (req, res) => {
    const issueId = Number(req.params.id);

    if (!issueId) {
        return res.status(400).json({ error: "Ugyldig id" });
    }

    await pool.query("DELETE FROM admin_issue_messages WHERE issue_id = ?", [issueId]);
    await pool.query("DELETE FROM admin_issues WHERE id = ?", [issueId]);

    res.json({ message: "Saken er slettet." });
};

export const adminReplyIssue = async (req, res) => {
    const issueId = Number(req.params.id);
    const message = String(req.body.message || "").trim();

    if (!issueId || !message) {
        return res.status(400).json({ error: "Melding mangler." });
    }

    const [rows] = await pool.query(
        `SELECT id FROM admin_issues WHERE id = ? LIMIT 1`,
        [issueId]
    );

    if (!rows.length) {
        return res.status(404).json({ error: "Fant ikke saken." });
    }

    await pool.query(
        `
        INSERT INTO admin_issue_messages (issue_id, sender_user_id, sender_role, message)
        VALUES (?, ?, ?, ?)
        `,
        [issueId, req.user.id, req.user.role || "admin", message]
    );

    await pool.query(
        `
        UPDATE admin_issues
        SET status = 'OPEN',
            updated_at = NOW()
        WHERE id = ?
        `,
        [issueId]
    );

    res.json({ message: "Svar sendt." });
};

export const replyToOwnIssue = async (req, res) => {
    const issueId = Number(req.params.id);
    const message = String(req.body.message || "").trim();

    if (!issueId || !message) {
        return res.status(400).json({ error: "Melding mangler." });
    }

    const [rows] = await pool.query(
        `
        SELECT id, user_id, status
        FROM admin_issues
        WHERE id = ?
        LIMIT 1
        `,
        [issueId]
    );

    const issue = rows[0];
    if (!issue) {
        return res.status(404).json({ error: "Fant ikke saken." });
    }

    if (Number(issue.user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: "Ingen tilgang." });
    }

    if (String(issue.status || "").toUpperCase() === "RESOLVED") {
        return res.status(400).json({ error: "Saken er løst." });
    }

    await pool.query(
        `
        INSERT INTO admin_issue_messages (issue_id, sender_user_id, sender_role, message)
        VALUES (?, ?, ?, ?)
        `,
        [issueId, req.user.id, req.user.role || "user", message]
    );

    await pool.query(
        `
        UPDATE admin_issues
        SET status = 'OPEN',
            updated_at = NOW()
        WHERE id = ?
        `,
        [issueId]
    );

    res.json({ message: "Melding sendt." });
};
