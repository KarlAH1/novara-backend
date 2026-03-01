import pool from "../config/db.js";

/* =====================================================
   SIGN RC AGREEMENT
===================================================== */
export const signRcAgreement = async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const agreementId = req.params.id;
        const userId = req.user.id;
        const role = req.user.role;

        await connection.beginTransaction();

        const [rows] = await connection.query(
            `
            SELECT *
            FROM rc_agreements
            WHERE id = ?
            FOR UPDATE
            `,
            [agreementId]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({
                message: "Agreement not found"
            });
        }

        const agreement = rows[0];

        if (
            (role === "investor" && agreement.investor_id !== userId) ||
            (role === "startup" && agreement.startup_id !== userId)
        ) {
            await connection.rollback();
            return res.status(403).json({
                message: "Access denied"
            });
        }

        if (agreement.status === "Active RC") {
            await connection.rollback();
            return res.status(400).json({
                message: "Agreement already active"
            });
        }

        // Update status to Pending Signatures
        await connection.query(
            `
            UPDATE rc_agreements
            SET status = 'Pending Signatures',
                signed_at = NOW()
            WHERE id = ?
            `,
            [agreementId]
        );

        // Check if both should now move to Awaiting Payment
        const [updatedRows] = await connection.query(
            `
            SELECT *
            FROM rc_agreements
            WHERE id = ?
            `,
            [agreementId]
        );

        const updated = updatedRows[0];

        if (updated.status === "Pending Signatures") {
            await connection.query(
                `
                UPDATE rc_agreements
                SET status = 'Awaiting Payment'
                WHERE id = ?
                `,
                [agreementId]
            );
        }

        await connection.commit();

        res.json({ success: true });

    } catch (err) {
        await connection.rollback();
        console.error("RC SIGN ERROR:", err);
        res.status(500).json({
            message: "Server error"
        });
    } finally {
        connection.release();
    }
};


/* =====================================================
   CONFIRM PAYMENT
===================================================== */
export const confirmPayment = async (req, res) => {
    try {

        const agreementId = req.params.id;
        const startupId = req.user.id;

        const [rows] = await pool.query(
            `
            SELECT *
            FROM rc_agreements
            WHERE id = ? AND startup_id = ?
            `,
            [agreementId, startupId]
        );

        if (!rows.length) {
            return res.status(404).json({
                message: "Agreement not found"
            });
        }

        const agreement = rows[0];

        if (agreement.status !== "Awaiting Payment") {
            return res.status(400).json({
                message: "Agreement not ready for activation"
            });
        }

        await pool.query(
            `
            UPDATE rc_agreements
            SET
                status = 'Active RC',
                activated_at = NOW(),
                payment_confirmed_by_startup_at = NOW()
            WHERE id = ?
            `,
            [agreementId]
        );

        res.json({ success: true });

    } catch (err) {
        console.error("CONFIRM PAYMENT ERROR:", err);
        res.status(500).json({
            message: "Server error"
        });
    }
};