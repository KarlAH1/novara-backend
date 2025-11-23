import express from "express";
import { auth as authMiddleware } from "../middleware/authMiddleware.js";
import { isAdmin } from "../middleware/isAdmin.js";

import {
    adminGetUsers,
    adminDeleteUser,
    adminChangeRole,
    adminGetStartups,
    adminDeleteStartup,
    adminGetEmissions,
    adminDeleteEmission,
    adminGetInvestments
} from "../controllers/adminController.js";

const router = express.Router();

router.get("/users", authMiddleware, isAdmin, adminGetUsers);
router.delete("/user/:id", authMiddleware, isAdmin, adminDeleteUser);
router.patch("/user/:id/role", authMiddleware, isAdmin, adminChangeRole);

router.get("/startups", authMiddleware, isAdmin, adminGetStartups);
router.delete("/startup/:id", authMiddleware, isAdmin, adminDeleteStartup);

router.get("/emissions", authMiddleware, isAdmin, adminGetEmissions);
router.delete("/emission/:id", authMiddleware, isAdmin, adminDeleteEmission);

router.get("/investments", authMiddleware, isAdmin, adminGetInvestments);

export default router;
