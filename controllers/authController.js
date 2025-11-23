import pool from "../config/db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export async function register(req, res) {
    const { name, email, password, role } = req.body;

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
        "INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)",
        [name, email, hash, role]
    );

    res.json({ message: "User registered" });
}

export async function login(req, res) {
    const { email, password } = req.body;

    const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    const user = rows[0];

    if (!user) return res.status(401).json({ error: "User not found" });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

    res.json({ token, user });
}

export async function me(req, res) {
    const [rows] = await pool.query("SELECT id, name, email, role FROM users WHERE id=?", [
        req.user.id
    ]);

    res.json(rows[0]);
}
