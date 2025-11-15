const express = require("express");
const router = express.Router();

const { register, login } = require("../controllers/authController.js");

// --------------------------------------------------
// GET /ping – for testing
// --------------------------------------------------
router.get("/ping", (req, res) => {
  res.json({ message: "Auth API is working!" });
});

// --------------------------------------------------
// Auth endpoints
// --------------------------------------------------
router.post("/register", register);
router.post("/login", login);

module.exports = router;
