import { Router } from "express";
import { getMe, updateRole, completeProfile } from "../controllers/auth.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";


export const authRoutes = Router();

authRoutes.get("/me",              authenticate, getMe);
authRoutes.patch("/role/:userId",  authenticate, authorize("admin"), updateRole);
authRoutes.post("/complete-profile", authenticate, completeProfile);