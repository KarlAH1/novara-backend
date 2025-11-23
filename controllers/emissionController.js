import pool from "../config/db.js";

// ==========================
// START EMISSION
// ==========================
export const createEmissionRound = async (req, res) => {
    try {
        const { startup_id, target_amount, slip_horizon_months } = req.body;

        if (!startup_id || !target_amount || !slip_horizon_months) {
            return res.status(400).json({ message: "Missing fields" });
        }

        // deadline = now + X days
        const [deadlineRow] = await pool.query(
            `SELECT DATE_ADD(NOW(), INTERVAL ? DAY) AS deadline`,
            [slip_horizon_months]
        );

        const deadline = deadlineRow[0].deadline;

        await pool.query(
            `INSERT INTO emission_rounds (startup_id, target_amount, deadline, open)
             VALUES (?,?,?,1)`,
            [startup_id, target_amount, deadline]
        );

        // Mark startup as raising
        await pool.query(
            `UPDATE startup_profiles SET is_raising=1 WHERE id=?`,
            [startup_id]
        );

        res.json({ message: "Emisjon startet", deadline });

    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};


// ==========================
// GET ROUND
// ==========================
export const getRoundByStartup = async (req, res) => {
    const startupId = req.params.startupId;

    const [rows] = await pool.query(
        `SELECT * FROM emission_rounds 
         WHERE startup_id=? AND open=1 
         ORDER BY id DESC LIMIT 1`,
        [startupId]
    );

    res.json(rows[0] || null);
};


// ==========================
// INVEST
// ==========================
export const investInRound = async (req, res) => {
    try {
        const investorId = req.user.id;
        const roundId = req.params.roundId;
        const { amount } = req.body;

        if (!amount) return res.status(400).json({ message: "Amount missing" });

        await pool.query(
            `INSERT INTO investments (round_id, investor_id, amount)
             VALUES (?,?,?)`,
            [roundId, investorId, amount]
        );

        // Update round total
        await pool.query(
            `UPDATE emission_rounds
             SET amount_raised = amount_raised + ?
             WHERE id=?`,
            [amount, roundId]
        );

        res.json({ message: "Investering registrert" });

    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};


// ==========================
// CLOSE ROUND
// ==========================
export const closeRound = async (req, res) => {
    const roundId = req.params.roundId;

    await pool.query(
        `UPDATE emission_rounds SET open=0 WHERE id=?`,
        [roundId]
    );

    res.json({ message: "Emisjon stengt" });
};
