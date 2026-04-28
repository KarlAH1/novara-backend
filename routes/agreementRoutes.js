const express = require("express");
const RCAgreement = require("../models/RCAgreement");
const Round = require("../models/Round");
const { generateHash } = require("../utils/hash");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", auth, async (req, res) => {
    try {
        const { roundId, investmentAmount } = req.body;

        const round = await Round.findById(roundId);

        const snapshot = {
            investmentAmount,
            rcPoolPercent: round.rcPoolPercent,
            rcPoolAmount: round.rcPoolAmount,
            maturationDate: round.maturationDate
        };

        const hash = generateHash(snapshot);

        const agreement = new RCAgreement({
            rcId: `RC-${Date.now()}`,
            round: roundId,
            investor: req.user.id,
            startup: round.startup,
            investmentAmount,
            snapshot,
            documentHash: hash,
            status: "Pending Signatures"
        });

        await agreement.save();

        round.signedAmount += investmentAmount;
        await round.save();

        res.json(agreement);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/:id", auth, async (req, res) => {
    try {
        const agreement = await RCAgreement.findById(req.params.id)
            .populate("round")
            .populate("investor")
            .populate("startup");
        res.json(agreement);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;