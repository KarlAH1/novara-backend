function scrubValue(value) {
  if (value == null) return value;

  if (typeof value === "string") {
    if (value.length > 220) {
      return `${value.slice(0, 220)}…`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map(scrubValue);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 20);
    return Object.fromEntries(entries.map(([key, nested]) => [key, scrubValue(nested)]));
  }

  return value;
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function logAuditEvent(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...scrubValue(details)
  };

  console.info("[audit]", JSON.stringify(payload));
}
