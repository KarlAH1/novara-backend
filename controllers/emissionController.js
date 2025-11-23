import pool from "../config/db.js";

export const createEmissionRound = async (req, res) => {
    try {
        const { startup_id, target_amount, slip_horizon_months } = req.body;

        const deadline = new Date();
        deadline.setDate(deadline.getDate() + parseInt(slip_horizon_months));

        await pool.query(
            `INSERT INTO emission_rounds
             (startup_id, target_amount, deadline, amount_raised, open)
             VALUES (?,?,?,?,1)`,
            [startup_id, target_amount, deadline, 0]
        );

        res.json({ message: "Emission round created" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Server error" });
    }
};

export const getRoundByStartup = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT * FROM emission_rounds WHERE startup_id=? ORDER BY id DESC LIMIT 1",
        [req.params.startupId]
    );
    res.json(rows[0] || null);
};

export const investInRound = async (req, res) => {
    const { amount } = req.body;

    await pool.query(
        `INSERT INTO investments (round_id, amount)
         VALUES (?,?)`,
        [req.params.roundId, amount]
    );

    await pool.query(
        `UPDATE emission_rounds
         SET amount_raised = amount_raised + ?
         WHERE id=?`,
        [amount, req.params.roundId]
    );

    res.json({ message: "Investment added" });
};

export const sendUpdate = async (req, res) => {
    const { message } = req.body;

    await pool.query(
        `INSERT INTO emission_updates (round_id, message)
         VALUES (?,?)`,
        [req.params.roundId, message]
    );

    res.json({ message: "Update sent" });
};

export const closeRound = async (req, res) => {
    await pool.query(
        "UPDATE emission_rounds SET open=0 WHERE id=?",
        [req.params.roundId]
    );
    res.json({ message: "Round closed" });
};
