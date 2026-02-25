import jwt from "jsonwebtoken";

/* =========================================
   MAIN AUTH MIDDLEWARE
========================================= */
export const auth = (req, res, next) => {
    const header = req.headers["authorization"];

    if (!header) {
        return res.status(401).json({ error: "Authorization header missing" });
    }

    const parts = header.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
        return res.status(401).json({ error: "Invalid token format" });
    }

    const token = parts[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Attach safe user object to request
        req.user = {
            id: decoded.id,
            role: decoded.role,
            email: decoded.email
        };

        next();

    } catch (err) {
        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }
};

/* =========================================
   ROLE GUARD (Optional but Recommended)
========================================= */
export const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                error: "Access denied"
            });
        }
        next();
    };
};