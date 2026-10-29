import { Request, Response } from "express";
import crypto from "crypto";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, bookings, bookingOtps, doctorTimeOff, doctors, staff, departments, users } from "../db";
import type { ClerkRequest } from "../middleware/clerk.middleware";
import { sendError, sendSuccess } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { audit } from "../utils/audit";
import { dateStr, isUuid, normalizeKenyanPhone, timeStr, todayEAT, uuid } from "../utils/validation";
import { sendSms, smsConfigured } from "../utils/sms";
import * as svc from "../services/booking.service";

const MAX_RANGE_DAYS = 62;
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;

const siteUrl = () =>
  (process.env.BOOKING_PUBLIC_URL || (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0]).trim().replace(/\/$/, "");
const manageUrl = (ref: string, token: string) => `${siteUrl()}/booking/manage?ref=${ref}&t=${token}`;
const docName = (b: { doctorFirstName: string; doctorLastName: string }) => `Dr. ${b.doctorFirstName} ${b.doctorLastName}`;
const maskPhone = (p: string) => p.slice(0, 7) + "•••" + p.slice(-2);
const prettyDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

// What a guest is allowed to see about their own booking.
const guestView = (b: any) => ({
  reference: b.reference, status: b.status, date: b.slotDate, time: svc.hhmm(b.slotTime), durationMin: b.durationMin,
  guestName: b.guestName, phoneMasked: maskPhone(b.guestPhone), doctor: docName(b), doctorId: b.doctorId,
  department: b.department, departmentId: b.departmentId, speciality: b.speciality,
  rescheduleCount: b.rescheduleCount, cancelledBy: b.cancelledBy,
});

// ── OTP ──────────────────────────────────────────────────────────────────────
const hashOtp = (code: string, phone: string) =>
  crypto.createHash("sha256").update(`${code}:${phone}:${process.env.OTP_PEPPER || process.env.CLERK_SECRET_KEY || "lisa"}`).digest("hex");

async function verifyOtp(phone: string, code: string | undefined): Promise<string> {
  if (!code || !/^\d{6}$/.test(code)) throw new HttpError(422, "Enter the 6-digit code we sent to your phone");
  const [otp] = await db.select().from(bookingOtps)
    .where(and(eq(bookingOtps.phone, phone), sql`${bookingOtps.usedAt} is null`, gte(bookingOtps.expiresAt, new Date())))
    .orderBy(desc(bookingOtps.createdAt)).limit(1);
  if (!otp) throw new HttpError(422, "That code has expired. Please request a new one.");
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "Too many wrong attempts. Please request a new code.");
  if (otp.codeHash !== hashOtp(code, phone)) {
    await db.update(bookingOtps).set({ attempts: otp.attempts + 1 }).where(eq(bookingOtps.id, otp.id));
    throw new HttpError(422, "That code isn't right. Please try again.");
  }
  return otp.id;
}

// ── public: discovery ────────────────────────────────────────────────────────
export const getConfig = async (_req: Request, res: Response) => {
  try {
    const s = await svc.getSettings();
    return sendSuccess(res, {
      smsVerification: smsConfigured(),
      horizonDays: s.horizonDays, cutoffHours: s.cutoffHours, leadMinutes: s.leadMinutes,
      today: todayEAT(),
    });
  } catch (err) { return handleError(res, err, "booking.getConfig"); }
};

export const listDoctors = async (req: Request, res: Response) => {
  try {
    const departmentId = isUuid(req.query.departmentId) ? String(req.query.departmentId) : undefined;
    return sendSuccess(res, await svc.bookableDoctors({ departmentId }));
  } catch (err) { return handleError(res, err, "booking.listDoctors"); }
};

const rangeSchema = z.object({
  departmentId: uuid, doctorId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional(),
});

/** Calendar view: for each day, how many free slots exist. */
export const availability = async (req: Request, res: Response) => {
  try {
    const p = rangeSchema.safeParse(req.query);
    if (!p.success) return sendError(res, "Choose a department first", 422);
    const from = p.data.from && p.data.from > todayEAT() ? p.data.from : todayEAT();
    const to = p.data.to && p.data.to >= from ? p.data.to : svc.addDays(from, 30);
    if (svc.addDays(from, MAX_RANGE_DAYS) < to) return sendError(res, "Date range too large", 422);

    const pool = await svc.bookableDoctors({ departmentId: p.data.departmentId, doctorId: p.data.doctorId });
    const slots = await svc.freeSlots(pool.map((d) => d.id), from, to);
    const days: Record<string, number> = {};
    slots.forEach((s) => { days[s.date] = (days[s.date] ?? 0) + 1; });
    return sendSuccess(res, { from, to, days });
  } catch (err) { return handleError(res, err, "booking.availability"); }
};

/** Times on one day. With no doctor picked, each time lists the doctors free at it. */
export const slots = async (req: Request, res: Response) => {
  try {
    const p = z.object({ departmentId: uuid, doctorId: uuid.optional(), date: dateStr }).safeParse(req.query);
    if (!p.success) return sendError(res, "Choose a department and date", 422);
    const pool = await svc.bookableDoctors({ departmentId: p.data.departmentId, doctorId: p.data.doctorId });
    const free = await svc.freeSlots(pool.map((d) => d.id), p.data.date, p.data.date);
    const byTime = new Map<string, { time: string; doctors: { id: string; name: string }[] }>();
    for (const s of free) {
      const d = pool.find((x) => x.id === s.doctorId)!;
      const entry = byTime.get(s.time) ?? { time: s.time, doctors: [] };
      entry.doctors.push({ id: d.id, name: `Dr. ${d.firstName} ${d.lastName}` });
      byTime.set(s.time, entry);
    }
    return sendSuccess(res, [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)));
  } catch (err) { return handleError(res, err, "booking.slots"); }
};

// ── public: phone verification + booking ─────────────────────────────────────
export const requestOtp = async (req: Request, res: Response) => {
  try {
    const p = z.object({ phone: z.string().min(9).max(20) }).safeParse(req.body);
    const phone = p.success ? normalizeKenyanPhone(p.data.phone) : null;
    if (!phone) return sendError(res, "Enter a valid Kenyan phone number", 422);
    if (!smsConfigured()) return sendSuccess(res, { sent: false, required: false });

    const since = new Date(Date.now() - 10 * 60_000);
    const [{ n }]: any = await db.select({ n: sql<number>`count(*)::int` }).from(bookingOtps)
      .where(and(eq(bookingOtps.phone, phone), gte(bookingOtps.createdAt, since)));
    if (n >= 3) return sendError(res, "We've already sent codes to this number. Please wait a few minutes.", 429);

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await db.insert(bookingOtps).values({ phone, codeHash: hashOtp(code, phone), expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000) });
    const ok = await sendSms(phone, `Lisa Hospitals: your booking code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`);
    if (!ok) return sendError(res, "We couldn't send the SMS. Please check the number and try again.", 502);
    return sendSuccess(res, { sent: true, required: true });
  } catch (err) { return handleError(res, err, "booking.requestOtp"); }
};

export const createGuestBooking = async (req: Request, res: Response) => {
  try {
    // Honeypot: real people never fill the hidden "website" field.
    if (req.body?.website) return sendSuccess(res, { ok: true });
    const parsed = svc.createBookingSchema.extend({ otp: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const phone = normalizeKenyanPhone(parsed.data.guestPhone);
    if (!phone) return sendError(res, "Enter a valid Kenyan phone number", 422);

    const verifying = smsConfigured();
    const otpId = verifying ? await verifyOtp(phone, parsed.data.otp) : null;

    const { booking, manageToken, doctor } = await svc.createBooking(parsed.data, { kind: "guest" }, { phoneVerified: verifying });
    if (otpId) await db.update(bookingOtps).set({ usedAt: new Date() }).where(eq(bookingOtps.id, otpId));

    const link = manageUrl(booking.reference, manageToken);
    void sendSms(phone, `Lisa Hospitals: ${booking.status === "confirmed" ? "booked" : "request received"} ${prettyDate(booking.slotDate)} ${svc.hhmm(booking.slotTime)} with Dr. ${doctor.lastName}. Ref ${booking.reference}. Change or cancel: ${link}`);

    return sendSuccess(res, {
      reference: booking.reference, status: booking.status, date: booking.slotDate, time: svc.hhmm(booking.slotTime),
      doctor: `Dr. ${doctor.firstName} ${doctor.lastName}`, department: doctor.department,
      manageToken, manageUrl: link,
    }, booking.status === "confirmed" ? "Appointment booked" : "Request received", 201);
  } catch (err) { return handleError(res, err, "booking.createGuest"); }
};

// ── public: manage (cancel / reschedule) ─────────────────────────────────────
const proofSchema = z.object({
  reference: z.string().min(4).max(12),
  token: z.string().max(100).optional(),
  phone: z.string().max(20).optional(),
});

async function guestBooking(body: unknown) {
  const p = proofSchema.safeParse(body);
  if (!p.success) throw new HttpError(422, "Enter your booking reference and phone number");
  const b = await svc.findForGuest(p.data.reference, { token: p.data.token, phone: p.data.phone });
  // Same message whether the reference or the proof was wrong, so references can't be probed.
  if (!b) throw new HttpError(404, "We couldn't find a booking with those details");
  return b;
}

export const manageLookup = async (req: Request, res: Response) => {
  try { return sendSuccess(res, guestView(await guestBooking(req.body))); }
  catch (err) { return handleError(res, err, "booking.manageLookup"); }
};

export const manageCancel = async (req: Request, res: Response) => {
  try {
    const b = await guestBooking(req.body);
    const row = await svc.cancelBooking(b.id, "patient", "Cancelled by patient");
    return sendSuccess(res, { reference: b.reference, status: row.status }, "Appointment cancelled");
  } catch (err) { return handleError(res, err, "booking.manageCancel"); }
};

export const manageReschedule = async (req: Request, res: Response) => {
  try {
    const b = await guestBooking(req.body);
    const t = z.object({ date: dateStr, time: timeStr }).safeParse(req.body);
    if (!t.success) return sendError(res, "Choose a new date and time", 422);
    const settings = await svc.getSettings();
    if (t.data.date > svc.addDays(todayEAT(), settings.horizonDays)) return sendError(res, "That date is too far ahead", 422);
    const { after } = await svc.rescheduleBooking(b.id, t.data as any, "patient");
    const fresh = await svc.findBookingById(after.id);
    void sendSms(after.guestPhone, `Lisa Hospitals: your appointment is now ${prettyDate(after.slotDate)} ${svc.hhmm(after.slotTime)} with ${docName(fresh!)}. Ref ${after.reference}.`);
    return sendSuccess(res, guestView(fresh), "Appointment rescheduled");
  } catch (err) { return handleError(res, err, "booking.manageReschedule"); }
};

// ── staff: desk ──────────────────────────────────────────────────────────────
async function myDoctorId(req: ClerkRequest): Promise<string | null> {
  const [row] = await db.select({ id: doctors.id }).from(doctors)
    .innerJoin(staff, eq(doctors.staffId, staff.id)).where(eq(staff.userId, req.clerkUser!.dbUserId)).limit(1);
  return row?.id ?? null;
}

// Doctors see who is coming and when — no contact details, no reason.
const staffView = (b: any, role: string) => {
  const base = { ...b, doctorName: docName(b) };
  if (role === "doctor") { delete base.guestPhone; delete base.guestEmail; delete base.reason; }
  return base;
};

export const staffList = async (req: ClerkRequest, res: Response) => {
  try {
    const role = req.clerkUser!.role;
    const q = z.object({
      from: dateStr.optional(), to: dateStr.optional(), date: dateStr.optional(),
      doctorId: uuid.optional(), departmentId: uuid.optional(),
      status: z.enum(["pending", "confirmed", "completed", "cancelled", "no_show"]).optional(),
      q: z.string().max(60).optional(),
    }).safeParse(req.query);
    if (!q.success) return sendError(res, "Invalid filters", 422);

    const from = q.data.date ?? q.data.from ?? todayEAT();
    const to = q.data.date ?? q.data.to ?? from;
    if (svc.addDays(from, 92) < to) return sendError(res, "Date range too large", 422);

    const conds: any[] = [gte(bookings.slotDate, from), lte(bookings.slotDate, to)];
    if (role === "doctor") {
      const mine = await myDoctorId(req);
      if (!mine) return sendSuccess(res, []);
      conds.push(eq(bookings.doctorId, mine));
    } else if (q.data.doctorId) conds.push(eq(bookings.doctorId, q.data.doctorId));
    if (q.data.departmentId) conds.push(eq(bookings.departmentId, q.data.departmentId));
    if (q.data.status) conds.push(eq(bookings.status, q.data.status));
    if (q.data.q && role !== "doctor") {
      const like = `%${q.data.q.replace(/[%_]/g, "")}%`;
      conds.push(or(ilike(bookings.guestName, like), ilike(bookings.guestPhone, like), ilike(bookings.reference, like)));
    }
    const rows = await svc.bookingQuery().where(and(...conds)).orderBy(asc(bookings.slotDate), asc(bookings.slotTime)).limit(1000);
    return sendSuccess(res, rows.map((r) => staffView(r, role)));
  } catch (err) { return handleError(res, err, "booking.staffList"); }
};

export const staffCreate = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = svc.createBookingSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const { booking, doctor } = await svc.createBooking(parsed.data, { kind: "staff", userId: req.clerkUser!.dbUserId }, { phoneVerified: false });
    await audit(req, "booking.created", "bookings", booking.id, null, { date: booking.slotDate, time: booking.slotTime, doctorId: booking.doctorId });
    void sendSms(booking.guestPhone, `Lisa Hospitals: booked ${prettyDate(booking.slotDate)} ${svc.hhmm(booking.slotTime)} with Dr. ${doctor.lastName}. Ref ${booking.reference}.`);
    return sendSuccess(res, await svc.findBookingById(booking.id), "Appointment booked", 201);
  } catch (err) { return handleError(res, err, "booking.staffCreate"); }
};

export const staffSetStatus = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ status: z.enum(["confirmed", "completed", "no_show", "cancelled"]), reason: z.string().max(200).optional() }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Invalid request", 422);
    const before = await svc.findBookingById(id);
    if (!before) return sendError(res, "Booking not found", 404);
    const row = await svc.setBookingStatus(id, p.data.status, p.data.reason);
    await audit(req, `booking.${p.data.status}`, "bookings", id, { status: before.status }, { status: row.status });
    if (p.data.status === "cancelled" && before.status !== "cancelled") {
      void sendSms(row.guestPhone, `Lisa Hospitals: your appointment on ${prettyDate(row.slotDate)} ${svc.hhmm(row.slotTime)} was cancelled. Please call us or rebook online. Ref ${row.reference}.`);
    }
    return sendSuccess(res, await svc.findBookingById(id), "Updated");
  } catch (err) { return handleError(res, err, "booking.staffSetStatus"); }
};

export const staffReschedule = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ date: dateStr, time: timeStr, doctorId: uuid.optional() }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Invalid request", 422);
    const { before, after } = await svc.rescheduleBooking(id, p.data as any, "staff");
    await audit(req, "booking.rescheduled", "bookings", id,
      { date: before.slotDate, time: svc.hhmm(before.slotTime), doctorId: before.doctorId },
      { date: after.slotDate, time: svc.hhmm(after.slotTime), doctorId: after.doctorId });
    const fresh = await svc.findBookingById(id);
    void sendSms(after.guestPhone, `Lisa Hospitals: your appointment has been moved to ${prettyDate(after.slotDate)} ${svc.hhmm(after.slotTime)} with ${docName(fresh!)}. Ref ${after.reference}.`);
    return sendSuccess(res, fresh, "Appointment moved");
  } catch (err) { return handleError(res, err, "booking.staffReschedule"); }
};

// ── staff: leave / time off ──────────────────────────────────────────────────
const timeOffSchema = z.object({ doctorId: uuid, startDate: dateStr, endDate: dateStr, reason: z.string().max(200).optional() })
  .refine((v) => v.endDate >= v.startDate, "End date must be on or after the start date");

export const listTimeOff = async (req: Request, res: Response) => {
  try {
    const doctorId = isUuid(req.query.doctorId) ? String(req.query.doctorId) : undefined;
    const rows = await db.select().from(doctorTimeOff)
      .where(and(gte(doctorTimeOff.endDate, todayEAT()), doctorId ? eq(doctorTimeOff.doctorId, doctorId) : undefined))
      .orderBy(asc(doctorTimeOff.startDate));
    return sendSuccess(res, rows);
  } catch (err) { return handleError(res, err, "booking.listTimeOff"); }
};

export const addTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const p = timeOffSchema.safeParse(req.body);
    if (!p.success) return sendError(res, p.error.issues[0].message, 422);
    const [doc] = await db.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, p.data.doctorId)).limit(1);
    if (!doc) return sendError(res, "Doctor not found", 404);
    const [row] = await db.insert(doctorTimeOff).values({ ...(p.data as any), createdBy: req.clerkUser!.dbUserId }).returning();
    await audit(req, "booking.time_off_added", "doctor_time_off", row.id, null, p.data);
    // Existing bookings aren't silently cancelled: reception gets the list to move or call.
    const affected = (await svc.bookingsInRange(p.data.doctorId, p.data.startDate, p.data.endDate)).map((b) => staffView(b, "receptionist"));
    return sendSuccess(res, { timeOff: row, affectedBookings: affected }, "Time off saved", 201);
  } catch (err) { return handleError(res, err, "booking.addTimeOff"); }
};

export const deleteTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Not found", 404);
    const [row] = await db.delete(doctorTimeOff).where(eq(doctorTimeOff.id, id)).returning();
    if (!row) return sendError(res, "Not found", 404);
    await audit(req, "booking.time_off_removed", "doctor_time_off", id, row, null);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.deleteTimeOff"); }
};

// ── admin: settings ──────────────────────────────────────────────────────────
export const getBookingSettings = async (_req: Request, res: Response) => {
  try { return sendSuccess(res, await svc.getSettings()); }
  catch (err) { return handleError(res, err, "booking.getSettings"); }
};

export const putBookingSettings = async (req: ClerkRequest, res: Response) => {
  try {
    const p = svc.settingsSchema.safeParse(req.body);
    if (!p.success || Object.keys(p.data).length === 0) return sendError(res, "Invalid settings", 422);
    const row = await svc.updateSettings(p.data);
    await audit(req, "booking.settings_updated", "booking_settings", null, null, p.data);
    return sendSuccess(res, row, "Settings saved");
  } catch (err) { return handleError(res, err, "booking.putSettings"); }
};
