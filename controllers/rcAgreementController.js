import pool from "../config/db.js";
import fs from "fs";
import {
    getCapacityExceededMessage,
    syncEmissionRoundAvailability
} from "../utils/emissionRoundState.js";
import { sendRcAgreementCreatedEmails } from "../utils/notificationEmailFlow.js";

const formatNOK = (value) =>
    Number(value || 0).toLocaleString("no-NO") + " NOK";

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const formatDateLabel = (value) => {
    if (!value) return "-";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleDateString("no-NO", {
        year: "numeric",
        month: "long",
        day: "numeric"
    });
};

const formatDateTimeLabel = (value) => {
    if (!value) return "-";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString("no-NO", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    });
};

const getRcDocumentState = (input = {}) => {
    const paymentConfirmed = !!input.payment_confirmed_by_startup_at || input.status === "Active RC";
    const investorSigned = !!input.investor_signed_at || input.status === "Awaiting Payment" || paymentConfirmed;
    const startupPreApproved = input.round_open === 1 || !!input.round_activated_at;

    if (paymentConfirmed) {
        return {
            paymentStatus: "Betaling bekreftet av selskapet",
            finalStatus: "Avtale aktiv",
            startupPreapprovalStatus: "Klargjort ved aktivering av privat runde",
            investorStatus: "Signed",
            isFinalized: true
        };
    }

    if (investorSigned) {
        return {
            paymentStatus: "Venter pa betaling til selskapet",
            finalStatus: "Signert, venter pa betaling",
            startupPreapprovalStatus: startupPreApproved
                ? "Klargjort ved aktivering av privat runde"
                : "Venter",
            investorStatus: "Signed",
            isFinalized: false
        };
    }

    if (startupPreApproved) {
        return {
            paymentStatus: "Ikke startet",
            finalStatus: "Klargjort av selskapet",
            startupPreapprovalStatus: "Klargjort ved aktivering av privat runde",
            investorStatus: "Venter",
            isFinalized: false
        };
    }

    return {
        paymentStatus: "Ikke startet",
        finalStatus: "Utkast",
        startupPreapprovalStatus: "Venter",
        investorStatus: "Venter",
        isFinalized: false
    };
};

export const buildRcTemplateData = (input = {}) => {
    const state = getRcDocumentState(input);
    const companyName = String(input.company_legal_name || input.startup_name || "-")
        .replace(/\s+AS$/i, "")
        .trim() || "-";
    const investorName = input.investor_name || input.investor_email || "-";
    const roundId = input.round_id || input.roundId || "-";
    const agreementId = input.agreement_id || input.agreementId || "-";
    const generatedAt = input.document_generated_at || input.created_at || new Date().toISOString();

    return {
        agreement_id: agreementId,
        rc_id: input.rc_id || "-",
        startup_name: companyName,
        investor_name: investorName,
        date: formatDateLabel(input.created_at || generatedAt),
        investment_amount: formatNOK(input.investment_amount),
        target_amount: formatNOK(input.target_amount),
        discount_rate: `${input.discount_rate || 0}%`,
        valuation_cap: input.valuation_cap ? formatNOK(input.valuation_cap) : "Ingen",
        conversion_years: `${input.conversion_years || 0} år`,
        bank_account: input.bank_account || "Legges inn av startup",
        "rc.id": input.rc_id || "-",
        "round.id": roundId,
        "template.version": input.template_version || "RC-NO-1.0",
        "company.legal_name": companyName,
        "company.org_no": input.company_org_no || "-",
        "company.address": input.company_address || "Ikke registrert i systemet",
        "investor.legal_name": investorName,
        "investor.identifier_label": input.investor_identifier_label || "E-post",
        "investor.identifier": input.investor_identifier || input.investor_email || "-",
        "investor.address": input.investor_address || "Ikke registrert i systemet",
        "summary.investment_amount": formatNOK(input.investment_amount),
        "summary.payment_deadline": formatDateLabel(input.deadline),
        "summary.discount_rate": `${input.discount_rate || 0}%`,
        "summary.valuation_cap": input.valuation_cap ? formatNOK(input.valuation_cap) : "Ingen",
        "summary.conversion_years": `${input.conversion_years || 0} år`,
        "summary.bank_account": input.bank_account || "Legges inn av startup",
        "signature.company_preapproval_status": state.startupPreapprovalStatus,
        "signature.company_signer.name": input.company_signer_name || companyName,
        "signature.company_signer.role": input.company_signer_role || "Rundeansvarlig for selskapet",
        "signature.company_signer.email": input.company_signer_email || input.startup_email || "-",
        "signature.company_signer.signed_at": formatDateTimeLabel(input.round_activated_at || input.round_created_at || input.created_at),
        "signature.company_signer.method": input.company_signer_method || "Klargjoring i Raisium software",
        "signature.investor_signer.status": state.investorStatus,
        "signature.investor_signer.name": investorName,
        "signature.investor_signer.email": input.investor_email || "-",
        "signature.investor_signer.signed_at": formatDateTimeLabel(input.investor_signed_at || input.document_locked_at),
        "signature.investor_signer.method": input.investor_signer_method || "Elektronisk signering i Raisium software",
        "payment.status": input.payment_status || state.paymentStatus,
        "payment.confirmed_at": formatDateTimeLabel(input.payment_confirmed_by_startup_at),
        "payment.confirmed_by": input.payment_confirmed_by || (state.isFinalized ? companyName : "-"),
        "document.final_status": input.document_final_status || state.finalStatus,
        "document.hash": input.document_hash || input.agreement_document_hash || "-",
        "document.generated_at": formatDateTimeLabel(generatedAt),
        "document.locked_at": formatDateTimeLabel(input.document_locked_at),
        "attachment.snapshot.round_status": input.round_open === 1 ? "Privat runde aktiv" : "Utkast",
        "attachment.snapshot.deadline": formatDateLabel(input.deadline),
        "attachment.snapshot.round_target": formatNOK(input.target_amount),
        "attachment.snapshot.round_raised": formatNOK(input.amount_raised || 0),
        "attachment.snapshot.discount_rate": `${input.discount_rate || 0}%`,
        "attachment.snapshot.valuation_cap": input.valuation_cap ? formatNOK(input.valuation_cap) : "Ingen",
        "attachment.snapshot.conversion_years": `${input.conversion_years || 0} år`,
        "attachment.snapshot.bank_account": input.bank_account || "Legges inn av startup",
        "attachment.snapshot.document_status": input.document_final_status || state.finalStatus,
        "attachment.snapshot.document_hash": input.document_hash || input.agreement_document_hash || "-",
        "attachment.snapshot.generated_at": formatDateTimeLabel(generatedAt),
        "attachment.snapshot.locked_at": formatDateTimeLabel(input.document_locked_at),
        "attachment.calc.model": input.valuation_cap ? "Cap / discount-modell" : "Discount-modell",
        "attachment.calc.pool_note": "Dersom runden senere gjennomfores med pool-modell, beregnes avtalepartens forholdsmessige andel ut fra samlet signert og finansiert RC-volum.",
        "attachment.calc.discount": `${input.discount_rate || 0}%`,
        "attachment.calc.cap": input.valuation_cap ? formatNOK(input.valuation_cap) : "Ingen",
        "attachment.calc.par_value_note": "Eventuelt nødvendig paribeløp innbetales ved tegning av konverteringsaksjer.",
        "attachment.calc.trigger_note": "Vedlegg 2 er grunnlag for beregning ved Trigger Event og skal suppleres med runde- og transaksjonsdata når konvertering eller oppgjor faktisk gjennomfores."
    };
};

export const buildRcDocumentHtml = (data) => {
    const templatePath = new URL("../templates/rc-template.html", import.meta.url);
    let template = fs.readFileSync(templatePath, "utf8");

    Object.entries(data).forEach(([key, value]) => {
        template = template.split(`{{${key}}}`).join(escapeHtml(value));
    });

    return template;
};

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
        const availability = await syncEmissionRoundAvailability(connection, roundId, { lock: true });

        if (!availability) {
            await connection.rollback();
            return res.status(404).json({ error: "Emission not found" });
        }

        if (!availability.canInvest) {
            await connection.rollback();
            return res.status(409).json({
                error: availability.message || "Runden er avsluttet.",
                code: availability.closedReason || "round_closed",
                remainingCapacity: availability.remainingCapacity
            });
        }

        const requestedAmount = Number(amount);
        if (requestedAmount > availability.remainingCapacity) {
            await connection.rollback();
            return res.status(400).json({
                error: getCapacityExceededMessage(availability.remainingCapacity),
                code: "capacity_exceeded",
                remainingCapacity: availability.remainingCapacity
            });
        }

        const [roundRows] = await connection.query(`
            SELECT
                r.*,
                COALESCE(c.company_name, sp.company_name, u.name) AS startup_name,
                u.email AS startup_email,
                COALESCE(c.company_name, sp.company_name, u.name) AS company_legal_name,
                c.orgnr AS company_org_no
            FROM emission_rounds r
            JOIN users u ON r.startup_id = u.id
            LEFT JOIN company_memberships cm ON cm.user_id = u.id
            LEFT JOIN companies c ON c.id = cm.company_id
            LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
            WHERE r.id=? AND r.open=1
        `, [roundId]);

        if (!roundRows.length){
            await connection.rollback();
            return res.status(400).json({ error:"Emission not open" });
        }

        const round = roundRows[0];
        const [investorRows] = await connection.query(`
            SELECT name, email
            FROM users
            WHERE id=?
            LIMIT 1
        `, [investorId]);

        if (!investorRows.length) {
            await connection.rollback();
            return res.status(404).json({ error:"Investor not found" });
        }

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
            requestedAmount
        ]);

        const agreementId = result.insertId;

        const html = buildRcDocumentHtml(buildRcTemplateData({
            agreement_id: agreementId,
            rc_id: rcId,
            round_id: roundId,
            startup_name: round.startup_name,
            startup_email: round.startup_email,
            company_legal_name: round.company_legal_name,
            company_org_no: round.company_org_no,
            investor_name: investorRows[0].name || req.user.email,
            investor_email: investorRows[0].email || req.user.email,
            investor_identifier: investorRows[0].email || req.user.email,
            investment_amount: requestedAmount,
            target_amount: round.target_amount,
            amount_raised: round.amount_raised,
            discount_rate: round.discount_rate,
            valuation_cap: round.valuation_cap,
            conversion_years: round.conversion_years,
            bank_account: round.bank_account,
            deadline: round.deadline,
            round_open: round.open,
            round_created_at: round.created_at,
            created_at: new Date().toISOString(),
            document_final_status: "Startup pre-approved",
            payment_status: "Not started"
        }));

        const [documentResult] = await connection.query(`
            INSERT INTO documents
            (type, startup_id, title, html_content, status)
            VALUES ('RC', ?, ?, ?, 'DRAFT')
        `, [
            round.startup_id,
            `Privat RC-avtale - ${round.startup_name}`,
            html
        ]);

        const documentId = documentResult.insertId;

        await connection.query(`
            INSERT INTO document_signers
            (document_id, user_id, email, role, status)
            VALUES (?, ?, ?, 'Investor', 'ACCEPTED')
        `, [documentId, investorId, investorRows[0].email]);

        await connection.query(
            "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
            [
                round.startup_id,
                `${investorRows[0].name || investorRows[0].email || "Investor"} har registrert ${formatNOK(requestedAmount)} i den private runden.`
            ]
        ).catch(() => {});

        await connection.commit();

        sendRcAgreementCreatedEmails({
            startupEmail: round.startup_email,
            startupName: round.startup_name,
            investorEmail: investorRows[0].email,
            investorName: investorRows[0].name,
            amount: requestedAmount,
            agreementId
        }).catch((emailError) => {
            console.error("RC agreement notification email failed:", emailError);
        });

        res.json({
            agreementId,
            documentId
        });

    } catch(err){
        await connection.rollback();
        console.error("Invest error:", err);
        res.status(500).json({ error:"Server error" });
    } finally {
        connection.release();
    }
};
