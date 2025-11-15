import express from "express";
const router = express.Router();
router.get('/', (req,res)=>res.send("startup endpoint"));
export default router;
