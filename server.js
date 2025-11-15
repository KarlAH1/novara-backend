import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

import authRoutes from './routes/authRoutes.js';
import investorRoutes from './routes/investorRoutes.js';
import startupRoutes from './routes/startupRoutes.js';

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// API routes (PREFIXED WITH /api)
app.use('/api/auth', authRoutes);
app.use('/api/investor', investorRoutes);
app.use('/api/startup', startupRoutes);

app.get('/', (req, res) => {
  res.send('Novara backend running');
});

app.listen(process.env.PORT || 4000, () =>
  console.log("Server running on port " + (process.env.PORT || 4000))
);
