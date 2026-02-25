import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

/* =========================================
   REGISTER
========================================= */
export const register = async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        // Basic validation
        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: "All fields are required" });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        // Only allow specific roles
        const allowedRoles = ["investor", "startup"];
        if (!allowedRoles.includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        // Check if email exists
        const [existing] = await pool.query(
            "SELECT id FROM users WHERE email=?",
            [email]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: "Email already registered" });
        }

        const hashed = await bcryptjs.hash(password, 10);

        await pool.query(
            "INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)",
            [name, email, hashed, role]
        );

        res.status(201).json({ message: "User registered successfully" });

    } catch (err) {
        console.error("Register error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

/* =========================================
   LOGIN
========================================= */
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password required" });
        }

        const [rows] = await pool.query(
            "SELECT * FROM users WHERE email=?",
            [email]
        );

        const user = rows[0];

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const match = await bcryptjs.compare(password, user.password);

        if (!match) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            {
                id: user.id,
                role: user.role,
                email: user.email
            },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

/* =========================================
   GET CURRENT USER
========================================= */
export const getMe = async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, name, email, role FROM users WHERE id=?",
            [req.user.id]
        );

        const user = rows[0];

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(user);

    } catch (err) {
        console.error("GetMe error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
};