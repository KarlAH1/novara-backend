import jwt from "jsonwebtoken";

export const auth = (req, res, next) => {
    const header = req.headers["authorization"];
    if (!header) return res.status(401).json({ error: "Missing auth header" });

    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token)
        return res.status(401).json({ error: "Invalid token format" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
};
