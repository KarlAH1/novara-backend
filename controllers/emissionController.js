// backend/controllers/emissionController.js
import pool from "../config/db.js";

// ------------------------------
// Create emission round
// ------------------------------
export const createEmissionRound = async (req, res) => {
    try {
        const { startup_id, target_amount, slip_horizon_months } = req.body;

        if (!startup_id || !target_amount || !slip_horizon_months) {
            return res.status(400).json({ error: "Missing fields" });
        }

        // Deadline = now + X days
        const [deadlineResult] = await pool.query(
            "SELECT NOW() + INTERVAL ? DAY AS deadline",
            [slip_horizon_months]
        );
        const deadline = deadlineResult[0].deadline;

        await pool.query(
            `INSERT INTO emission_rounds (startup_id, target_amount, deadline, open)
             VALUES (?, ?, ?, 1)`,
            [startup_id, target_amount, deadline]
        );

        res.json({ message: "Emission round created" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Server error" });
    }
};


// ------------------------------
// Get round by startup
// ------------------------------
export const getRoundByStartup = async (req, res) => {
    const startupId = req.params.startupId;

    const [rows] = await pool.query(
        "SELECT * FROM emission_rounds WHERE startup_id=? ORDER BY id DESC LIMIT 1",
        [startupId]
    );

    res.json(rows[0] || null);
};


// ------------------------------
// Invest
// ------------------------------
export const investInRound = async (req, res) => {
    try {
        const investorId = req.user.id;
        const roundId = req.params.roundId;
        const { amount } = req.body;

        if (!amount) return res.status(400).json({ error: "Amount required" });

        await pool.query(
            `INSERT INTO investments (round_id, investor_id, amount)
             VALUES (?,?,?)`,
            [roundId, investorId, amount]
        );

        await pool.query(
            `UPDATE emission_rounds 
             SET amount_raised = amount_raised + ? 
             WHERE id=?`,
            [amount, roundId]
        );

        res.json({ message: "Investment registered" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ error: "Server error" });
    }
};


// ------------------------------
// Updates (simple text updates)
// ------------------------------
export const sendUpdate = async (req, res) => {
    const { message } = req.body;

    await pool.query(
        "INSERT INTO emission_updates (round_id, message) VALUES (?, ?)",
        [req.params.roundId, message]
    );

    res.json({ message: "Update sent" });
};


// ------------------------------
// Close round
// ------------------------------
export const closeRound = async (req, res) => {
    await pool.query(
        "UPDATE emission_rounds SET open=0 WHERE id=?",
        [req.params.roundId]
    );

    res.json({ message: "Round closed" });
};
