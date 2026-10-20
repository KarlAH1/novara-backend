/*
  The public address every link Raisium sends out points to: e-mails, Stripe
  return pages, signing links.

  FRONTEND_URL is also the CORS allow-list, so it can hold several origins,
  localhost among them. Taking its first entry put localhost links in
  production e-mails. Order of preference:
    1. PUBLIC_APP_URL, when set
    2. the first FRONTEND_URL entry that is not localhost
    3. outside production, the first FRONTEND_URL entry (local testing)
    4. https://raisium.io
*/
const DEFAULT_PUBLIC_URL = "https://raisium.io";
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i;

const strip = (value) => String(value || "").trim().replace(/\/+$/, "");

export function publicAppUrl(env = process.env) {
  const explicit = strip(env.PUBLIC_APP_URL);
  if (explicit) return explicit;

  const candidates = String(env.FRONTEND_URL || "")
    .split(",")
    .map(strip)
    .filter(Boolean);
  const publicOrigin = candidates.find((origin) => !LOCAL_ORIGIN.test(origin));
  if (publicOrigin) return publicOrigin;

  const isProduction = String(env.NODE_ENV || "").toLowerCase() === "production";
  if (!isProduction && candidates[0]) return candidates[0];
  return DEFAULT_PUBLIC_URL;
}
