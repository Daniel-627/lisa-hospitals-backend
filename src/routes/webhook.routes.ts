import { Router } from "express";
import { clerkWebhook } from "../controllers/webhook.controller";

export const webhookRoutes = Router();

// The raw body parser is applied in src/index.ts (app.use("/api/webhook", express.raw(...), webhookRoutes)).
webhookRoutes.post("/clerk", clerkWebhook);
