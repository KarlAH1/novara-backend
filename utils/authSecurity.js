import crypto from "crypto";

export function validatePasswordRequirements(password) {
  const value = String(password || "");

  if (value.length < 8) {
    return "Passord må være minst 8 tegn";
  }

  if (!/[A-ZÆØÅ]/.test(value)) {
    return "Passord må inneholde minst 1 stor bokstav";
  }

  if (!/\d/.test(value)) {
    return "Passord må inneholde minst 1 tall";
  }

  if (!/[^A-Za-z0-9ÆØÅæøå]/.test(value)) {
    return "Passord må inneholde minst 1 spesialsymbol";
  }

  return null;
}

export function createRawToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function createExpiry(hoursFromNow = 1) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
}
