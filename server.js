console.log("DB:", process.env.DB_NAME);

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { testConnection } from "./config/db.js";
import { ensureAuthSchema } from "./utils/authSchema.js";
import { ensureAdminIssueSchema } from "./utils/adminIssueSchema.js";
import { ensureStartupPlanSchema } from "./utils/startupPlanSchema.js";
import { ensureStartupProfileSchema } from "./utils/startupProfileSchema.js";

/* =========================================
   ENVIRONMENT SAFETY CHECK
========================================= */
if (!process.env.JWT_SECRET) {
  console.error("❌ JWT_SECRET missing");
  process.exit(1);
}

if (!process.env.FRONTEND_URL) {
  console.error("❌ FRONTEND_URL missing");
  process.exit(1);
}

/* =========================================
   CREATE APP
========================================= */
const app = express();
const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, "../frontend");

/* =========================================
   DATABASE CONNECTION TEST
========================================= */
await testConnection();
await ensureAuthSchema();
await ensureAdminIssueSchema();
await ensureStartupPlanSchema();
await ensureStartupProfileSchema();

/* =========================================
   CORS – Environment Controlled
========================================= */
app.use(
  cors({
    origin: true,   // tillat alle origins i dev
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* =========================================
   MIDDLEWARE
========================================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.static(frontendDir));

/* =========================================
   ROUTES IMPORT
========================================= */
import authRoutes from "./routes/authRoutes.js";
import startupRoutes from "./routes/startupRoutes.js";
import emissionRoutes from "./routes/emissionRoutes.js";
import investorRoutes from "./routes/investorRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

import rcRoundRoutes from "./routes/rcRoundRoutes.js";
import rcAgreementRoutes from "./routes/rcAgreementRoutes.js";
import rcPaymentRoutes from "./routes/rcPaymentRoutes.js";
import rcDashboardRoutes from "./routes/rcDashboardRoutes.js";
import rcInviteRoutes from "./routes/rcInviteRoutes.js";
import gfRoutes from "./routes/gfRoutes.js";
import documentRoutes from "./routes/documentRoutes.js";
import documentSignerRoutes from "./routes/documentSignerRoutes.js";
import boardRoutes from "./routes/boardRoutes.js";
import enheterRoutes from "./routes/enheterRoutes.js";

/* =========================================
   HEALTH CHECK
========================================= */
app.get("/api", (req, res) => {
  res.status(200).json({
    message: "Raisium Backend is running",
    version: "2.1.0",
    environment: process.env.NODE_ENV || "development"
  });
});

/* =========================================
   API ROUTES
========================================= */
app.use("/api/auth", authRoutes);
app.use("/api/startup", startupRoutes);
app.use("/api/emission", emissionRoutes);
app.use("/api/investor", investorRoutes);
app.use("/api/admin", adminRoutes);

app.use("/api/rc/rounds", rcRoundRoutes);
app.use("/api/rc/agreements", rcAgreementRoutes);
app.use("/api/rc/payments", rcPaymentRoutes);
app.use("/api/rc/dashboard", rcDashboardRoutes);
app.use("/api/rc/invites", rcInviteRoutes);
app.use("/api/startup/gf", gfRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/document-signers", documentSignerRoutes);
app.use("/api/gf", gfRoutes);
app.use("/api/board", boardRoutes);
app.use("/api/enheter", enheterRoutes);

/* =========================================
   FRONTEND HTML FALLBACKS
========================================= */
const frontendPages = [
  "index.html",
  "login.html",
  "register.html",
  "forgot-password.html",
  "reset-password.html",
  "verify-email.html",
  "profile.html",
  "emisjon.html",
  "emisjoner.html",
  "dashboard.html",
  "startup-payment.html",
  "sign.html",
  "payment.html",
  "rc-detail.html",
  "invest.html",
  "invite.html",
  "admin.html"
];

frontendPages.forEach((page) => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(frontendDir, page));
  });
});

/* =========================================
   404 HANDLER
========================================= */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found"
  });
});

/* =========================================
   GLOBAL ERROR HANDLER
========================================= */
app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal Server Error"
  });
});

/* =========================================
   START SERVER
========================================= */
app.listen(PORT, () => {
  console.log(`🚀 Raisium Backend running on port ${PORT}`);
});
