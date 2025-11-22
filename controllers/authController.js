import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

export const register = async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        const [exists] = await pool.query(
            "SELECT id FROM users WHERE email=?",
            [email]
        );

        if (exists.length > 0)
            return res.status(400).json({ message: "User already exists" });

        const hash = await bcrypt.hash(password, 10);

        const [result] = await pool.query(
            "INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)",
            [name, email, hash, role]
        );

        const token = jwt.sign(
            { id: result.insertId, email, role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            token,
            user: { id: result.insertId, name, email, role }
        });

    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};

export const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const [rows] = await pool.query(
            "SELECT * FROM users WHERE email=?",
            [email]
        );

        if (rows.length === 0)
            return res.status(400).json({ message: "User not found" });

        const user = rows[0];

        const valid = await bcrypt.compare(password, user.password);
        if (!valid)
            return res.status(400).json({ message: "Wrong password" });

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
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
        console.log(err);
        res.status(500).json({ message: "Server error" });
    }
};

export const getMe = async (req, res) => {
    const [rows] = await pool.query(
        "SELECT id, name, email, role FROM users WHERE id=?",
        [req.user.id]
    );

    res.json(rows[0]);
};
