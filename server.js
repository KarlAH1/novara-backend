import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/authRoutes.js";
import startupRoutes from "./routes/startupRoutes.js";
import emissionRoutes from "./routes/emissionRoutes.js";
import investorRoutes from "./routes/investorRoutes.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: [
        "https://luxury-licorice-ed1851.netlify.app", 
        "https://www.raisium.io",
        "https://raisium.io"
    ],
    credentials: true
}));

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Raisium backend API running");
});

app.use("/api/auth", authRoutes);
app.use("/api/startup", startupRoutes);
app.use("/api/emission", emissionRoutes);
app.use("/api/investor", investorRoutes);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
