import pool from "../config/db.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";

export const register = async (req,res)=>{
  const {name,email,password,role} = req.body;
  try {
    const [existing] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    if (existing.length) return res.status(400).json({msg:"Email exists"});
    const hashed = await bcryptjs.hash(password,10);
    await pool.query("INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)",
      [name,email,hashed,role]);
    return res.json({msg:"User registered"});
  } catch(e){ return res.status(500).json({error:e.message}); }
};

export const login = async (req,res)=>{
  const {email,password} = req.body;
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
    if (!rows.length) return res.status(400).json({msg:"User not found"});
    const user = rows[0];
    const ok = await bcryptjs.compare(password, user.password);
    if(!ok) return res.status(400).json({msg:"Wrong password"});
    const token = jwt.sign({id:user.id, role:user.role}, process.env.JWT_SECRET, {expiresIn:"7d"});
    return res.json({token});
  } catch(e){ return res.status(500).json({error:e.message}); }
};
