import pool from "../config/db.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";

// ---------------- REGISTER ----------------
export const register = async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    const [existing] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    if (existing.length) {
      return res.status(400).json({ message: "Email exists" });
    }

    const hashed = await bcryptjs.hash(password, 10);

    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashed, role]
    );

    const user = {
      id: result.insertId,
      name,
      email,
      role
    };

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      message: "User registered",
      token,
      user
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// ---------------- LOGIN ----------------
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    if (!rows.length) {
      return res.status(400).json({ message: "User not found" });
    }

    const user = rows[0];

    const ok = await bcryptjs.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ message: "Wrong password" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
