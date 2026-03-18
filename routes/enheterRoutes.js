import express from "express";
import { fetchBrregCompany } from "../utils/brreg.js";

const router = express.Router();

router.get("/:orgnr", async (req, res) => {
  try {
    const company = await fetchBrregCompany(req.params.orgnr);
    res.json(company);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Server error" });
  }
});

export default router;
