import pool from "../config/db.js";
import jwt from "jsonwebtoken";

// ----------------------------
// GET EMISSION ROUND FOR STARTUP
// ----------------------------
export const getRoundByStartup = async (req, res) => {
    try {
        const { startupId } = req.params;

        const [roundRows] = await pool.query(
            `SELECT er.*, sp.company_name, sp.sector, sp.pitch, sp.country 
             FROM emission_rounds er
             LEFT JOIN startup_profiles sp ON sp.id = er.startup_id
             WHERE er.startup_id = ? AND er.open = 1 LIMIT 1`,
            [startupId]
        );

        if (!roundRows.length) return res.json(null);

        const round = roundRows[0];
        res.json(round);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error loading round" });
    }
};

// ----------------------------
// INVEST IN ROUND
// ----------------------------
export const investInRound = async (req, res) => {
    try {
        const { roundId } = req.params;
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        // Legg til investering
        await pool.query(
            `INSERT INTO emission_investments (round_id, investor_id, amount)
             VALUES (?, 1, ?)`,   // TODO: investor_id fra token
            [roundId, amount]
        );

        // Oppdater total hentet
        await pool.query(
            `UPDATE emission_rounds 
             SET amount_raised = amount_raised + ? 
             WHERE id = ?`,
            [amount, roundId]
        );

        res.json({ message: "Investment complete" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error investing" });
    }
};

// ----------------------------
// SEND UPDATE
// ----------------------------
export const sendUpdate = async (req, res) => {
    try {
        const { roundId } = req.params;
        const { message } = req.body;

        await pool.query(
            `INSERT INTO emission_updates (round_id, message, created_by)
             VALUES (?, ?, ?)`,
            [roundId, message, 1] // TODO: created_by fra token
        );

        res.json({ message: "Update posted" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to send update" });
    }
};

// ----------------------------
// CLOSE ROUND
// ----------------------------
export const closeRound = async (req, res) => {
    try {
        const { roundId } = req.params;

        await pool.query(
            `UPDATE emission_rounds SET open = 0 WHERE id = ?`,
            [roundId]
        );

        res.json({ message: "Emisjon stengt" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to close round" });
    }
};
