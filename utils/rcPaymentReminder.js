import pool from "../config/db.js";
import { sendRcPaymentReminderEmail } from "./notificationEmailFlow.js";

// Fires opportunistically whenever an agreement is loaded (investor's own
// view, or the startup's dashboard list) — no cron needed. One reminder per
// agreement, right after its payment deadline passes, never repeated.
export function maybeSendPaymentReminder(agreement) {
    if (!agreement || agreement.status !== "Awaiting Payment") return;
    if (agreement.payment_reminder_sent_at) return;
    if (!agreement.payment_deadline) return;

    const deadlineDate = new Date(agreement.payment_deadline);
    if (Number.isNaN(deadlineDate.getTime()) || deadlineDate > new Date()) return;

    pool.query(
        `UPDATE rc_agreements SET payment_reminder_sent_at = NOW() WHERE id = ? AND payment_reminder_sent_at IS NULL`,
        [agreement.id]
    ).then(([result]) => {
        if (!result.affectedRows) return;

        sendRcPaymentReminderEmail({
            investorEmail: agreement.investor_email,
            investorName: agreement.investor_name,
            startupName: agreement.startup_name,
            amount: agreement.investment_amount,
            agreementId: agreement.id
        }).catch((err) => console.error("Payment reminder email failed:", err));
    }).catch((err) => console.error("Payment reminder flag update failed:", err));
}
