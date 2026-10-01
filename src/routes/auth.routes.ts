import { Router } from "express";
import { getMe, updateRole, completeProfile } from "../controllers/auth.controller";
import { authenticate, authenticateClerk, authorize } from "../middleware/clerk.middleware";

export const authRoutes = Router();

authRoutes.get("/me",                authenticate, getMe);
authRoutes.patch("/role/:userId",    authenticate, authorize("admin"), updateRole);
// authenticateClerk (not authenticate): the user may not exist in our DB yet.
authRoutes.post("/complete-profile", authenticateClerk, completeProfile);
