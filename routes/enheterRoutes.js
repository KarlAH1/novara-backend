import express from "express";
import { fetchBrregCompany } from "../utils/brreg.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

const router = express.Router();
const brregLimiter = createRateLimiter({
  keyPrefix: "brreg-preview",
  windowMs: 10 * 60 * 1000,
  maxRequests: 30,
  message: "For mange oppslag mot virksomhetsregisteret. Prøv igjen om litt."
});

router.get("/:orgnr", brregLimiter, async (req, res) => {
  try {
    const company = await fetchBrregCompany(req.params.orgnr);
    res.json(company);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Server error" });
  }
});

export default router;
