import jwt from "jsonwebtoken";

/* =========================================
   MAIN AUTH MIDDLEWARE
========================================= */
export const auth = (req, res, next) => {
    const header = req.headers["authorization"];

    if (!header) {
        return res.status(401).json({ 
            success: false,
            error: "Authorization header missing" 
        });
    }

    const parts = header.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
        return res.status(401).json({ 
            success: false,
            error: "Invalid token format" 
        });
    }

    const token = parts[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // 🔒 FORCE LOWERCASE ROLE
        req.user = {
            id: decoded.id,
            role: decoded.role ? decoded.role.toLowerCase() : null,
            email: decoded.email
        };

        next();

    } catch (err) {
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
            return res.status(403).json({
                success: false,
                error: "Access denied"
            });
        }
        next();
    };
};