const express = require("express");
const Round = require("../models/Round");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", auth, async (req, res) => {
    try {
        const round = new Round({
            ...req.body,
            startup: req.user.id
        });
        await round.save();
        res.json(round);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/:id", auth, async (req, res) => {
    try {
        const round = await Round.findById(req.params.id);
        res.json(round);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;