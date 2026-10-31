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
import { asLang, smsText, whenText } from "../utils/smsText";
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
  rescheduleCount: b.rescheduleCount, cancelledBy: b.cancelledBy, service: b.service, serviceSw: b.serviceSw, serviceId: b.serviceId, lang: b.lang,
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
  departmentId: uuid, doctorId: uuid.optional(), serviceId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional(),
});

/** Calendar view: for each day, how many free slots exist. */
export const availability = async (req: Request, res: Response) => {
  try {
    const p = rangeSchema.safeParse(req.query);
    if (!p.success) return sendError(res, "Choose a department first", 422);
    const from = p.data.from && p.data.from > todayEAT() ? p.data.from : todayEAT();
    const to = p.data.to && p.data.to >= from ? p.data.to : svc.addDays(from, 30);
    if (svc.addDays(from, MAX_RANGE_DAYS) < to) return sendError(res, "Date range too large", 422);

    const { pool, service } = await svc.poolFor({ departmentId: p.data.departmentId, doctorId: p.data.doctorId, serviceId: p.data.serviceId });
    const slots = await svc.freeSlots(pool.map((d) => d.id), from, to, { durationMin: service?.durationMin });
    const days: Record<string, number> = {};
    slots.forEach((s) => { days[s.date] = (days[s.date] ?? 0) + 1; });
    return sendSuccess(res, { from, to, days });
  } catch (err) { return handleError(res, err, "booking.availability"); }
};

const slotList = async (q: { departmentId: string; doctorId?: string; serviceId?: string; date: string }, staffView: boolean) => {
  const { pool, service } = await svc.poolFor({ departmentId: q.departmentId, doctorId: q.doctorId, serviceId: q.serviceId });
  const free = await svc.freeSlots(pool.map((d) => d.id), q.date, q.date, { ignoreRules: staffView, durationMin: service?.durationMin });
  const byTime = new Map<string, { time: string; held?: boolean; doctors: { id: string; name: string }[] }>();
  for (const s of free) {
    const d = pool.find((x) => x.id === s.doctorId)!;
    const entry = byTime.get(s.time) ?? { time: s.time, doctors: [] };
    entry.doctors.push({ id: d.id, name: `Dr. ${d.firstName} ${d.lastName}` });
    if (s.held) entry.held = true; // held back for walk-ins (reception only)
    byTime.set(s.time, entry);
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
};
const slotQuery = z.object({ departmentId: uuid, doctorId: uuid.optional(), serviceId: uuid.optional(), date: dateStr });

/** Times on one day. With no doctor picked, each time lists the doctors free at it. */
export const slots = async (req: Request, res: Response) => {
  try {
    const p = slotQuery.safeParse(req.query);
    if (!p.success) return sendError(res, "Choose a department and date", 422);
    return sendSuccess(res, await slotList(p.data as any, false));
  } catch (err) { return handleError(res, err, "booking.slots"); }
};

/** Reception's view: also shows walk-in held slots, ignores notice period and holidays. */
export const staffSlots = async (req: Request, res: Response) => {
  try {
    const p = slotQuery.safeParse(req.query);
    if (!p.success) return sendError(res, "Choose a department and date", 422);
    return sendSuccess(res, await slotList(p.data as any, true));
  } catch (err) { return handleError(res, err, "booking.staffSlots"); }
};

export const listPublicServices = async (req: Request, res: Response) => {
  try {
    const departmentId = isUuid(req.query.departmentId) ? String(req.query.departmentId) : undefined;
    const rows = await svc.listServices({ departmentId, activeOnly: true });
    return sendSuccess(res, rows.map((r) => ({ id: r.id, departmentId: r.departmentId, name: r.name, nameSw: r.nameSw, durationMin: r.durationMin, doctorIds: r.doctorIds })));
  } catch (err) { return handleError(res, err, "booking.listServices"); }
};

export const listClosedDays = async (_req: Request, res: Response) => {
  try { return sendSuccess(res, (await svc.listHolidays()).map((h) => ({ date: h.date, name: h.name }))); }
  catch (err) { return handleError(res, err, "booking.listClosedDays"); }
};

// ── public: phone verification + booking ─────────────────────────────────────
export const requestOtp = async (req: Request, res: Response) => {
  try {
    const p = z.object({ phone: z.string().min(9).max(20), lang: z.enum(["en", "sw"]).optional() }).safeParse(req.body);
    const phone = p.success ? normalizeKenyanPhone(p.data.phone) : null;
    if (!phone) return sendError(res, "Enter a valid Kenyan phone number", 422);
    if (!smsConfigured()) return sendSuccess(res, { sent: false, required: false });

    const since = new Date(Date.now() - 10 * 60_000);
    const [{ n }]: any = await db.select({ n: sql<number>`count(*)::int` }).from(bookingOtps)
      .where(and(eq(bookingOtps.phone, phone), gte(bookingOtps.createdAt, since)));
    if (n >= 3) return sendError(res, "We've already sent codes to this number. Please wait a few minutes.", 429);

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await db.insert(bookingOtps).values({ phone, codeHash: hashOtp(code, phone), expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000) });
    const ok = await sendSms(phone, smsText("otp", p.data!.lang, { code, mins: OTP_TTL_MIN }));
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
    void sendSms(phone, smsText("booked", booking.lang, { firm: booking.status === "confirmed" ? 1 : 0, when: whenText(booking.slotDate, booking.slotTime, booking.lang), doctor: `Dr. ${doctor.lastName}`, ref: booking.reference, link }));

    return sendSuccess(res, {
      reference: booking.reference, status: booking.status, date: booking.slotDate, time: svc.hhmm(booking.slotTime),
      doctor: `Dr. ${doctor.firstName} ${doctor.lastName}`, department: doctor.department,
      manageToken, manageUrl: link,
    }, booking.status === "confirmed" ? "Appointment booked" : "Request received", 201);
  } catch (err) { return handleError(res, err, "booking.createGuest"); }
};

export const joinWaitlist = async (req: Request, res: Response) => {
  try {
    if (req.body?.website) return sendSuccess(res, { ok: true });
    const parsed = svc.waitlistSchema.extend({ otp: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const phone = normalizeKenyanPhone(parsed.data.guestPhone);
    if (!phone) return sendError(res, "Enter a valid Kenyan phone number", 422);
    const verifying = smsConfigured();
    const otpId = verifying ? await verifyOtp(phone, parsed.data.otp) : null;
    await svc.joinWaitlist(parsed.data as any, verifying);
    if (otpId) await db.update(bookingOtps).set({ usedAt: new Date() }).where(eq(bookingOtps.id, otpId));
    return sendSuccess(res, { ok: true }, "You're on the waiting list", 201);
  } catch (err) { return handleError(res, err, "booking.joinWaitlist"); }
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
    void sendSms(after.guestPhone, smsText("moved", after.lang, { when: whenText(after.slotDate, after.slotTime, after.lang), doctor: docName(fresh!), ref: after.reference }));
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
    void sendSms(booking.guestPhone, smsText("booked", booking.lang, { firm: 1, when: whenText(booking.slotDate, booking.slotTime, booking.lang), doctor: `Dr. ${doctor.lastName}`, ref: booking.reference }));
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
    if (p.data.status === "no_show" && before.status !== "no_show") {
      void sendSms(row.guestPhone, smsText("missed", row.lang, { when: whenText(row.slotDate, row.slotTime, row.lang), link: `${siteUrl()}/book`, phone: "0784 388 734" }));
    }
    if (p.data.status === "cancelled" && before.status !== "cancelled") {
      void sendSms(row.guestPhone, smsText("cancelled", row.lang, { when: whenText(row.slotDate, row.slotTime, row.lang), ref: row.reference }));
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
    void sendSms(after.guestPhone, smsText("moved", after.lang, { when: whenText(after.slotDate, after.slotTime, after.lang), doctor: docName(fresh!), ref: after.reference }));
    return sendSuccess(res, fresh, "Appointment moved");
  } catch (err) { return handleError(res, err, "booking.staffReschedule"); }
};

// ── staff: leave / time off ──────────────────────────────────────────────────
export const listTimeOff = async (req: Request, res: Response) => {
  try {
    const doctorId = isUuid(req.query.doctorId) ? String(req.query.doctorId) : undefined;
    const rows = await db.select().from(doctorTimeOff)
      .where(and(gte(doctorTimeOff.endDate, todayEAT()), doctorId ? eq(doctorTimeOff.doctorId, doctorId) : undefined))
      .orderBy(asc(doctorTimeOff.startDate));
    return sendSuccess(res, rows);
  } catch (err) { return handleError(res, err, "booking.listTimeOff"); }
};

const timeOffResult = (r: { timeOff: any; affected: any[] }) => ({ timeOff: r.timeOff, affectedBookings: r.affected.map((b) => staffView(b, "receptionist")) });

export const addTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const p = svc.timeOffSchema.safeParse(req.body);
    if (!p.success) return sendError(res, p.error.issues[0].message, 422);
    const r = await svc.addTimeOff(p.data as any, req.clerkUser!.dbUserId);
    await audit(req, "booking.time_off_added", "doctor_time_off", r.timeOff.id, null, p.data);
    return sendSuccess(res, timeOffResult(r), "Time off saved", 201);
  } catch (err) { return handleError(res, err, "booking.addTimeOff"); }
};

export const deleteTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Not found", 404);
    const row = await svc.removeTimeOff(id);
    await audit(req, "booking.time_off_removed", "doctor_time_off", id, row, null);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.deleteTimeOff"); }
};

// ── doctor: own calendar ─────────────────────────────────────────────────────
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const myCalendar = async (req: ClerkRequest, res: Response) => {
  try {
    const mine = await myDoctorId(req);
    if (!mine) return sendError(res, "No doctor profile found for your account", 403);
    const m = monthSchema.safeParse(req.query.month ?? todayEAT().slice(0, 7));
    if (!m.success) return sendError(res, "Invalid month", 422);
    return sendSuccess(res, { doctorId: mine, ...(await svc.doctorMonth(mine, m.data)) });
  } catch (err) { return handleError(res, err, "booking.myCalendar"); }
};

export const mySaveHours = async (req: ClerkRequest, res: Response) => {
  try {
    const mine = await myDoctorId(req);
    if (!mine) return sendError(res, "No doctor profile found for your account", 403);
    const p = svc.weeklySchema.safeParse(req.body);
    if (!p.success) return sendError(res, p.error.issues[0].message, 422);
    const saved = await svc.saveWeekly(mine, p.data.slots);
    await audit(req, "booking.hours_set_by_doctor", "doctor_availability", mine, null, { blocks: saved.length });
    return sendSuccess(res, saved, "Your hours are saved");
  } catch (err) { return handleError(res, err, "booking.mySaveHours"); }
};

export const myAddTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const mine = await myDoctorId(req);
    if (!mine) return sendError(res, "No doctor profile found for your account", 403);
    const p = svc.timeOffSchema.safeParse({ ...req.body, doctorId: mine });
    if (!p.success) return sendError(res, p.error.issues[0].message, 422);
    const r = await svc.addTimeOff(p.data as any, req.clerkUser!.dbUserId);
    await audit(req, "booking.time_off_added_by_doctor", "doctor_time_off", r.timeOff.id, null, p.data);
    return sendSuccess(res, { timeOff: r.timeOff, affectedCount: r.affected.length }, r.affected.length
      ? `Saved. ${r.affected.length} booked patient(s) fall in that time. Reception has been told to rearrange them.`
      : "Saved. Patients can no longer book that time.", 201);
  } catch (err) { return handleError(res, err, "booking.myAddTimeOff"); }
};

export const myDeleteTimeOff = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const mine = await myDoctorId(req);
    if (!isUuid(id) || !mine) return sendError(res, "Not found", 404);
    const row = await svc.removeTimeOff(id, mine);
    await audit(req, "booking.time_off_removed_by_doctor", "doctor_time_off", id, row, null);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.myDeleteTimeOff"); }
};

// ── admin / reception: closed days ───────────────────────────────────────────
export const addClosedDay = async (req: ClerkRequest, res: Response) => {
  try {
    const p = z.object({ date: dateStr, name: z.string().trim().min(2).max(120) }).safeParse(req.body);
    if (!p.success) return sendError(res, "Choose a day and give it a name", 422);
    const r = await svc.addHoliday(p.data.date, p.data.name, req.clerkUser!.dbUserId);
    await audit(req, "booking.holiday_added", "booking_holidays", r.holiday.id, null, p.data);
    return sendSuccess(res, r, r.flagged ? `Saved. ${r.flagged} existing booking(s) that day need rearranging.` : "Saved", 201);
  } catch (err) { return handleError(res, err, "booking.addClosedDay"); }
};

export const removeClosedDay = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Not found", 404);
    const row = await svc.removeHoliday(id);
    await audit(req, "booking.holiday_removed", "booking_holidays", id, row, null);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.removeClosedDay"); }
};

// ── admin: services ──────────────────────────────────────────────────────────
export const adminListServices = async (_req: Request, res: Response) => {
  try { return sendSuccess(res, await svc.listServices()); }
  catch (err) { return handleError(res, err, "booking.adminListServices"); }
};

export const adminSaveService = async (req: ClerkRequest, res: Response) => {
  try {
    const p = svc.serviceSchema.safeParse(req.body);
    if (!p.success) return sendError(res, p.error.issues[0].message, 422);
    const id = req.params.id;
    if (id && !isUuid(id)) return sendError(res, "Not found", 404);
    const row = await svc.saveService(p.data as any, id);
    await audit(req, id ? "booking.service_updated" : "booking.service_created", "booking_services", row.id, null, { name: row.name, durationMin: row.durationMin });
    return sendSuccess(res, row, "Saved", id ? 200 : 201);
  } catch (err) { return handleError(res, err, "booking.adminSaveService"); }
};

export const adminDeleteService = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Not found", 404);
    const r = await svc.deleteService(id);
    await audit(req, "booking.service_removed", "booking_services", id, null, r);
    return sendSuccess(res, r, r.deactivated ? "Switched off (it has past bookings, so it was kept)" : "Deleted");
  } catch (err) { return handleError(res, err, "booking.adminDeleteService"); }
};

// ── staff: waiting list ──────────────────────────────────────────────────────
export const staffWaitlist = async (_req: Request, res: Response) => {
  try { return sendSuccess(res, await svc.waitlistWithMatches()); }
  catch (err) { return handleError(res, err, "booking.staffWaitlist"); }
};

export const staffWaitlistCall = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ outcome: z.enum(["no_answer", "other"]) }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Invalid request", 422);
    await svc.waitlistCall(id, p.data.outcome);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.waitlistCall"); }
};

export const staffWaitlistBook = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ date: dateStr, time: timeStr, doctorId: uuid.optional() }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Choose a day and time", 422);
    const made = await svc.waitlistBook(id, p.data as any, req.clerkUser!.dbUserId);
    await audit(req, "booking.created_from_waitlist", "bookings", made.booking.id, null, { waitlistId: id });
    void sendSms(made.booking.guestPhone, smsText("booked", made.booking.lang, { firm: 1, when: whenText(made.booking.slotDate, made.booking.slotTime, made.booking.lang), doctor: `Dr. ${made.doctor.lastName}`, ref: made.booking.reference }));
    return sendSuccess(res, await svc.findBookingById(made.booking.id), "Booked from the waiting list", 201);
  } catch (err) { return handleError(res, err, "booking.waitlistBook"); }
};

export const staffWaitlistRemove = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Not found", 404);
    await svc.waitlistRemove(id);
    await audit(req, "booking.waitlist_removed", "booking_waitlist", id, null, null);
    return sendSuccess(res, { id });
  } catch (err) { return handleError(res, err, "booking.waitlistRemove"); }
};

// ── admin: export ────────────────────────────────────────────────────────────
export const exportBookings = async (req: ClerkRequest, res: Response) => {
  try {
    const p = z.object({ from: dateStr, to: dateStr }).safeParse(req.query);
    if (!p.success || p.data.to < p.data.from) return sendError(res, "Choose a start and end date", 422);
    if (svc.addDays(p.data.from, 366) < p.data.to) return sendError(res, "Please export one year at a time", 422);
    const csv = await svc.exportBookingsCsv(p.data.from, p.data.to);
    await audit(req, "booking.exported", "bookings", null, null, { from: p.data.from, to: p.data.to });
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="lisa-bookings-${p.data.from}-to-${p.data.to}.csv"`, "Cache-Control": "no-store" });
    return res.send(csv);
  } catch (err) { return handleError(res, err, "booking.export"); }
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

// ── staff: worklist, calls, check-in, doctor requests, reports ───────────────
const staffRows = (rows: any[], role: string) => rows.map((r) => staffView(r, role));

export const staffWorklist = async (req: ClerkRequest, res: Response) => {
  try {
    const w = await svc.worklist();
    const role = req.clerkUser!.role;
    return sendSuccess(res, {
      needsCall: staffRows(w.needsCall, role), confirmTomorrow: staffRows(w.confirmTomorrow, role),
      confirmToday: staffRows(w.confirmToday, role), awaitingOutcome: staffRows(w.awaitingOutcome, role),
    });
  } catch (err) { return handleError(res, err, "booking.worklist"); }
};

export const staffCheckIn = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invalid request", 422);
    const row = await svc.checkInBooking(id);
    await audit(req, "booking.checked_in", "bookings", id, null, { at: row.checkedInAt });
    return sendSuccess(res, await svc.findBookingById(id), "Checked in");
  } catch (err) { return handleError(res, err, "booking.checkIn"); }
};

export const staffCall = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ outcome: z.enum(svc.CALL_OUTCOMES), note: z.string().max(300).optional() }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Invalid request", 422);
    await svc.recordCall(id, req.clerkUser!.dbUserId, p.data.outcome, p.data.note);
    await audit(req, `booking.call_${p.data.outcome}`, "bookings", id, null, { note: p.data.note ?? null });
    return sendSuccess(res, await svc.findBookingById(id), "Call logged");
  } catch (err) { return handleError(res, err, "booking.call"); }
};

export const staffCallHistory = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invalid request", 422);
    return sendSuccess(res, await svc.listCalls(id));
  } catch (err) { return handleError(res, err, "booking.callHistory"); }
};

export const doctorRequestChange = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const p = z.object({ reason: z.string().trim().min(3).max(300), suggestion: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!isUuid(id) || !p.success) return sendError(res, "Please give a short reason", 422);
    const mine = await myDoctorId(req);
    if (!mine) return sendError(res, "No doctor profile found for your account", 403);
    await svc.requestChange(id, mine, p.data.reason, p.data.suggestion);
    await audit(req, "booking.change_requested", "bookings", id, null, { reason: p.data.reason, suggestion: p.data.suggestion ?? null });
    return sendSuccess(res, await svc.findBookingById(id), "Reception has been asked to rearrange this appointment");
  } catch (err) { return handleError(res, err, "booking.requestChange"); }
};

export const doctorRequestDayOff = async (req: ClerkRequest, res: Response) => {
  try {
    const p = z.object({ date: dateStr, reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!p.success) return sendError(res, "Choose the day and give a short reason", 422);
    if (p.data.date < todayEAT()) return sendError(res, "That day has passed", 422);
    const mine = await myDoctorId(req);
    if (!mine) return sendError(res, "No doctor profile found for your account", 403);
    const n = await svc.requestDayOff(mine, p.data.date, p.data.reason);
    await audit(req, "booking.day_off_requested", "bookings", null, null, { date: p.data.date, flagged: n });
    return sendSuccess(res, { flagged: n }, n ? `${n} appointment(s) sent to reception to rearrange` : "You have no active appointments that day");
  } catch (err) { return handleError(res, err, "booking.requestDayOff"); }
};

export const noShowReport = async (req: Request, res: Response) => {
  try {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
    return sendSuccess(res, { days, rows: await svc.noShowStats(days) });
  } catch (err) { return handleError(res, err, "booking.noShowReport"); }
};
