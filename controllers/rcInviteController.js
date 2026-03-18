import pool from "../config/db.js";
import { generateInviteToken } from "../utils/inviteToken.js";

/* ===============================
   GET invite data
================================= */
export const getInvite = async (req, res) => {
    try {

        const { token } = req.params;

        const [rows] = await pool.query(`
            SELECT r.*, u.name AS startup_name
            FROM rc_invites i
            JOIN emission_rounds r ON i.round_id = r.id
            JOIN users u ON r.startup_id = u.id
            WHERE i.token = ?
            LIMIT 1
        `, [token]);

        if (!rows.length)
            return res.status(404).json({ error:"Invalid invite" });

        res.json(rows[0]);

    } catch(err){
        console.error("Get invite error:", err);
        res.status(500).json({ error:"Server error" });
    }
};

/* ===============================
   Generate invite
================================= */
export const generateInvite = async (req, res) => {
    try {

        const { roundId } = req.params;
        const startupId = req.user.id;

        const [roundRows] = await pool.query(`
            SELECT id 
            FROM emission_rounds 
            WHERE id=? AND startup_id=? AND open=1
        `, [roundId, startupId]);

        if (!roundRows.length) {
            return res.status(403).json({ error:"Not allowed" });
        }

        const token = generateInviteToken();

        await pool.query(`
            INSERT INTO rc_invites (round_id, token)
            VALUES (?, ?)
        `, [roundId, token]);

        res.json({ token });

    } catch(err){
        console.error("Generate invite error:", err);
        res.status(500).json({ error:"Server error" });
    }
};
