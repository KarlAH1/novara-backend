import crypto from "crypto";

// Fødselsnummer is highly sensitive PII — stored encrypted at rest and only
// ever decrypted server-side, at the moment the aksjeeierbok document is
// generated. It must never be selected/returned in any other API response.
const ALGORITHM = "aes-256-gcm";

function getKey() {
  const secret = process.env.NATIONAL_ID_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("NATIONAL_ID_ENCRYPTION_KEY er ikke satt.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptNationalId(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptNationalId(payload) {
  if (!payload) return "";
  const key = getKey();
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
