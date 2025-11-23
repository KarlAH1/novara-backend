import pool from "../config/db.js";

export async function createEmission(req, res) {
    const { startup_id, target_amount, slip_horizon_months } = req.body;

    const deadline = new Date();
    deadline.setDate(deadline.getDate() + Number(slip_horizon_months));

    await pool.query(
        `INSERT INTO emission_rounds (startup_id, target_amount, deadline, open)
         VALUES (?,?,?,1)`,
        [startup_id, target_amount, deadline]
    );

    res.json({ message: "Emission created" });
}

export async function getEmissionByStartup(req, res) {
    const startupId = req.params.startupId;

    const [rows] = await pool.query(
        "SELECT * FROM emission_rounds WHERE startup_id=? ORDER BY id DESC LIMIT 1",
        [startupId]
    );

    res.json(rows[0] || null);
}

export async function invest(req, res) {
    const roundId = req.params.roundId;
    const investorId = req.user.id;
    const { amount } = req.body;

    await pool.query(
        "INSERT INTO investments (round_id, investor_id, amount) VALUES (?,?,?)",
        [roundId, investorId, amount]
    );

    res.json({ message: "Investment registered" });
}

export async function closeEmission(req, res) {
    const id = req.params.roundId;

    await pool.query("UPDATE emission_rounds SET open=0 WHERE id=?", [id]);

    res.json({ message: "Emission closed" });
}
