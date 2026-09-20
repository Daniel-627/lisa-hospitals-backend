import { Router } from "express";
import { clerkWebhook } from "../controllers/webhook.controller";

export const webhookRoutes = Router();

webhookRoutes.post("/clerk", clerkWebhook);