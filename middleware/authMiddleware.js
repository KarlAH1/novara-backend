import jwt from "jsonwebtoken";
import db from "../config/db.js";
import { getClientIp, logAuditEvent } from "../utils/auditLogger.js";

/* =========================================
   MAIN AUTH MIDDLEWARE
========================================= */
export const auth = async (req, res, next) => {
    const header = req.headers["authorization"];

    if (!header) {
        logAuditEvent("auth_missing_header", {
            ip: getClientIp(req),
            path: req.originalUrl,
            method: req.method
        });
        return res.status(401).json({ 
            success: false,
            error: "Authorization header missing" 
        });
    }

    const parts = header.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
        logAuditEvent("auth_invalid_format", {
            ip: getClientIp(req),
            path: req.originalUrl,
            method: req.method
        });
        return res.status(401).json({ 
            success: false,
            error: "Invalid token format" 
        });
    }

    const token = parts[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await db.execute(
            "SELECT id, email, role, email_verified FROM users WHERE id = ? LIMIT 1",
            [decoded.id]
        );

        if (!users.length) {
            logAuditEvent("auth_user_missing", {
                userId: decoded.id,
                ip: getClientIp(req),
                path: req.originalUrl
            });
            return res.status(401).json({
                success: false,
                error: "Invalid or expired token"
            });
        }

        const user = users[0];

        req.user = {
            id: user.id,
            role: user.role ? user.role.toLowerCase() : null,
            email: user.email,
            emailVerified: Boolean(user.email_verified)
        };

        next();

    } catch (err) {
        logAuditEvent("auth_token_rejected", {
            ip: getClientIp(req),
            path: req.originalUrl,
            method: req.method,
            reason: err.message
        });
        return res.status(401).json({
            success: false,
            error: "Invalid or expired token"
        });
    }
};


/* =========================================
   ROLE GUARD
========================================= */
export const requireRole = (roles) => {
    // 🔒 Normalize allowed roles to lowercase once
    const normalizedRoles = roles.map(r => r.toLowerCase());

    return (req, res, next) => {
        if (!req.user || !normalizedRoles.includes(req.user.role)) {
            logAuditEvent("auth_role_denied", {
                userId: req.user?.id || null,
                role: req.user?.role || null,
                allowedRoles: normalizedRoles,
                ip: getClientIp(req),
                path: req.originalUrl
            });
            return res.status(403).json({
                success: false,
                error: "Access denied"
            });
        }
        next();
    };
};
