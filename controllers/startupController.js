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
    const { companyName, sector, pitch, country, vision } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Ingen bruker i token" });
    }

    if (!companyName) {
      return res.status(400).json({ error: "Navn på startup (companyName) må fylles ut" });
    }

    if (!sector || !pitch) {
      return res.status(400).json({
        error: "Sektor og kort beskrivelse må fylles ut"
      });
    }

    await pool.query(
      `
      INSERT INTO startup_profiles (user_id, company_name, sector, pitch, country, vision)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        company_name = VALUES(company_name),
        sector = VALUES(sector),
        pitch = VALUES(pitch),
        country = VALUES(country),
        vision = VALUES(vision)
      `,
      [userId, companyName, sector, pitch, country || null, vision || null]
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
        sp.company_name,
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

// POST /api/startup/stop-raising
export const stopRaising = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Ingen bruker i token" });
    }

    const [result] = await pool.query(
      `
      UPDATE startup_profiles
      SET is_raising = 0,
          raising_amount = NULL,
          slip_horizon_months = NULL
      WHERE user_id = ?
      `,
      [userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Fant ingen aktiv SLIP for denne brukeren" });
    }

    return res.json({
      message: "Kapitalinnhentingen er stoppet. Startup vises ikke lenger som 'henter nå'."
    });
  } catch (err) {
    console.error("stopRaising error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

export const getMyStartupProfile = async (req, res) => {
    try {
      const userId = req.user?.id;
  
      if (!userId) {
        return res.status(401).json({ error: "Ingen bruker i token" });
      }
  
      const [rows] = await pool.query(
        "SELECT * FROM startup_profiles WHERE user_id = ? LIMIT 1",
        [userId]
      );
  
      if (!rows.length) {
        return res.json(null);
      }
  
      return res.json(rows[0]);
    } catch (err) {
      console.error("getMyStartupProfile error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  };
  