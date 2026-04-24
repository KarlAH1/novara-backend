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
    adminGetInvestments,
    adminGetUsersByOrgnr,
    adminLinkUserToOrgnr,
    adminRemoveUserFromOrgnr,
    adminGetIssues,
    adminUpdateIssue,
    adminGetPlanPayments,
    adminApprovePlanPayment,
    adminRejectPlanPayment
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
router.get("/plan-payments", authMiddleware, isAdmin, adminGetPlanPayments);
router.post("/plan-payments/:id/approve", authMiddleware, isAdmin, adminApprovePlanPayment);
router.post("/plan-payments/:id/reject", authMiddleware, isAdmin, adminRejectPlanPayment);
router.get("/org/:orgnr/users", authMiddleware, isAdmin, adminGetUsersByOrgnr);
router.post("/org/:orgnr/users", authMiddleware, isAdmin, adminLinkUserToOrgnr);
router.delete("/org/:orgnr/users/:userId", authMiddleware, isAdmin, adminRemoveUserFromOrgnr);
router.get("/issues", authMiddleware, isAdmin, adminGetIssues);
router.patch("/issues/:id", authMiddleware, isAdmin, adminUpdateIssue);

export default router;
