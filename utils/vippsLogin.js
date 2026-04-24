import crypto from "crypto";
import jwt from "jsonwebtoken";

const DEFAULT_TEST_ISSUER = "https://apitest.vipps.no/access-management-1.0/access";
const DEFAULT_PROD_ISSUER = "https://api.vipps.no/access-management-1.0/access";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getVippsBaseUrl() {
  const configured = cleanBaseUrl(process.env.VIPPS_LOGIN_BASE_URL);
  if (configured) return configured;

  const useProduction = String(process.env.VIPPS_LOGIN_ENV || "").toLowerCase() === "production";
  return useProduction ? DEFAULT_PROD_ISSUER : DEFAULT_TEST_ISSUER;
}

function getFrontendBase() {
  const frontendUrl = String(process.env.FRONTEND_URL || "").split(",")[0];
  return cleanBaseUrl(frontendUrl);
}

function getRedirectUri() {
  const backendBase = cleanBaseUrl(process.env.BACKEND_URL || process.env.PUBLIC_BACKEND_URL);
  return String(process.env.VIPPS_LOGIN_REDIRECT_URI || "").trim() ||
    `${backendBase || getFrontendBase()}/api/auth/vipps/callback`;
}

function getSystemHeaders() {
  const headers = {
    "Merchant-Serial-Number": process.env.VIPPS_MERCHANT_SERIAL_NUMBER || "",
    "Vipps-System-Name": process.env.VIPPS_SYSTEM_NAME || "raisium",
    "Vipps-System-Version": process.env.VIPPS_SYSTEM_VERSION || "1.0.0",
    "Vipps-System-Plugin-Name": process.env.VIPPS_SYSTEM_PLUGIN_NAME || "raisium",
    "Vipps-System-Plugin-Version": process.env.VIPPS_SYSTEM_PLUGIN_VERSION || "1.0.0"
  };

  if (process.env.VIPPS_SUBSCRIPTION_KEY) {
    headers["Ocp-Apim-Subscription-Key"] = process.env.VIPPS_SUBSCRIPTION_KEY;
  }

  return headers;
}

export function isVippsLoginConfigured() {
  return Boolean(
    process.env.VIPPS_CLIENT_ID &&
    process.env.VIPPS_CLIENT_SECRET &&
    process.env.VIPPS_MERCHANT_SERIAL_NUMBER
  );
}

export function createVippsState({ redirect = "profile.html", role = "investor" } = {}) {
  return jwt.sign(
    {
      provider: "vipps",
      redirect,
      role,
      nonce: crypto.randomBytes(18).toString("hex")
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

export function verifyVippsState(state) {
  const decoded = jwt.verify(state, process.env.JWT_SECRET);
  if (decoded.provider !== "vipps") {
    throw new Error("Invalid Vipps state");
  }
  return decoded;
}

export async function getVippsOpenIdConfiguration() {
  const url = `${getVippsBaseUrl()}/.well-known/openid-configuration`;
  const response = await fetch(url, {
    headers: getSystemHeaders()
  });

  if (!response.ok) {
    throw new Error(`Vipps OpenID configuration failed: ${await response.text()}`);
  }

  return response.json();
}

export async function buildVippsAuthorizationUrl({ state }) {
  const config = await getVippsOpenIdConfiguration();
  const url = new URL(config.authorization_endpoint);

  url.searchParams.set("client_id", process.env.VIPPS_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", process.env.VIPPS_LOGIN_SCOPE || "openid name email phoneNumber");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", getRedirectUri());

  return url.toString();
}

export async function exchangeVippsCodeForTokens(code) {
  const config = await getVippsOpenIdConfiguration();
  const credentials = Buffer
    .from(`${process.env.VIPPS_CLIENT_ID}:${process.env.VIPPS_CLIENT_SECRET}`, "utf8")
    .toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri()
  });

  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: {
      ...getSystemHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Vipps token exchange failed: ${await response.text()}`);
  }

  return {
    config,
    tokens: await response.json()
  };
}

export async function fetchVippsUserinfo({ accessToken, userinfoEndpoint }) {
  if (!userinfoEndpoint || !accessToken) return null;

  const response = await fetch(userinfoEndpoint, {
    headers: {
      ...getSystemHeaders(),
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Vipps userinfo failed: ${await response.text()}`);
  }

  return response.json();
}

function getTokenHeader(token) {
  const [header] = String(token || "").split(".");
  if (!header) return null;
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}

export async function verifyVippsIdToken({ idToken, config }) {
  if (!idToken) {
    throw new Error("Vipps ID token missing");
  }

  const header = getTokenHeader(idToken);
  if (!header?.kid) {
    throw new Error("Vipps ID token key id missing");
  }

  const jwksResponse = await fetch(config.jwks_uri, {
    headers: getSystemHeaders()
  });

  if (!jwksResponse.ok) {
    throw new Error(`Vipps JWKS failed: ${await jwksResponse.text()}`);
  }

  const jwks = await jwksResponse.json();
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error("Vipps signing key not found");
  }

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return jwt.verify(idToken, publicKey, {
    algorithms: ["RS256"],
    audience: process.env.VIPPS_CLIENT_ID,
    issuer: config.issuer
  });
}
