// utils/hash.js
import crypto from "crypto";

export const generateHash = (data) => {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex");
};