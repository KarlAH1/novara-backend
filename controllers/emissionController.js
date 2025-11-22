import db from "../config/db.js";

//
// 1️⃣ Hent aktiv emisjonsrunde for en startup
//
export const getRoundByStartup = async (req, res) => {
    const { startupId } = req.params;

    try {
        const [rows] = await db.query(
            "SELECT * FROM emission_rounds WHERE startup_id = ? ORDER BY id DESC LIMIT 1",
            [startupId]
        );

        if (rows.length === 0) {
            return res.json({ round: null });
        }

        res.json({ round: rows[0] });
    } catch (err) {
        console.error("DB getRoundByStartup:", err);
        res.status(500).json({ error: "Database error" });
    }
};

//
// 2️⃣ Invester i runden (mock — utvides senere)
//
export const investInRound = async (req, res) => {
    const { roundId } = req.params;
    const { investor_name, amount } = req.body;

    try {
        await db.query(
            `INSERT INTO emission_investments (round_id, investor_name, amount)
             VALUES (?, ?, ?)`,
            [roundId, investor_name, amount]
        );

        res.json({ message: "Investment registered" });
    } catch (err) {
        console.error("DB investInRound:", err);
        res.status(500).json({ error: "Database error" });
    }
};

//
// 3️⃣ Send oppdatering til investorer (mock)
//
export const sendUpdate = async (req, res) => {
    const { roundId } = req.params;
    const { message } = req.body;

    try {
        await db.query(
            `INSERT INTO emission_updates (round_id, message)
             VALUES (?, ?)`,
            [roundId, message]
        );

        res.json({ message: "Update posted" });
    } catch (err) {
        console.error("DB sendUpdate:", err);
        res.status(500).json({ error: "Database error" });
    }
};

//
// 4️⃣ Steng emisjonsrunde
//
export const closeRound = async (req, res) => {
    const { roundId } = req.params;

    try {
        await db.query(
            "UPDATE emission_rounds SET is_closed = 1 WHERE id = ?",
            [roundId]
        );

        res.json({ message: "Round closed" });
    } catch (err) {
        console.error("DB closeRound:", err);
        res.status(500).json({ error: "Database error" });
    }
};
