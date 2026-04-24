import pool from "../config/db.js";

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

    if (!["admin", "startup", "investor"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
    }

    await pool.query("UPDATE users SET role=? WHERE id=?", [role, id]);

    res.json({ message: "Role updated" });
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

    res.json(rows);
};

export const adminUpdateIssue = async (req, res) => {
    const issueId = Number(req.params.id);
    const status = String(req.body.status || "").trim().toUpperCase();
    const adminResponse = String(req.body.adminResponse || "").trim();

    if (!issueId) {
        return res.status(400).json({ error: "Ugyldig id" });
    }

    if (status && !["OPEN", "RESOLVED", "DISMISSED"].includes(status)) {
        return res.status(400).json({ error: "Ugyldig status" });
    }

    const updates = [];
    const params = [];

    if (adminResponse !== "") {
        updates.push("admin_response = ?");
        params.push(adminResponse);
    }

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
