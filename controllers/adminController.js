import pool from "../config/db.js";

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
    const { role } = req.body;

    if (!["Admin", "Startup", "Investor"].includes(role)) {
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
