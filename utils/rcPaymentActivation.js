import { getCapacityExceededMessage, syncEmissionRoundAvailability } from "./emissionRoundState.js";

const getRcPaymentColumns = async (connection) => {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM rc_payments");
    return new Set(columnRows.map((column) => column.Field));
};

// Shared by the manual "Bekreft betaling mottatt" endpoint (startup-confirmed)
// and the Stripe webhook (Stripe-confirmed) so both paths activate an
// agreement identically — same DB writes, same rc_payments bookkeeping.
// If expectedStartupId is given, the caller must own the agreement
// (manual confirm); omit it for the webhook, which is authenticated by
// Stripe's signature instead of a logged-in user.
export async function activateRcAgreementPayment(connection, { agreementId, expectedStartupId = null }) {
    await connection.beginTransaction();

    try {
        const ownerClause = expectedStartupId ? "AND a.startup_id = ?" : "";
        const params = expectedStartupId ? [agreementId, expectedStartupId] : [agreementId];

        const [rows] = await connection.query(
            `
            SELECT a.*, e.amount_raised, investor.email AS investor_email, COALESCE(investor.name, investor.email) AS investor_name,
                   COALESCE(su.name, su.email) AS startup_name
            FROM rc_agreements a
            JOIN emission_rounds e ON a.round_id = e.id
            LEFT JOIN users investor ON investor.id = a.investor_id
            LEFT JOIN users su ON su.id = a.startup_id
            WHERE a.id = ? ${ownerClause}
            FOR UPDATE
            `,
            params
        );

        if (!rows.length) {
            await connection.rollback();
            return { ok: false, code: 404, error: "Agreement not found" };
        }

        const agreement = rows[0];

        if (agreement.status === "Active RC") {
            // Idempotent: already activated (e.g. webhook fired twice, or
            // manual confirm beat the webhook to it).
            await connection.rollback();
            return { ok: true, alreadyActive: true, agreement };
        }

        const availability = await syncEmissionRoundAvailability(connection, agreement.round_id, { lock: true });

        if (agreement.status !== "Awaiting Payment") {
            await connection.rollback();
            return { ok: false, code: 400, error: "Agreement not ready for activation" };
        }

        if (!availability?.canInvest || agreement.investment_amount > (availability?.remainingCapacity ?? 0)) {
            await connection.rollback();
            return {
                ok: false,
                code: 400,
                error: getCapacityExceededMessage(availability?.remainingCapacity ?? 0),
                max_available_amount: availability?.remainingCapacity ?? 0
            };
        }

        await connection.query(
            `
            UPDATE rc_agreements
            SET
                status='Active RC',
                activated_at=NOW(),
                payment_confirmed_by_startup_at=NOW()
            WHERE id=?
            `,
            [agreementId]
        );

        await connection.query(
            `
            UPDATE emission_rounds
            SET amount_raised = amount_raised + ?
            WHERE id = ?
            `,
            [agreement.investment_amount, agreement.round_id]
        );

        await syncEmissionRoundAvailability(connection, agreement.round_id, { lock: true });

        const [paymentRows] = await connection.query(
            "SELECT id FROM rc_payments WHERE agreement_id = ?",
            [agreementId]
        );

        const rcPaymentColumns = await getRcPaymentColumns(connection);

        if (paymentRows.length === 0) {
            const insertColumns = ["agreement_id", "amount", "status"];
            const insertValues = ["?", "?", "'Payment Confirmed'"];

            if (rcPaymentColumns.has("reference")) {
                insertColumns.push("reference");
                insertValues.push("?");
            }
            if (rcPaymentColumns.has("initiated_at")) {
                insertColumns.push("initiated_at");
                insertValues.push("NOW()");
            }
            if (rcPaymentColumns.has("confirmed_at")) {
                insertColumns.push("confirmed_at");
                insertValues.push("NOW()");
            }

            await connection.query(
                `
                INSERT INTO rc_payments
                (${insertColumns.join(", ")})
                VALUES (${insertValues.join(", ")})
                `,
                rcPaymentColumns.has("reference")
                    ? [agreementId, agreement.investment_amount, agreement.rc_id || `RC-${agreementId}`]
                    : [agreementId, agreement.investment_amount]
            );
        } else {
            const updateClauses = ["status='Payment Confirmed'"];
            if (rcPaymentColumns.has("confirmed_at")) {
                updateClauses.push("confirmed_at=NOW()");
            }

            await connection.query(
                `
                UPDATE rc_payments
                SET ${updateClauses.join(", ")}
                WHERE agreement_id = ?
                `,
                [agreementId]
            );
        }

        await connection.commit();
        return { ok: true, agreement };
    } catch (err) {
        await connection.rollback();
        throw err;
    }
}
