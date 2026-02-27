import "dotenv/config";
import express from "express";
import cors from "cors";

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* =========================================
   EXISTING ROUTES
========================================= */
import authRoutes from "./routes/authRoutes.js";
import startupRoutes from "./routes/startupRoutes.js";
import emissionRoutes from "./routes/emissionRoutes.js";
import investorRoutes from "./routes/investorRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

/* =========================================
   NEW RAISIUM CONVERTS (RC) ROUTES
========================================= */
import rcRoundRoutes from "./routes/rcRoundRoutes.js";
import rcAgreementRoutes from "./routes/rcAgreementRoutes.js";
import rcPaymentRoutes from "./routes/rcPaymentRoutes.js";
import rcDashboardRoutes from "./routes/rcDashboardRoutes.js";
import rcInviteRoutes from "./routes/rcInviteRoutes.js";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================================
   CORS – Required for Render + Netlify
========================================= */
app.use(cors({
    origin: [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://raisium.io",
        "https://www.raisium.io",
        "https://luxury-licorice-ed1851.netlify.app"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

/* =========================================
   MIDDLEWARE
========================================= */
app.use(express.json());

/* =========================================
   HEALTH CHECK
========================================= */
app.get("/", (req, res) => {
    res.status(200).json({
        message: "Raisium Backend is running",
        version: "2.0.0",
        environment: process.env.NODE_ENV || "development"
    });
});

/* =========================================
   EXISTING API ROUTES
========================================= */
app.use("/api/auth", authRoutes);
app.use("/api/startup", startupRoutes);
app.use("/api/emission", emissionRoutes);
app.use("/api/investor", investorRoutes);
app.use("/api/admin", adminRoutes);

/* =========================================
   RAISIUM CONVERTS (RC) API ROUTES
   Namespace separated from legacy emissions
========================================= */
app.use("/api/rc/rounds", rcRoundRoutes);
app.use("/api/rc/agreements", rcAgreementRoutes);
app.use("/api/rc/payments", rcPaymentRoutes);
app.use("/api/rc/dashboard", rcDashboardRoutes);
app.use("/api/rc/invites", rcInviteRoutes);

/* =========================================
   404 HANDLER
========================================= */
app.use((req, res) => {
    res.status(404).json({
        error: "Route not found"
    });
});

/* =========================================
   GLOBAL ERROR HANDLER
========================================= */
app.use((err, req, res, next) => {
    console.error("Server Error:", err);

    res.status(err.status || 500).json({
        error: err.message || "Internal Server Error"
    });
});

/* =========================================
   START SERVER
========================================= */
app.listen(PORT, () => {
    console.log(`🚀 Raisium Backend running on port ${PORT}`);
});