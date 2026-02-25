const mongoose = require("mongoose");

const rcAgreementSchema = new mongoose.Schema({
    rcId: { type: String, unique: true },
    round: { type: mongoose.Schema.Types.ObjectId, ref: "Round" },
    investor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    startup: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    investmentAmount: Number,
    status: {
        type: String,
        enum: [
            "Invited",
            "Agreement Generated",
            "Pending Signatures",
            "Signed",
            "Awaiting Payment",
            "Payment Initiated",
            "Payment Confirmed",
            "Active RC"
        ],
        default: "Invited"
    },
    snapshot: Object,
    documentHash: String
}, { timestamps: true });

module.exports = mongoose.model("RCAgreement", rcAgreementSchema);