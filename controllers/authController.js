import pool from "../config/db.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

export const register = async (req, res) => {
    const { name, email, password, role } = req.body;

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
        "INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)",
        [name, email, hashed, role]
    );

    res.json({ message: "User registered" });
};

export const login = async (req, res) => {
    const { email, password } = req.body;

    const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    const user = rows[0];

    if (!user) return res.status(404).json({ error: "User not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign(
        { id: user.id, role: user.role },
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
};

export const getMe = async (req, res) => {
    const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [req.user.id]);
    res.json(rows[0]);
};
