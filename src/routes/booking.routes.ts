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
bookingRoutes.get("/services",     b.listPublicServices);
bookingRoutes.get("/closed-days",  b.listClosedDays);
bookingRoutes.post("/waitlist",    rateLimit({ windowMs: 15 * 60_000, max: 8 }), b.joinWaitlist);
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

bookingRoutes.get("/staff/worklist",                  ...front, b.staffWorklist);
bookingRoutes.post("/staff/bookings/:id/check-in",    ...front, b.staffCheckIn);
bookingRoutes.post("/staff/bookings/:id/calls",       ...front, b.staffCall);
bookingRoutes.get("/staff/bookings/:id/calls",        ...front, b.staffCallHistory);
bookingRoutes.post("/staff/bookings/:id/request-change", authenticate, authorize("doctor"), b.doctorRequestChange);
bookingRoutes.post("/staff/request-day-off",          authenticate, authorize("doctor"), b.doctorRequestDayOff);
bookingRoutes.get("/staff/reports/no-shows",          ...admin, b.noShowReport);

bookingRoutes.get("/staff/slots",                      ...front, b.staffSlots);
bookingRoutes.get("/staff/waitlist",                   ...front, b.staffWaitlist);
bookingRoutes.post("/staff/waitlist/:id/call",         ...front, b.staffWaitlistCall);
bookingRoutes.post("/staff/waitlist/:id/book",         ...front, b.staffWaitlistBook);
bookingRoutes.post("/staff/waitlist/:id/remove",       ...front, b.staffWaitlistRemove);
bookingRoutes.post("/staff/closed-days",               ...front, b.addClosedDay);
bookingRoutes.delete("/staff/closed-days/:id",         ...front, b.removeClosedDay);
bookingRoutes.get("/staff/services",                   ...desk,  b.adminListServices);
bookingRoutes.post("/staff/services",                  ...admin, b.adminSaveService);
bookingRoutes.put("/staff/services/:id",               ...admin, b.adminSaveService);
bookingRoutes.delete("/staff/services/:id",            ...admin, b.adminDeleteService);
bookingRoutes.get("/staff/export/bookings",            ...admin, b.exportBookings);

// A doctor's own calendar: hours, and blocking time they can't work.
const doctorOnly = [authenticate, authorize("doctor")];
bookingRoutes.get("/staff/my/calendar",         ...doctorOnly, b.myCalendar);
bookingRoutes.put("/staff/my/hours",            ...doctorOnly, b.mySaveHours);
bookingRoutes.post("/staff/my/time-off",        ...doctorOnly, b.myAddTimeOff);
bookingRoutes.delete("/staff/my/time-off/:id",  ...doctorOnly, b.myDeleteTimeOff);

bookingRoutes.get("/staff/time-off",        ...desk,  b.listTimeOff);
bookingRoutes.post("/staff/time-off",       ...front, b.addTimeOff);
bookingRoutes.delete("/staff/time-off/:id", ...front, b.deleteTimeOff);

bookingRoutes.get("/staff/settings", ...desk,  b.getBookingSettings);
bookingRoutes.put("/staff/settings", ...admin, b.putBookingSettings);
