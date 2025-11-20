// backend/controllers/startupController.js
import pool from "../config/db.js";

// POST /api/startup/slip-setup
export const saveSlipSetup = async (req, res) => {
  try {
    const { amount, horizonMonths } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Ingen bruker i token" });
    }

    if (!amount) {
      return res.status(400).json({ error: "Beløp (amount) må fylles ut" });
    }

    if (Number(amount) > 500000) {
      return res.status(400).json({
        error: "Beløpet kan ikke overstige 500 000 NOK i denne versjonen."
      });
    }

    const horizon = horizonMonths ? Number(horizonMonths) : null;

    await pool.query(
      `
      INSERT INTO startup_profiles (user_id, raising_amount, slip_horizon_months, is_raising)
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        raising_amount = VALUES(raising_amount),
        slip_horizon_months = VALUES(slip_horizon_months),
        is_raising = 1
      `,
      [userId, amount, horizon]
    );

    return res.json({ message: "SLIP-oppsett lagret" });
  } catch (err) {
    console.error("saveSlipSetup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// POST /api/startup/profile
export const saveStartupProfile = async (req, res) => {
  try {
    const { sector, pitch, country, vision } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Ingen bruker i token" });
    }

    if (!sector || !pitch) {
      return res.status(400).json({
        error: "Sektor og kort beskrivelse må fylles ut"
      });
    }

    await pool.query(
      `
      INSERT INTO startup_profiles (user_id, sector, pitch, country, vision)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        sector = VALUES(sector),
        pitch = VALUES(pitch),
        country = VALUES(country),
        vision = VALUES(vision)
      `,
      [userId, sector, pitch, country || null, vision || null]
    );

    return res.json({ message: "Startup-profil lagret" });
  } catch (err) {
    console.error("saveStartupProfile error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// GET /api/startup/list
export const listPublicStartups = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        u.id AS user_id,
        u.name AS founder_name,
        sp.sector,
        sp.pitch,
        sp.country,
        sp.raising_amount,
        sp.slip_horizon_months,
        sp.is_raising
      FROM startup_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.is_raising = 1
      ORDER BY sp.raising_amount DESC
      `
    );

    return res.json(rows);
  } catch (err) {
    console.error("listPublicStartups error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
