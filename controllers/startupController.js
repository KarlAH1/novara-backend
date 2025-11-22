import pool from "../config/db.js";

// ---------------------------------------------------
// CREATE STARTUP PROFILE + AUTOMATISK EMISJON
// ---------------------------------------------------
export const createStartupProfile = async (req, res) => {
    try {
        // midlertidig (til JWT er helt satt opp)
        const userId = req.user?.id || 1;

        const {
            company_name,
            sector,
            pitch,
            country,
            vision,
            raising_amount,
            slip_horizon_months
        } = req.body;

        // Opprett startup-profilen
        const [profileInsert] = await pool.query(
            `INSERT INTO startup_profiles
            (user_id, company_name, sector, pitch, country, vision, raising_amount, slip_horizon_months)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                company_name,
                sector,
                pitch,
                country,
                vision,
                raising_amount,
                slip_horizon_months
            ]
        );

        const startupId = profileInsert.insertId;

        // Lag automatisk emisjon for startupen
        const deadline = new Date(Date.now() + slip_horizon_months * 24 * 60 * 60 * 1000);

        await pool.query(
            `INSERT INTO emission_rounds (startup_id, target_amount, deadline)
             VALUES (?, ?, ?)`,
            [startupId, raising_amount, deadline]
        );

        return res.json({
            message: "Startup-profil og emisjon opprettet",
            startup_id: startupId
        });

    } catch (err) {
        console.error("❌ Error in createStartupProfile:", err);
        res.status(500).json({ error: "Serverfeil ved opprettelse av startup-profil" });
    }
};

// ---------------------------------------------------
// GET ALL STARTUPS FOR ONE USER
// ---------------------------------------------------
export const getMyStartups = async (req, res) => {
    try {
        const { userId } = req.params;

        const [rows] = await pool.query(
            `SELECT *
             FROM startup_profiles
             WHERE user_id = ?`,
            [userId]
        );

        return res.json(rows);

    } catch (err) {
        console.error("❌ Error in getMyStartups:", err);
        res.status(500).json({ error: "Kunne ikke hente dine startups" });
    }
};
