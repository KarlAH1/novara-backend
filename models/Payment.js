const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
    agreement: { type: mongoose.Schema.Types.ObjectId, ref: "RCAgreement" },
    amount: Number,
    reference: String,
    investorMarkedSentAt: Date,
    startupConfirmedAt: Date,
    status: {
        type: String,
        enum: ["Awaiting Payment", "Payment Initiated", "Payment Confirmed"],
        default: "Awaiting Payment"
    }
}, { timestamps: true });

module.exports = mongoose.model("Payment", paymentSchema);