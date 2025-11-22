import pool from "../config/db.js";

export const createEmissionRound = async (req, res) => {
    try {
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
            `INSERT INTO emission_rounds
             (user_id, company_name, sector, pitch, country, vision, raising_amount, slip_horizon_months, status)
             VALUES (?,?,?,?,?,?,?,?, 'open')`,
            [
                userId, company_name, sector, pitch, country, vision,
                raising_amount, slip_horizon_months
            ]
        );

        res.json({ message: "Emission round created" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};

export const getRoundByStartup = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM emission_rounds WHERE user_id=? ORDER BY id DESC LIMIT 1",
        [req.params.startupId]
    );

    res.json(rows[0] || null);
};

export const investInRound = async (req, res) => {
    const investorId = req.user.id;
    const { amount } = req.body;

    await pool.query(
        `INSERT INTO investments (round_id, investor_id, amount)
         VALUES (?,?,?)`,
        [req.params.roundId, investorId, amount]
    );

    res.json({ message: "Investment registered" });
};

export const sendUpdate = async (req, res) => {
    await pool.query(
        `INSERT INTO emission_updates (round_id, message)
         VALUES (?,?)`,
        [req.params.roundId, req.body.message]
    );

    res.json({ message: "Update sent" });
};

export const closeRound = async (req, res) => {
    await pool.query(
        "UPDATE emission_rounds SET status='closed' WHERE id=?",
        [req.params.roundId]
    );

    res.json({ message: "Round closed" });
};
