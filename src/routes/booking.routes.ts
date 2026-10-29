import { Router } from "express";
import { authenticate, authorize } from "../middleware/clerk.middleware";
import { rateLimit } from "../utils/rateLimit";
import * as b from "../controllers/booking.controller";

export const bookingRoutes = Router();

// ── Public (no sign-up) ──────────────────────────────────────────────────────
bookingRoutes.get("/config",       b.getConfig);
bookingRoutes.get("/doctors",      b.listDoctors);
bookingRoutes.get("/availability", rateLimit({ windowMs: 60_000, max: 90 }), b.availability);
bookingRoutes.get("/slots",        rateLimit({ windowMs: 60_000, max: 90 }), b.slots);
bookingRoutes.post("/otp",         rateLimit({ windowMs: 15 * 60_000, max: 8 }),  b.requestOtp);
bookingRoutes.post("/bookings",    rateLimit({ windowMs: 15 * 60_000, max: 12 }), b.createGuestBooking);

// Manage with reference + (link token | phone). Tight limit: this is the only thing guessing could target.
const manageLimit = rateLimit({ windowMs: 15 * 60_000, max: 25 });
bookingRoutes.post("/manage/lookup",     manageLimit, b.manageLookup);
bookingRoutes.post("/manage/cancel",     manageLimit, b.manageCancel);
bookingRoutes.post("/manage/reschedule", manageLimit, b.manageReschedule);

// ── Staff desk ───────────────────────────────────────────────────────────────
const desk   = [authenticate, authorize("admin", "receptionist", "doctor")];
const front  = [authenticate, authorize("admin", "receptionist")];
const admin  = [authenticate, authorize("admin")];

bookingRoutes.get("/staff/bookings",                  ...desk,  b.staffList);
bookingRoutes.post("/staff/bookings",                 ...front, b.staffCreate);
bookingRoutes.patch("/staff/bookings/:id/status",     ...front, b.staffSetStatus);
bookingRoutes.post("/staff/bookings/:id/reschedule",  ...front, b.staffReschedule);

bookingRoutes.get("/staff/time-off",        ...desk,  b.listTimeOff);
bookingRoutes.post("/staff/time-off",       ...front, b.addTimeOff);
bookingRoutes.delete("/staff/time-off/:id", ...front, b.deleteTimeOff);

bookingRoutes.get("/staff/settings", ...desk,  b.getBookingSettings);
bookingRoutes.put("/staff/settings", ...admin, b.putBookingSettings);
