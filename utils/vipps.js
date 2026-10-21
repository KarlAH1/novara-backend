import crypto from "crypto";
import db from "../config/db.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { vippsApiBase } from "./featureFlags.js";

/*
  Vipps MobilePay, behind switches (see featureFlags.js).

  Login: OpenID Connect against Vipps Login. The investor signs in with
  Vipps instead of e-mail + code, and the account is matched on Vipps' stable
  subject id (users.vipps_sub), then on a verified e-mail.

  Payment: the ePayment API with Raisium's partner keys, on behalf of the
  startup's own Vipps merchant (companies.vipps_msn). The money goes straight
  to the startup, as with bank transfer and Stripe; Raisium never holds it.

  Nothing here runs until the keys are set. It follows Vipps' published API;
  it has not been exercised against Vipps yet and must be tested in their
  test environment (VIPPS_ENV=test) before the switches go on in production.
*/

const TIMEOUT_MS = Number(process.env.VIPPS_TIMEOUT_MS || 10000);
const STATE_TTL_MINUTES = 15;

export async function ensureVippsSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS vipps_login_states (
      state_hash CHAR(64) PRIMARY KEY,
      nonce VARCHAR(64) NOT NULL,
      invite_token VARCHAR(128) NULL,
      terms_accepted TINYINT(1) NOT NULL DEFAULT 0,
      login_code_hash CHAR(64) NULL,
      user_id INT NULL,
      consumed_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const additions = [
    ["companies", "vipps_msn", "ALTER TABLE companies ADD COLUMN vipps_msn VARCHAR(16) NULL"],
    ["rc_agreements", "vipps_reference", "ALTER TABLE rc_agreements ADD COLUMN vipps_reference VARCHAR(64) NULL"],
    ["rc_agreements", "vipps_paid_at", "ALTER TABLE rc_agreements ADD COLUMN vipps_paid_at DATETIME NULL"]
  ];
  for (const [table, column, sql] of additions) {
    const [rows] = await db.query(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [table, column]
    );
    if (!rows.length) await db.query(sql);
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

/* ---------------- Login (OpenID Connect) ---------------- */

let discoveryCache = null;
async function discovery() {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  const res = await fetchWithTimeout(
    `${vippsApiBase()}/access-management-1.0/access/.well-known/openid-configuration`,
    {},
    { timeoutMs: TIMEOUT_MS }
  );
  if (!res.ok) throw new Error(`Vipps discovery failed (${res.status})`);
  const value = await res.json();
  discoveryCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

export function vippsLoginRedirectUri(publicBase) {
  return process.env.VIPPS_LOGIN_REDIRECT_URI || `${publicBase}/api/vipps/login/callback`;
}

export async function startVippsLogin({ inviteToken, termsAccepted, publicBase }) {
  const state = randomToken(24);
  const nonce = randomToken(16);
  await db.query(
    `INSERT INTO vipps_login_states (state_hash, nonce, invite_token, terms_accepted) VALUES (?, ?, ?, ?)`,
    [sha256(state), nonce, inviteToken || null, termsAccepted ? 1 : 0]
  );
  // Old, unused states are not worth keeping.
  db.query("DELETE FROM vipps_login_states WHERE created_at < NOW() - INTERVAL 1 DAY").catch(() => {});

  const config = await discovery();
  const params = new URLSearchParams({
    client_id: process.env.VIPPS_LOGIN_CLIENT_ID,
    response_type: "code",
    scope: "openid name email phoneNumber",
    state,
    nonce,
    redirect_uri: vippsLoginRedirectUri(publicBase)
  });
  return `${config.authorization_endpoint}?${params.toString()}`;
}

// Takes the one-time state back; null if unknown, used or too old.
export async function consumeLoginState(state) {
  const [[row]] = await db.query(
    `SELECT state_hash, nonce, invite_token, terms_accepted, created_at
     FROM vipps_login_states
     WHERE state_hash = ? AND consumed_at IS NULL
       AND created_at > NOW() - INTERVAL ${STATE_TTL_MINUTES} MINUTE
     LIMIT 1`,
    [sha256(state)]
  );
  if (!row) return null;
  const [update] = await db.query(
    "UPDATE vipps_login_states SET consumed_at = NOW() WHERE state_hash = ? AND consumed_at IS NULL",
    [row.state_hash]
  );
  return update.affectedRows === 1 ? row : null;
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/*
  Code for tokens, then the user's profile. The id_token comes straight from
  Vipps' token endpoint over TLS, so its claims are checked (issuer, audience,
  nonce) without verifying its signature (OpenID Connect Core 3.1.3.7).
*/
export async function completeVippsLogin({ code, nonce, publicBase }) {
  const config = await discovery();
  const basic = Buffer.from(
    `${process.env.VIPPS_LOGIN_CLIENT_ID}:${process.env.VIPPS_LOGIN_CLIENT_SECRET}`
  ).toString("base64");

  const tokenRes = await fetchWithTimeout(config.token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: vippsLoginRedirectUri(publicBase)
    }).toString()
  }, { timeoutMs: TIMEOUT_MS });
  if (!tokenRes.ok) throw new Error(`Vipps token exchange failed (${tokenRes.status})`);
  const tokens = await tokenRes.json();

  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims
      || claims.nonce !== nonce
      || (config.issuer && claims.iss !== config.issuer)
      || ![].concat(claims.aud || []).includes(process.env.VIPPS_LOGIN_CLIENT_ID)) {
    throw new Error("Vipps id_token did not match this login");
  }

  const infoRes = await fetchWithTimeout(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  }, { timeoutMs: TIMEOUT_MS });
  if (!infoRes.ok) throw new Error(`Vipps userinfo failed (${infoRes.status})`);
  const info = await infoRes.json();

  if (!info.sub || info.sub !== claims.sub) throw new Error("Vipps userinfo subject mismatch");
  return {
    sub: String(info.sub),
    name: String(info.name || [info.given_name, info.family_name].filter(Boolean).join(" ") || "").trim(),
    email: String(info.email || "").trim().toLowerCase(),
    emailVerified: info.email_verified === true || info.email_verified === "true",
    phone: String(info.phone_number || "").trim() || null
  };
}

// A short-lived code the browser trades for its session, so the session
// token never travels in a URL.
export async function issueLoginCode(stateHash, userId) {
  const code = randomToken(24);
  await db.query(
    "UPDATE vipps_login_states SET login_code_hash = ?, user_id = ? WHERE state_hash = ?",
    [sha256(code), userId, stateHash]
  );
  return code;
}

export async function redeemLoginCode(code) {
  const [[row]] = await db.query(
    `SELECT state_hash, user_id, invite_token FROM vipps_login_states
     WHERE login_code_hash = ? AND user_id IS NOT NULL
       AND created_at > NOW() - INTERVAL ${STATE_TTL_MINUTES} MINUTE
     LIMIT 1`,
    [sha256(code)]
  );
  if (!row) return null;
  const [update] = await db.query(
    "UPDATE vipps_login_states SET login_code_hash = NULL WHERE state_hash = ? AND login_code_hash IS NOT NULL",
    [row.state_hash]
  );
  return update.affectedRows === 1 ? row : null;
}

/* ---------------- Payment (ePayment, partner keys) ---------------- */

let accessTokenCache = null;
async function partnerAccessToken() {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.token;
  const res = await fetchWithTimeout(`${vippsApiBase()}/accesstoken/get`, {
    method: "POST",
    headers: {
      client_id: process.env.VIPPS_CLIENT_ID,
      client_secret: process.env.VIPPS_CLIENT_SECRET,
      "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY
    }
  }, { timeoutMs: TIMEOUT_MS });
  if (!res.ok) throw new Error(`Vipps access token failed (${res.status})`);
  const data = await res.json();
  accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return accessTokenCache.token;
}

async function vippsHeaders(msn, idempotencyKey = null) {
  return {
    Authorization: `Bearer ${await partnerAccessToken()}`,
    "Ocp-Apim-Subscription-Key": process.env.VIPPS_SUBSCRIPTION_KEY,
    "Merchant-Serial-Number": String(msn),
    "Content-Type": "application/json",
    "Vipps-System-Name": "raisium",
    "Vipps-System-Version": "1.0",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
  };
}

export function isValidMsn(value) {
  return /^\d{5,8}$/.test(String(value || "").trim());
}

export async function createVippsPayment({ msn, reference, amountNok, description, returnUrl }) {
  const res = await fetchWithTimeout(`${vippsApiBase()}/epayment/v1/payments`, {
    method: "POST",
    headers: await vippsHeaders(msn, reference),
    body: JSON.stringify({
      amount: { currency: "NOK", value: Math.round(Number(amountNok) * 100) },
      paymentMethod: { type: "WALLET" },
      reference,
      returnUrl,
      userFlow: "WEB_REDIRECT",
      paymentDescription: description.slice(0, 100)
    })
  }, { timeoutMs: TIMEOUT_MS });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vipps create payment failed (${res.status}) ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function getVippsPayment({ msn, reference }) {
  const res = await fetchWithTimeout(
    `${vippsApiBase()}/epayment/v1/payments/${encodeURIComponent(reference)}`,
    { headers: await vippsHeaders(msn) },
    { timeoutMs: TIMEOUT_MS }
  );
  if (!res.ok) throw new Error(`Vipps get payment failed (${res.status})`);
  return res.json();
}

export async function captureVippsPayment({ msn, reference, amountNok }) {
  const res = await fetchWithTimeout(
    `${vippsApiBase()}/epayment/v1/payments/${encodeURIComponent(reference)}/capture`,
    {
      method: "POST",
      headers: await vippsHeaders(msn, `${reference}-capture`),
      body: JSON.stringify({ modificationAmount: { currency: "NOK", value: Math.round(Number(amountNok) * 100) } })
    },
    { timeoutMs: TIMEOUT_MS }
  );
  if (!res.ok) throw new Error(`Vipps capture failed (${res.status})`);
  return res.json();
}
