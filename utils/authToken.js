import jwt from "jsonwebtoken";

const JWT_ISSUER = process.env.JWT_ISSUER || "raisium-api";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "raisium-web";
const JWT_ALGORITHMS = ["HS256"];

export function createAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: String(user.role || "").toLowerCase(),
      email: user.email
    },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: process.env.JWT_EXPIRES_IN || "7d"
    }
  );
}

export function verifyAuthToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: JWT_ALGORITHMS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE
    });
  } catch (error) {
    // Existing sessions did not carry issuer/audience. Keep a bounded rollout
    // path; set ALLOW_LEGACY_JWT=false after the previous token TTL has passed.
    if (String(process.env.ALLOW_LEGACY_JWT || "true").toLowerCase() !== "true") {
      throw error;
    }
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: JWT_ALGORITHMS });
  }
}
