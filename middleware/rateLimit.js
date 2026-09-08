import { getClientIp, logAuditEvent } from "../utils/auditLogger.js";

const buckets = new Map();
const MAX_BUCKETS = Math.max(1000, Number(process.env.RATE_LIMIT_MAX_BUCKETS || 10000));
let requestsSinceSweep = 0;

function isDevLocalRequest(req) {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProduction) {
    return false;
  }

  const ip = String(getClientIp(req) || "").trim();
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function getBucketKeys(req, keyPrefix) {
  const ip = getClientIp(req);
  const email = String(req.body?.email || "").trim().toLowerCase();
  return [
    `${keyPrefix}:ip:${ip}`,
    ...(email ? [`${keyPrefix}:email:${email}`] : [])
  ];
}

function sweepExpiredBuckets(now) {
  requestsSinceSweep += 1;
  if (requestsSinceSweep < 100 && buckets.size < MAX_BUCKETS) return;
  requestsSinceSweep = 0;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  while (buckets.size > MAX_BUCKETS) {
    buckets.delete(buckets.keys().next().value);
  }
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
    sweepExpiredBuckets(now);
    const keys = getBucketKeys(req, keyPrefix);
    const activeBuckets = keys.map((key) => {
      const current = buckets.get(key);
      const bucket = !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
      bucket.count += 1;
      buckets.set(key, bucket);
      return bucket;
    });
    const blockedBucket = activeBuckets.find((bucket) => bucket.count > maxRequests);

    if (blockedBucket) {
      const retryAfterSeconds = Math.max(1, Math.ceil((blockedBucket.resetAt - now) / 1000));
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

    return next();
  };
}
