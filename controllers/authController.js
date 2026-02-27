import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.js";

/* =========================================
   REGISTER
========================================= */
export const register = async (req, res) => {
  try {
    let { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        error: "All fields are required"
      });
    }

    role = role.toLowerCase();
    const allowedRoles = ["investor", "startup", "admin"];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Invalid role"
      });
    }

    const [existing] = await db.execute(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Email already registered"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.execute(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashedPassword, role]
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully"
    });

  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
};


/* =========================================
   LOGIN
========================================= */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const [users] = await db.execute(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid credentials"
      });
    }

    const user = users[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        error: "Invalid credentials"
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role.toLowerCase(),
        email: user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.toLowerCase()
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
};


/* =========================================
   GET ME
========================================= */
export const getMe = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Not authenticated"
      });
    }

    res.json({
      success: true,
      user: req.user
    });

  } catch (error) {
    console.error("getMe error:", error);
    res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
};