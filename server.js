import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/authRoutes.js";
import startupRoutes from "./routes/startupRoutes.js";
import emissionRoutes from "./routes/emissionRoutes.js";
import investorRoutes from "./routes/investorRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================================
   CORS – Render krever eksplisitt whitelist
========================================= */
app.use(cors({
    origin: [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://raisium.io",
        "https://www.raisium.io",
        "https://luxury-licorice-ed1851.netlify.app" // ← Netlify build
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// Forhåndskall (OPTIONS) – *må* være med for POST-auth
app.options("*", cors());

/* =========================================
   MIDDLEWARE
========================================= */
app.use(express.json());

/* =========================================
   ROOT
========================================= */
app.get("/", (req, res) => {
    res.send("Raisium Backend is running");
});

/* =========================================
   ROUTES
========================================= */
app.use("/api/auth", authRoutes);
app.use("/api/startup", startupRoutes);
app.use("/api/emission", emissionRoutes);
app.use("/api/investor", investorRoutes);
app.use("/api/admin", adminRoutes);

/* =========================================
   START SERVER
========================================= */
app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
});
