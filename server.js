import "./config/env.js";
import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { closePool, testConnection } from "./config/db.js";
import { getEmailProviderConfig } from "./utils/emailService.js";
import { ensureAuthSchema } from "./utils/authSchema.js";
import { ensureAdminIssueSchema } from "./utils/adminIssueSchema.js";
import { ensureConversionSchema } from "./utils/conversionSchema.js";
import { ensureDocumentSchema } from "./utils/documentSchema.js";
import { ensureEmissionRoundSchema } from "./utils/emissionRoundSchema.js";
import { ensureStartupDocumentSchema } from "./utils/startupDocumentSchema.js";
import { ensureInvestorLegalProfileSchema } from "./utils/investorLegalProfileSchema.js";
import { ensureStartupPlanSchema } from "./utils/startupPlanSchema.js";
import { ensureStartupProfileSchema } from "./utils/startupProfileSchema.js";
import { ensureRcAgreementSchema } from "./utils/rcAgreementSchema.js";
import { ensureCapacityReservationSchema } from "./utils/capacityReservation.js";
import { ensureArticlesConfirmationSchema } from "./utils/articlesConfirmation.js";
import { ensureAuditLogSchema } from "./utils/auditLogger.js";
import { ensureImplementationStatusSchema } from "./utils/rcImplementationStatus.js";
import { ensureBoardRoleSchema } from "./utils/boardChairResolution.js";
import { ensureAuditOutboxSchema, processAuditOutbox } from "./utils/auditOutbox.js";
import { stripe, isStripeConfigured } from "./utils/stripeClient.js";
import { handleCheckoutSessionCompleted, handleCheckoutSessionFailed, handlePlanCheckoutSessionCompleted, handleParValueCheckoutSessionCompleted } from "./utils/stripePayments.js";
import { handleConnectedAccountUpdated } from "./utils/stripeConnect.js";
import { closePdfBrowser } from "./utils/pdfRenderer.js";
import { ensurePerformanceIndexes } from "./utils/performanceIndexes.js";

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
const emailProviderConfig = getEmailProviderConfig();

if (isProduction && !emailProviderConfig.configured) {
  console.error("❌ Email provider missing in production. Set RESEND_API_KEY and EMAIL_FROM (or RESEND_FROM).");
  process.exit(1);
}

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
const defaultJsonParser = express.json({ limit: "256kb" });
const uploadJsonParser = express.json({ limit: "10mb" });
const defaultUrlEncodedParser = express.urlencoded({ extended: true, limit: "256kb" });

app.disable("x-powered-by");
if (isProduction || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", Math.max(1, Number(process.env.TRUST_PROXY_HOPS || 1)));
}

app.use((req, res, next) => {
  const requestId = String(req.headers["x-request-id"] || crypto.randomUUID()).slice(0, 128);
  const startedAt = process.hrtime.bigint();
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.onrender.com https://ws.geonorge.no; frame-src 'self' blob:");

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.info(JSON.stringify({
      type: "http_request",
      requestId,
      method: req.method,
      path: req.originalUrl?.split("?")[0],
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      userId: req.user?.id || null
    }));
  });
  next();
});

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
await ensureRcAgreementSchema();
await ensureCapacityReservationSchema();
await ensureArticlesConfirmationSchema();
await ensureAuditLogSchema();
await ensureImplementationStatusSchema();
await ensureBoardRoleSchema();
await ensureAuditOutboxSchema();
await ensurePerformanceIndexes();

/*
  Finalises critical audit events that were enqueued transactionally with the
  business mutation they describe. Runs on a timer so a temporary failure to
  write the durable event is retried rather than lost.
*/
const AUDIT_OUTBOX_INTERVAL_MS = 30000;
setInterval(() => {
  processAuditOutbox().catch((err) => console.error("[audit-outbox]", err?.message));
}, AUDIT_OUTBOX_INTERVAL_MS).unref();
processAuditOutbox().catch((err) => console.error("[audit-outbox]", err?.message));

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
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    credentials: true
  })
);

/* =========================================
   STRIPE WEBHOOK — must see the raw body for signature
   verification, so it's registered before express.json().
========================================= */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!isStripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Stripe webhook not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send("Invalid webhook signature");
  }

  try {
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      await handleCheckoutSessionCompleted(event.data.object);
      await handlePlanCheckoutSessionCompleted(event.data.object);
      await handleParValueCheckoutSessionCompleted(event.data.object);
    } else if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type)) {
      await handleCheckoutSessionFailed(event.data.object);
    } else if (event.type === "account.updated") {
      await handleConnectedAccountUpdated(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handling error:", err);
    res.status(500).json({ error: "Webhook handling failed" });
  }
});

/* =========================================
   MIDDLEWARE
========================================= */
app.use((req, res, next) => {
  const parser = req.path === "/api/startup/articles-of-association"
    ? uploadJsonParser
    : defaultJsonParser;
  return parser(req, res, next);
});
app.use(defaultUrlEncodedParser);
app.use(express.static(frontendDir));

/* =========================================
   ROUTES IMPORT
========================================= */
import authRoutes from "./routes/authRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import stripeRoutes from "./routes/stripeRoutes.js";
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
    version: "2.1.0"
  });
});

app.get("/api/ready", async (req, res) => {
  try {
    await testConnection();
    if (isProduction && !getEmailProviderConfig().configured) {
      return res.status(503).json({
        ok: false,
        error: "Email provider unavailable"
      });
    }
    res.status(200).json({
      ok: true,
      database: "reachable",
      email: getEmailProviderConfig().configured ? "configured" : "missing"
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
app.use("/api/tasks", taskRoutes);
app.use("/api/stripe", stripeRoutes);
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
  "invite-verify.html",
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
  const cleanPath = `/${page.replace(/\.html$/, "")}`;
  if (cleanPath !== "/index") {
    app.get(cleanPath, (req, res) => {
      res.sendFile(path.join(frontendDir, page));
    });
  }
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
  const status = Number(err.status || err.statusCode || 500);
  console.error(JSON.stringify({
    type: "server_error",
    requestId: req.id,
    status,
    code: err.code || null,
    message: err.message || String(err),
    stack: isProduction ? undefined : err.stack
  }));

  res.status(status).json({
    success: false,
    error: status >= 500 && isProduction
      ? "En intern feil oppstod. Prøv igjen senere."
      : (err.message || "Internal Server Error"),
    requestId: req.id
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
      await Promise.allSettled([closePdfBrowser(), closePool()]);
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
