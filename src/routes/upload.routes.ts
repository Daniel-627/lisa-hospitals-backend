import { Response, Router } from "express";
import { authenticate, ClerkRequest } from "../middleware/clerk.middleware";
import { rateLimit } from "../utils/rateLimit";
import { sendError, sendSuccess } from "../utils/response";
import { handleError } from "../utils/errors";
import { UPLOAD_PURPOSES, cloudinaryConfigured, purposeSchema, signUpload } from "../utils/cloudinary";
import { audit } from "../utils/audit";
import { clinicalEnabled } from "../middleware/features";

export const uploadRoutes = Router();

// The browser asks for permission to upload one file for a named purpose. The server decides the folder, the file
// types and whether the file is public or private. Nothing here receives the file itself.
uploadRoutes.post("/sign", authenticate, rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req: ClerkRequest, res: Response) => {
  try {
    if (!cloudinaryConfigured()) return sendError(res, "File upload isn't set up yet.", 503);
    const parsed = purposeSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Unknown upload type", 422);
    const purpose = parsed.data.purpose;
    // Booking-only mode: just the public images (doctor photos, news covers). Private clinical files stay off.
    if (!clinicalEnabled() && UPLOAD_PURPOSES[purpose].access !== "public") return sendError(res, "This feature is not enabled", 404);
    if (!(UPLOAD_PURPOSES[purpose].roles as readonly string[]).includes(req.clerkUser!.role)) return sendError(res, "Access denied", 403);
    const out = signUpload(purpose);
    await audit(req, "upload.signed", "uploads", null, null, { purpose, access: out.access });
    return sendSuccess(res, out);
  } catch (err) {
    return handleError(res, err, "signUpload");
  }
});
