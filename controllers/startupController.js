import pool from "../config/db.js";

export const createOrUpdateStartupProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            company_name,
            sector,
            pitch,
            country,
            vision,
            raising_amount,
            slip_horizon_months,
            is_raising
        } = req.body;

        const [exists] = await pool.query(
            "SELECT id FROM startup_profiles WHERE user_id=?",
            [userId]
        );

        if (exists.length > 0) {
            await pool.query(
                `UPDATE startup_profiles 
                 SET company_name=?, sector=?, pitch=?, country=?, vision=?, 
                     raising_amount=?, slip_horizon_months=?, is_raising=?
                 WHERE user_id=?`,
                [
                    company_name, sector, pitch, country, vision,
                    raising_amount, slip_horizon_months, is_raising, userId
                ]
            );
            return res.json({ message: "Profile updated" });
        }

        await pool.query(
            `INSERT INTO startup_profiles 
             (user_id, company_name, sector, pitch, country, vision, raising_amount,
              slip_horizon_months, is_raising)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                userId, company_name, sector, pitch, country, vision,
                raising_amount, slip_horizon_months, is_raising
            ]
        );

        res.json({ message: "Profile created" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};

export const getStartupByUser = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM startup_profiles WHERE user_id=?",
        [req.user.id]
    );

    res.json(rows);
};

export const getAllRaisingStartups = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM startup_profiles WHERE is_raising=1"
    );
    res.json(rows);
};

export const deleteMyStartup = async (req, res) => {
    await pool.query("DELETE FROM startup_profiles WHERE user_id=?", [
        req.user.id
    ]);
    res.json({ message: "Startup deleted" });
};
