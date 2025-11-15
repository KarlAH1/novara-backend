import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import pool from './config/db.js';
import authRoutes from './routes/auth.js';
import investorRoutes from './routes/investor.js';
import startupRoutes from './routes/startup.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/investor', investorRoutes);
app.use('/startup', startupRoutes);

app.get('/', (req, res) => res.send('Novara backend running'));
app.listen(process.env.PORT || 4000, () => console.log("Server running"));
