import pool from "../config/db.js";
import {
    INVITE_TAKEN_ERROR,
    getOptionalUserFromRequest,
    inviteIsAvailableTo,
    loadInviteClaim
} from "../utils/inviteClaim.js";

/* ===============================
   GET invite data
================================= */
export const getInvite = async (req, res) => {
    try {

        const { token } = req.params;

        const invite = await loadInviteClaim(pool, token);
        if (!invite) {
            return res.status(404).json({ error:"Invalid invite" });
        }

        const caller = getOptionalUserFromRequest(req);
        if (!inviteIsAvailableTo(invite, caller?.id)) {
            return res.status(403).json({ error: INVITE_TAKEN_ERROR, code: "invite_claimed" });
        }

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
