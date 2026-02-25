const mongoose = require("mongoose");

const roundSchema = new mongoose.Schema({
    startup: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    name: String,
    rcPoolPercent: Number,
    rcPoolAmount: Number,
    triggerAmount: Number,
    optionalConversion: Boolean,
    maturationDate: Date,
    discount: Number,
    valuationCap: Number,
    signedAmount: { type: Number, default: 0 },
    fundedAmount: { type: Number, default: 0 },
    status: { type: String, default: "OPEN" }
}, { timestamps: true });

module.exports = mongoose.model("Round", roundSchema);