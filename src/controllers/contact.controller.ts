import { Request, Response } from "express";
import { z } from "zod";
import { db, enquiries } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { handleError } from "../utils/errors";
import { normalizeKenyanPhone } from "../utils/validation";

const enquirySchema = z.object({
  name:    z.string().trim().min(2, "Please enter your name").max(100),
  email:   z.string().trim().email("Enter a valid email address").max(255),
  phone:   z.string().trim().max(30).optional(),
  subject: z.string().trim().min(3, "Please add a subject").max(150),
  message: z.string().trim().min(10, "Your message is a bit short").max(2000),
});

const THANKS = "Thank you — we'll get back to you soon.";

export const submitEnquiry = async (req: Request, res: Response) => {
  try {
    // Honeypot: real visitors never see/fill this hidden field, bots usually do. Pretend success, store nothing.
    if (typeof req.body?.website === "string" && req.body.website.trim() !== "") {
      return sendSuccess(res, null, THANKS, 201);
    }

    const parsed = enquirySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    let phone: string | undefined;
    if (parsed.data.phone) {
      const normalized = normalizeKenyanPhone(parsed.data.phone);
      if (!normalized) return sendError(res, "Enter a valid Kenyan phone number, or leave it blank", 422);
      phone = normalized;
    }

    await db.insert(enquiries).values({
      name:    parsed.data.name,
      email:   parsed.data.email,
      phone,
      subject: parsed.data.subject,
      message: parsed.data.message,
    });

    return sendSuccess(res, null, THANKS, 201);
  } catch (err) {
    return handleError(res, err, "submitEnquiry");
  }
};
