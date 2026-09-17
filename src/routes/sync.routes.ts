import { Router } from "express";
import { pushSync, pullSync } from "../controllers/sync.controller";
import { authenticate } from "../middleware/auth.middleware";

export const syncRoutes = Router();

syncRoutes.post("/push", authenticate, pushSync);
syncRoutes.get("/pull",  authenticate, pullSync);