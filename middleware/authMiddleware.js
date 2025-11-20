// backend/middleware/authMiddleware.js
import jwt from "jsonwebtoken";

export const auth = (req, res, next) => {
  const header = req.headers["authorization"];

  if (!header) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Invalid Authorization format" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded inneholder { id, role, iat, exp }
    req.user = decoded;
    next();
  } catch (err) {
    console.error("JWT verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
