import "./config/env.js";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { closePool, testConnection } from "./config/db.js";
import { ensureAuthSchema } from "./utils/authSchema.js";
import { ensureAdminIssueSchema } from "./utils/adminIssueSchema.js";
import { ensureConversionSchema } from "./utils/conversionSchema.js";
import { ensureDocumentSchema } from "./utils/documentSchema.js";
import { ensureEmissionRoundSchema } from "./utils/emissionRoundSchema.js";
import { ensureStartupDocumentSchema } from "./utils/startupDocumentSchema.js";
import { ensureInvestorLegalProfileSchema } from "./utils/investorLegalProfileSchema.js";
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

const requiredDbVars = ["DB_HOST", "DB_USER", "DB_NAME"];
const missingDbVars = requiredDbVars.filter((key) => !process.env[key]);

if (missingDbVars.length) {
  console.error(`❌ Missing DB config: ${missingDbVars.join(", ")}`);
  process.exit(1);
}

const isProduction = (process.env.NODE_ENV || "").toLowerCase() === "production";

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!configuredOrigins.length) {
    return [];
  }

  if (!isProduction) {
    return Array.from(new Set([
      ...configuredOrigins,
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:3000",
      "http://127.0.0.1:3000"
    ]));
  }

  return configuredOrigins;
}

const allowedOrigins = getAllowedOrigins();
const devOriginPatterns = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i
];

function isAllowedDevOrigin(origin) {
  if (!origin || origin === "null") {
    return true;
  }

  return devOriginPatterns.some((pattern) => pattern.test(origin));
}

/* =========================================
   CREATE APP
========================================= */
const app = express();
const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, "../frontend");

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

/* =========================================
   DATABASE CONNECTION TEST
========================================= */
await testConnection();
await ensureAuthSchema();
await ensureAdminIssueSchema();
await ensureConversionSchema();
await ensureDocumentSchema();
await ensureEmissionRoundSchema();
await ensureInvestorLegalProfileSchema();
await ensureStartupDocumentSchema();
await ensureStartupPlanSchema();
await ensureStartupProfileSchema();

/* =========================================
   CORS – Environment Controlled
========================================= */
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (!isProduction && isAllowedDevOrigin(origin)) {
        return callback(null, true);
      }

      if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS origin not allowed"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

/* =========================================
   MIDDLEWARE
========================================= */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(frontendDir));

/* =========================================
   ROUTES IMPORT
========================================= */
import authRoutes from "./routes/authRoutes.js";
import startupRoutes from "./routes/startupRoutes.js";
import emissionRoutes from "./routes/emissionRoutes.js";
import investorRoutes from "./routes/investorRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

import rcAgreementRoutes from "./routes/rcAgreementRoutes.js";
import rcInviteRoutes from "./routes/rcInviteRoutes.js";
import conversionRoutes from "./routes/conversionRoutes.js";
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

app.get("/api/ready", async (req, res) => {
  try {
    await testConnection();
    res.status(200).json({
      ok: true,
      database: "reachable"
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: "Database unavailable"
    });
  }
});

/* =========================================
   API ROUTES
========================================= */
app.use("/api/auth", authRoutes);
app.use("/api/startup", startupRoutes);
app.use("/api/emission", emissionRoutes);
app.use("/api/investor", investorRoutes);
app.use("/api/admin", adminRoutes);

app.use("/api/rc/agreements", rcAgreementRoutes);
app.use("/api/rc/invites", rcInviteRoutes);
app.use("/api/conversion", conversionRoutes);
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
  "convert.html",
  "document.html",
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
const server = app.listen(PORT, () => {
  console.log(`🚀 Raisium Backend running on port ${PORT}`);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} er allerede i bruk. Stopp den andre backend-prosessen eller sett en annen PORT.`);
    process.exit(1);
  }

  console.error("❌ Server failed to start:", error);
  process.exit(1);
});

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down gracefully...`);

  server.close(async () => {
    try {
      await closePool();
    } catch (error) {
      console.error("Error while closing DB pool:", error);
    } finally {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
