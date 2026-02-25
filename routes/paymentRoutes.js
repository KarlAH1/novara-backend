const express = require("express");
const Payment = require("../models/Payment");
const RCAgreement = require("../models/RCAgreement");
const Round = require("../models/Round");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/initiate/:agreementId", auth, async (req, res) => {
    try {
        const agreement = await RCAgreement.findById(req.params.agreementId);

        agreement.status = "Payment Initiated";
        await agreement.save();

        const payment = new Payment({
            agreement: agreement._id,
            amount: agreement.investmentAmount,
            reference: agreement.rcId,
            investorMarkedSentAt: new Date(),
            status: "Payment Initiated"
        });

        await payment.save();

        res.json(payment);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/confirm/:agreementId", auth, async (req, res) => {
    try {
        const agreement = await RCAgreement.findById(req.params.agreementId);
        const round = await Round.findById(agreement.round);

        agreement.status = "Active RC";
        await agreement.save();

        round.fundedAmount += agreement.investmentAmount;
        await round.save();

        const payment = await Payment.findOne({ agreement: agreement._id });
        payment.status = "Payment Confirmed";
        payment.startupConfirmedAt = new Date();
        await payment.save();

        res.json({ message: "Payment confirmed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;