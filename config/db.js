import "./env.js";
import mysql from "mysql2/promise";

/* =========================================
   CREATE MYSQL POOL
========================================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
    ? parseInt(process.env.DB_PORT)
    : 3306,

  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  ssl:
    process.env.DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : false
});

export const closePool = async () => {
  await pool.end();
};

/* =========================================
   TEST CONNECTION ON STARTUP
========================================= */

export const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();

    console.log("✅ MySQL connected successfully");
    return true;

  } catch (error) {
    console.error("❌ MySQL connection failed:", error.message);
    throw error;
  }
};

export default pool;
