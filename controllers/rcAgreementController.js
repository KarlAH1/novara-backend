import pool from "../config/db.js";

export const investViaInvite = async (req, res) => {

    const connection = await pool.getConnection();

    try {

        const { token } = req.params;
        const { amount } = req.body;
        const investorId = req.user.id;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        await connection.beginTransaction();

        const [inviteRows] = await connection.query(`
            SELECT round_id 
            FROM rc_invites 
            WHERE token=? 
            FOR UPDATE
        `, [token]);

        if (!inviteRows.length){
            await connection.rollback();
            return res.status(404).json({ error:"Invalid invite" });
        }

        const roundId = inviteRows[0].round_id;

        const [roundRows] = await connection.query(`
            SELECT * 
            FROM emission_rounds 
            WHERE id=? AND open=1
        `, [roundId]);

        if (!roundRows.length){
            await connection.rollback();
            return res.status(400).json({ error:"Emission not open" });
        }

        const round = roundRows[0];

        const rcId = `RC-${Date.now()}`;

        const [result] = await connection.query(`
            INSERT INTO rc_agreements
            (rc_id, round_id, startup_id, investor_id,
             investment_amount, status, document_hash)
            VALUES (?, ?, ?, ?, ?, 'Pending Signatures', '')
        `, [
            rcId,
            roundId,
            round.startup_id,
            investorId,
            amount
        ]);

        await connection.commit();

        res.json({
            agreementId: result.insertId
        });

    } catch(err){
        await connection.rollback();
        console.error("Invest error:", err);
        res.status(500).json({ error:"Server error" });
    } finally {
        connection.release();
    }
};