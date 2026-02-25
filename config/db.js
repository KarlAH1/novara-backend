import mysql from "mysql2/promise";

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: {
        rejectUnauthorized: false
    }
});

/* =========================================
   TEST CONNECTION ON STARTUP
========================================= */
export const testConnection = async () => {
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        console.log("✅ MySQL connected successfully");
    } catch (error) {
        console.error("❌ MySQL connection failed:", error.message);
        process.exit(1);
    }
};

export default pool;