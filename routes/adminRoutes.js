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
    adminRejectPlanPayment,
    adminGetConversionReviews,
    adminApproveConversionReview,
    adminApproveConversionTrigger,
    adminGetMyIssues,
    adminReplyIssue,
    replyToOwnIssue,
    adminDeleteIssue
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
router.get("/conversion-reviews", authMiddleware, isAdmin, adminGetConversionReviews);
router.post("/conversion-reviews/:id/approve-trigger", authMiddleware, isAdmin, adminApproveConversionTrigger);
router.post("/conversion-reviews/:id/approve", authMiddleware, isAdmin, adminApproveConversionReview);
router.get("/org/:orgnr/users", authMiddleware, isAdmin, adminGetUsersByOrgnr);
router.post("/org/:orgnr/users", authMiddleware, isAdmin, adminLinkUserToOrgnr);
router.delete("/org/:orgnr/users/:userId", authMiddleware, isAdmin, adminRemoveUserFromOrgnr);
router.get("/issues", authMiddleware, isAdmin, adminGetIssues);
router.patch("/issues/:id", authMiddleware, isAdmin, adminUpdateIssue);
router.delete("/issues/:id", authMiddleware, isAdmin, adminDeleteIssue);
router.post("/issues/:id/reply", authMiddleware, isAdmin, adminReplyIssue);
router.get("/issues/mine", authMiddleware, adminGetMyIssues);
router.post("/issues/:id/reply-own", authMiddleware, replyToOwnIssue);

export default router;
