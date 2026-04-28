import { getClientIp, logAuditEvent } from "../utils/auditLogger.js";

const buckets = new Map();

function isDevLocalRequest(req) {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProduction) {
    return false;
  }

  const ip = String(getClientIp(req) || "").trim();
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function getBucketKey(req, keyPrefix) {
  return `${keyPrefix}:${getClientIp(req)}`;
}

export function createRateLimiter({
  keyPrefix,
  windowMs,
  maxRequests,
  message = "For mange forespørsler. Prøv igjen om litt."
}) {
  return (req, res, next) => {
    if (isDevLocalRequest(req)) {
      return next();
    }

    const now = Date.now();
    const key = getBucketKey(req, keyPrefix);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;

    if (bucket.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      logAuditEvent("rate_limit_blocked", {
        ip: getClientIp(req),
        path: req.originalUrl,
        method: req.method,
        keyPrefix
      });
      return res.status(429).json({
        success: false,
        error: message
      });
    }

    next();
  };
}
