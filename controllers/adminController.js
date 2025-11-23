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
