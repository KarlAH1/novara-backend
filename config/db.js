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
  connectionLimit: Math.max(2, Number(process.env.DB_POOL_SIZE || 10)),
  maxIdle: Math.max(1, Number(process.env.DB_POOL_MAX_IDLE || process.env.DB_POOL_SIZE || 10)),
  idleTimeout: Math.max(10000, Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 60000)),
  queueLimit: Math.max(10, Number(process.env.DB_QUEUE_LIMIT || 100)),
  connectTimeout: Math.max(1000, Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000)),
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,

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
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.ping();

    console.log("✅ MySQL connected successfully");
    return true;

  } catch (error) {
    console.error("❌ MySQL connection failed:", error.message);
    throw error;
  } finally {
    connection?.release();
  }
};

export default pool;
