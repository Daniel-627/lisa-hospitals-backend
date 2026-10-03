import { Router } from "express";
import { submitEnquiry } from "../controllers/contact.controller";
import { rateLimit } from "../utils/rateLimit";

export const contactRoutes = Router();

// Public — limited to 5 messages per hour per visitor
contactRoutes.post("/", rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }), submitEnquiry);
