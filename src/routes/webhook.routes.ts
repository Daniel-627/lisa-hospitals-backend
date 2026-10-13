import { Router } from "express";
import { clerkWebhook } from "../controllers/webhook.controller";
import { paystackWebhook } from "../controllers/paystack.controller";

export const webhookRoutes = Router();

// The raw body parser is applied in src/index.ts (app.use("/api/webhook", express.raw(...), webhookRoutes)).
webhookRoutes.post("/clerk", clerkWebhook);
// Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL: https://<render-url>/api/webhook/paystack
webhookRoutes.post("/paystack", paystackWebhook);
