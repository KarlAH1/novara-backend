import pool from "../config/db.js";

export async function createStartup(req, res) {
    const userId = req.user.id;
    const {
        company_name,
        sector,
        pitch,
        country,
        vision,
        raising_amount,
        slip_horizon_months
    } = req.body;

    await pool.query(
        `INSERT INTO startup_profiles 
        (user_id, company_name, sector, pitch, country, vision, raising_amount, slip_horizon_months, is_raising)
        VALUES (?,?,?,?,?,?,?,?,1)`,
        [
            userId,
            company_name,
            sector,
            pitch,
            country,
            vision,
            raising_amount,
            slip_horizon_months
        ]
    );

    res.json({ message: "Startup created" });
}

export async function getMyStartups(req, res) {
    const userId = req.user.id;

    const [rows] = await pool.query(
        "SELECT * FROM startup_profiles WHERE user_id=?",
        [userId]
    );

    res.json(rows);
}

export async function deleteStartup(req, res) {
    const userId = req.user.id;
    const startupId = req.params.id;

    await pool.query(
        "DELETE FROM startup_profiles WHERE id=? AND user_id=?",
        [startupId, userId]
    );

    res.json({ message: "Startup deleted" });
}
