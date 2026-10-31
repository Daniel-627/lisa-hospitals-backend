import crypto from "crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db, bookings, bookingCalls, bookingSettings, doctorAvailability, doctorTimeOff, doctors, staff, users, departments,
  bookingServices, bookingServiceDoctors, bookingHolidays, bookingWaitlist,
} from "../db";
import { HttpError } from "../utils/errors";
import { dateStr, nowSlotEAT, normalizeKenyanPhone, timeStr, todayEAT, uuid } from "../utils/validation";

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export const LIVE_STATUSES = ["pending", "confirmed"] as const;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_PATIENT_RESCHEDULES = 2;
const REPEAT_NO_SHOWS = 2;
const NO_SHOW_GRACE_MIN = 30;

// ── helpers ──────────────────────────────────────────────────────────────────
export const hhmm = (t: string) => String(t).slice(0, 5);
const toMin = (t: string) => { const [h, m] = hhmm(t).split(":").map(Number); return h * 60 + m; };
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const dowOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
export const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const newToken = () => crypto.randomBytes(24).toString("base64url");
export const newReference = () => {
  const b = crypto.randomBytes(6);
  return "LH-" + Array.from(b, (x) => REF_ALPHABET[x % REF_ALPHABET.length]).join("");
};
/** Minutes between two "YYYY-MM-DD HH:MM" strings (both Kenya time). */
const minutesBetween = (a: string, b: string) =>
  (new Date(b.replace(" ", "T") + ":00Z").getTime() - new Date(a.replace(" ", "T") + ":00Z").getTime()) / 60000;

// ── settings ─────────────────────────────────────────────────────────────────
export const settingsSchema = z.object({
  leadMinutes: z.number().int().min(0).max(7 * 24 * 60),
  horizonDays: z.number().int().min(1).max(365),
  cutoffHours: z.number().int().min(0).max(14 * 24),
  maxActivePerPhone: z.number().int().min(1).max(20),
}).partial();

export async function getSettings(ex: Executor = db) {
  const [row] = await ex.select().from(bookingSettings).where(eq(bookingSettings.id, 1)).limit(1);
  return row ?? { id: 1, leadMinutes: 60, horizonDays: 60, cutoffHours: 4, maxActivePerPhone: 3, updatedAt: new Date() };
}

export async function updateSettings(patch: z.infer<typeof settingsSchema>) {
  await db.insert(bookingSettings).values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: bookingSettings.id, set: { ...patch, updatedAt: new Date() } });
  return getSettings();
}

// ── slot engine ──────────────────────────────────────────────────────────────
export type Slot = { doctorId: string; date: string; time: string; durationMin: number; held?: boolean };
export type SlotOpts = {
  ignoreBookingId?: string;
  /** Reception: ignores notice period, horizon, holidays and walk-in holds (never ignores leave or existing bookings). */
  ignoreRules?: boolean;
  /** Length of the visit. Defaults to the doctor's slot length. A longer visit needs that much free time in a row. */
  durationMin?: number;
};

/**
 * Every free start time in [from, to] for the given doctors. A start time exists when the whole visit
 *  - fits inside one of the doctor's working blocks (start times step by the block's slot length),
 *  - doesn't overlap leave (whole-day or part-day) or another live (pending/confirmed) booking,
 *  - is at least `leadMinutes` away and within `horizonDays`, on a day the hospital isn't closed,
 *  - isn't in the block's walk-in hold (last N slots) unless reception is asking.
 * `ignoreBookingId` lets a reschedule treat its own current slot as free.
 */
export async function freeSlots(
  doctorIds: string[], from: string, to: string, opts: SlotOpts = {}, ex: Executor = db,
): Promise<Slot[]> {
  if (doctorIds.length === 0 || to < from) return [];
  const settings = await getSettings(ex);
  const now = nowSlotEAT();
  const today = todayEAT();
  const lastDay = opts.ignoreRules ? to : [to, addDays(today, settings.horizonDays)].sort()[0];
  if (lastDay < from) return [];

  const [avail, leave, taken, closed] = await Promise.all([
    ex.select().from(doctorAvailability).where(and(inArray(doctorAvailability.doctorId, doctorIds), eq(doctorAvailability.isActive, true))),
    ex.select().from(doctorTimeOff).where(and(inArray(doctorTimeOff.doctorId, doctorIds), lte(doctorTimeOff.startDate, lastDay), gte(doctorTimeOff.endDate, from))),
    ex.select({ id: bookings.id, doctorId: bookings.doctorId, d: bookings.slotDate, t: bookings.slotTime, dur: bookings.durationMin })
      .from(bookings)
      .where(and(inArray(bookings.doctorId, doctorIds), gte(bookings.slotDate, from), lte(bookings.slotDate, lastDay), inArray(bookings.status, [...LIVE_STATUSES]))),
    opts.ignoreRules ? Promise.resolve([] as { date: string }[])
      : ex.select({ date: bookingHolidays.date }).from(bookingHolidays).where(and(gte(bookingHolidays.date, from), lte(bookingHolidays.date, lastDay))),
  ]);
  const holidays = new Set(closed.map((h) => h.date));
  const busy = taken.filter((b) => b.id !== opts.ignoreBookingId)
    .map((b) => ({ key: `${b.doctorId}|${b.d}`, from: toMin(b.t), to: toMin(b.t) + b.dur }));

  const out: Slot[] = [];
  for (let d = from; d <= lastDay; d = addDays(d, 1)) {
    if (holidays.has(d)) continue;
    const dow = dowOf(d);
    for (const docId of doctorIds) {
      const todays = leave.filter((l) => l.doctorId === docId && l.startDate <= d && l.endDate >= d);
      if (todays.some((l) => !l.startTime || !l.endTime)) continue; // whole day off
      const blocks = todays.map((l) => ({ from: toMin(l.startTime!), to: toMin(l.endTime!) }));
      const mine = busy.filter((b) => b.key === `${docId}|${d}`);
      for (const a of avail.filter((x) => x.doctorId === docId && x.dayOfWeek === dow)) {
        const step = Math.max(5, a.slotMinutes);
        const dur = Math.max(5, opts.durationMin ?? step);
        const start = toMin(a.startTime), end = toMin(a.endTime);
        const heldFrom = end - a.walkinSlots * step;
        for (let m = start; m + dur <= end; m += step) {
          const time = fromMin(m);
          const held = a.walkinSlots > 0 && m + dur > heldFrom;
          if (held && !opts.ignoreRules) continue;
          if (!opts.ignoreRules && minutesBetween(now, `${d} ${time}`) < settings.leadMinutes) continue;
          if (mine.some((b) => m < b.to && m + dur > b.from)) continue;
          if (blocks.some((b) => m < b.to && m + dur > b.from)) continue;
          out.push({ doctorId: docId, date: d, time, durationMin: dur, ...(held ? { held: true } : {}) });
        }
      }
    }
  }
  return out;
}

/** Doctors who can be booked: switched on, active user, active department. */
export async function bookableDoctors(filter: { departmentId?: string; doctorId?: string } = {}, ex: Executor = db) {
  const conds = [eq(doctors.isAvailable, true), eq(users.isActive, true), eq(departments.isActive, true)];
  if (filter.departmentId) conds.push(eq(doctors.departmentId, filter.departmentId));
  if (filter.doctorId) conds.push(eq(doctors.id, filter.doctorId));
  return ex.select({
    id: doctors.id, departmentId: doctors.departmentId, speciality: doctors.speciality, photoUrl: doctors.photoUrl,
    firstName: users.firstName, lastName: users.lastName, department: departments.name,
  })
    .from(doctors)
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .innerJoin(users, eq(staff.userId, users.id))
    .innerJoin(departments, eq(doctors.departmentId, departments.id))
    .where(and(...conds))
    .orderBy(asc(users.lastName));
}

// ── booking ──────────────────────────────────────────────────────────────────
export const createBookingSchema = z.object({
  departmentId: uuid,
  serviceId: uuid.optional(),           // optional: what the visit is for (sets the length and the doctors)
  doctorId: uuid.optional(),            // omit = "first available doctor in the department"
  lang: z.enum(["en", "sw"]).optional(),
  date: dateStr,
  time: timeStr,
  guestName: z.string().trim().min(2).max(150),
  guestPhone: z.string().min(9).max(20),
  guestEmail: z.string().email().max(255).optional().or(z.literal("")),
  reason: z.string().trim().max(300).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/** Loads an active service and the doctors who do it. Throws 404 if it isn't bookable. */
export async function loadService(serviceId: string, ex: Executor = db) {
  const [svc] = await ex.select().from(bookingServices).where(and(eq(bookingServices.id, serviceId), eq(bookingServices.isActive, true))).limit(1);
  if (!svc) throw new HttpError(404, "That service isn't available for booking");
  const rows = await ex.select({ id: bookingServiceDoctors.doctorId }).from(bookingServiceDoctors).where(eq(bookingServiceDoctors.serviceId, serviceId));
  return { ...svc, doctorIds: rows.map((r) => r.id) };
}

/** Doctors who can take this booking: in the department, switched on, and (if a service is chosen) doing that service. */
export async function poolFor(filter: { departmentId: string; doctorId?: string; serviceId?: string }, ex: Executor = db) {
  let pool = await bookableDoctors({ departmentId: filter.departmentId, doctorId: filter.doctorId }, ex);
  let service: Awaited<ReturnType<typeof loadService>> | null = null;
  if (filter.serviceId) {
    service = await loadService(filter.serviceId, ex);
    if (service.departmentId !== filter.departmentId) throw new HttpError(422, "That service isn't offered by this department");
    pool = pool.filter((d) => service!.doctorIds.includes(d.id));
  }
  return { pool, service };
}

/** Unique-index (23505) or overlap-constraint (23P01) violation: somebody else got the time first. */
const isClash = (err: any) => ["23505", "23P01"].includes(err?.code) || ["23505", "23P01"].includes(err?.cause?.code);

const lock = (ex: Executor, key: string) => ex.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

export type Actor = { kind: "guest" } | { kind: "staff"; userId: string };

export async function createBooking(input: CreateBookingInput, actor: Actor, opts: { phoneVerified: boolean }) {
  const phone = normalizeKenyanPhone(input.guestPhone);
  if (!phone) throw new HttpError(422, "Enter a valid Kenyan phone number");

  const { pool, service } = await poolFor({ departmentId: input.departmentId, doctorId: input.doctorId, serviceId: input.serviceId });
  if (pool.length === 0) throw new HttpError(404, "That doctor or department isn't available for booking");

  const settings = await getSettings();
  const token = newToken();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Serialise everyone booking the same department/day so "first available doctor" can't race itself.
        await lock(tx as any, `bk:${input.departmentId}:${input.date}`);

        if (actor.kind === "guest") {
          const [{ n }]: any = await tx.select({ n: sql<number>`count(*)::int` }).from(bookings)
            .where(and(eq(bookings.guestPhone, phone), inArray(bookings.status, [...LIVE_STATUSES]), gte(bookings.slotDate, todayEAT())));
          if (n >= settings.maxActivePerPhone) {
            throw new HttpError(429, `This number already has ${n} upcoming appointments. Please cancel one or call the hospital.`);
          }
        }

        // Two or more no-shows on this number in the last 6 months: still bookable, but reception must call to confirm.
        let repeatNoShow = false;
        if (actor.kind === "guest") {
          const since = new Date(Date.now() - 180 * 86400000);
          const [{ n }]: any = await tx.select({ n: sql<number>`count(*)::int` }).from(bookings)
            .where(and(eq(bookings.guestPhone, phone), eq(bookings.status, "no_show"), gte(bookings.slotDate, since.toISOString().slice(0, 10))));
          repeatNoShow = n >= REPEAT_NO_SHOWS;
        }

        const free = await freeSlots(pool.map((d) => d.id), input.date, input.date, { ignoreRules: actor.kind === "staff", durationMin: service?.durationMin }, tx as any);
        const match = free.filter((s) => s.time === input.time);
        if (match.length === 0) throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
        const chosen = match[0];
        const doc = pool.find((d) => d.id === chosen.doctorId)!;

        // Staff may book inside the lead window but never in the past.
        if (nowSlotEAT() > `${input.date} ${input.time}`) throw new HttpError(422, "That time has already passed");

        const [row] = await tx.insert(bookings).values({
          reference: newReference(),
          doctorId: chosen.doctorId,
          departmentId: doc.departmentId,
          slotDate: input.date,
          slotTime: input.time,
          durationMin: chosen.durationMin,
          // Verified-by-SMS or staff-entered bookings are firm; unverified ones wait for reception.
          status: (opts.phoneVerified || actor.kind === "staff") && !repeatNoShow ? "confirmed" : "pending",
          flag: repeatNoShow ? "repeat_noshow" : actor.kind === "guest" && !opts.phoneVerified ? "unverified" : null,
          flagReason: repeatNoShow ? "Missed 2+ earlier appointments: please call to confirm" : null,
          reconfirmedAt: actor.kind === "staff" ? new Date() : null, // reception spoke to the caller
          guestName: input.guestName,
          guestPhone: phone,
          guestEmail: input.guestEmail || null,
          phoneVerified: opts.phoneVerified,
          reason: input.reason || null,
          serviceId: service?.id ?? null,
          lang: input.lang ?? "en",
          source: actor.kind === "staff" ? "reception" : "online",
          manageTokenHash: hashToken(token),
          createdBy: actor.kind === "staff" ? actor.userId : null,
        }).returning();
        return { booking: row, manageToken: token, doctor: doc };
      });
    } catch (err: any) {
      // Unique index fired (two requests raced past the check): try again so a different doctor/slot can be offered.
      if (isClash(err) && attempt < 2) continue;
      if (isClash(err)) throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
      throw err;
    }
  }
  throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
}

// ── reading ──────────────────────────────────────────────────────────────────
export const bookingView = () => ({
  id: bookings.id, reference: bookings.reference, status: bookings.status, slotDate: bookings.slotDate, slotTime: bookings.slotTime,
  durationMin: bookings.durationMin, guestName: bookings.guestName, guestPhone: bookings.guestPhone, guestEmail: bookings.guestEmail,
  phoneVerified: bookings.phoneVerified, reason: bookings.reason, source: bookings.source, rescheduleCount: bookings.rescheduleCount,
  cancelledAt: bookings.cancelledAt, cancelledBy: bookings.cancelledBy, cancelReason: bookings.cancelReason, createdAt: bookings.createdAt,
  doctorId: bookings.doctorId, departmentId: bookings.departmentId, serviceId: bookings.serviceId, lang: bookings.lang,
  service: bookingServices.name, serviceSw: bookingServices.nameSw,
  flag: bookings.flag, flagReason: bookings.flagReason, flagSuggestion: bookings.flagSuggestion,
  reconfirmedAt: bookings.reconfirmedAt, checkedInAt: bookings.checkedInAt, callAttempts: bookings.callAttempts, lastCallAt: bookings.lastCallAt,
  doctorFirstName: users.firstName, doctorLastName: users.lastName, speciality: doctors.speciality, department: departments.name,
});

export const bookingQuery = (ex: Executor = db) =>
  ex.select(bookingView()).from(bookings)
    .innerJoin(doctors, eq(bookings.doctorId, doctors.id))
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .innerJoin(users, eq(staff.userId, users.id))
    .innerJoin(departments, eq(bookings.departmentId, departments.id))
    .leftJoin(bookingServices, eq(bookings.serviceId, bookingServices.id));

export async function findBookingById(id: string, ex: Executor = db) {
  const [row] = await bookingQuery(ex).where(eq(bookings.id, id)).limit(1);
  return row;
}

/** Guest access: reference + (manage token from the link/SMS OR the phone number used to book). */
export async function findForGuest(reference: string, proof: { token?: string; phone?: string }, ex: Executor = db) {
  const ref = reference.trim().toUpperCase();
  const [raw] = await ex.select().from(bookings).where(eq(bookings.reference, ref)).limit(1);
  if (!raw) return null;
  const okToken = !!proof.token && safeEq(hashToken(proof.token), raw.manageTokenHash);
  const p = proof.phone ? normalizeKenyanPhone(proof.phone) : null;
  const okPhone = !!p && p === raw.guestPhone;
  if (!okToken && !okPhone) return null;
  return findBookingById(raw.id, ex);
}
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ── cancel / reschedule / status ─────────────────────────────────────────────
type Who = "patient" | "staff";

function assertPatientWindow(b: { slotDate: string; slotTime: string }, cutoffHours: number, verb: string) {
  if (minutesBetween(nowSlotEAT(), `${b.slotDate} ${hhmm(b.slotTime)}`) < cutoffHours * 60) {
    throw new HttpError(409, `Appointments can only be ${verb} at least ${cutoffHours} hours before the time. Please call the hospital.`);
  }
}

export async function cancelBooking(id: string, who: Who, reason?: string) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
    if (!b) throw new HttpError(404, "Booking not found");
    if (b.status === "cancelled") return b; // idempotent
    if (!LIVE_STATUSES.includes(b.status as any)) throw new HttpError(409, `A ${b.status.replace("_", " ")} appointment can't be cancelled`);
    if (who === "patient") assertPatientWindow({ slotDate: b.slotDate, slotTime: b.slotTime }, (await getSettings(tx as any)).cutoffHours, "cancelled");
    const [row] = await tx.update(bookings).set({
      status: "cancelled", cancelledAt: new Date(), cancelledBy: who, cancelReason: reason?.slice(0, 200) || null,
      flag: null, flagReason: null, flagSuggestion: null,
    }).where(eq(bookings.id, id)).returning();
    return row;
  });
}

/** Moves a booking to a new slot, keeping its reference. Doctor may change (staff) or stay the same. */
export async function rescheduleBooking(
  id: string, target: { date: string; time: string; doctorId?: string }, who: Who,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
        if (!b) throw new HttpError(404, "Booking not found");
        if (!LIVE_STATUSES.includes(b.status as any)) throw new HttpError(409, "Only upcoming appointments can be rescheduled");

        if (who === "patient") {
          assertPatientWindow({ slotDate: b.slotDate, slotTime: b.slotTime }, (await getSettings(tx as any)).cutoffHours, "rescheduled");
          if (b.rescheduleCount >= MAX_PATIENT_RESCHEDULES) {
            throw new HttpError(409, "This appointment has already been moved twice. Please call the hospital to change it again.");
          }
        }

        // Patients stay with their doctor; reception may move them to any doctor in the same department.
        const doctorId = who === "patient" ? b.doctorId : (target.doctorId ?? b.doctorId);
        const { pool } = await poolFor({ departmentId: b.departmentId, doctorId, serviceId: b.serviceId ?? undefined }, tx as any);
        if (pool.length === 0) throw new HttpError(404, "That doctor isn't available for booking");
        if (doctorId === b.doctorId && target.date === b.slotDate && target.time === hhmm(b.slotTime)) {
          throw new HttpError(422, "That's the same time you already have");
        }

        await lock(tx as any, `bk:${b.departmentId}:${target.date}`);
        const free = await freeSlots([doctorId], target.date, target.date, { ignoreBookingId: id, ignoreRules: who === "staff", durationMin: b.durationMin }, tx as any);
        if (!free.some((s) => s.time === target.time)) throw new HttpError(409, "Sorry, that time isn't available. Please pick another slot.");
        if (nowSlotEAT() > `${target.date} ${target.time}`) throw new HttpError(422, "That time has already passed");

        const [row] = await tx.update(bookings).set({
          doctorId, slotDate: target.date, slotTime: target.time,
          status: b.status === "pending" ? "pending" : "confirmed",
          rescheduleCount: b.rescheduleCount + (who === "patient" ? 1 : 0),
          // Someone has just dealt with this booking, so the red flag is resolved and the new time counts as re-confirmed.
          flag: null, flagReason: null, flagSuggestion: null, reconfirmedAt: new Date(), callAttempts: 0,
        }).where(eq(bookings.id, id)).returning();
        return { before: b, after: row };
      });
    } catch (err: any) {
      if (isClash(err)) {
        if (attempt === 0) continue;
        throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
      }
      throw err;
    }
  }
  throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
}

const STAFF_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled", "no_show"],
  confirmed: ["completed", "no_show", "cancelled"],
};
const SOFT_FLAGS = ["unverified", "repeat_noshow"]; // cleared by reception confirming; doctor/time-off flags need a move or cancel

export async function setBookingStatus(id: string, status: "confirmed" | "completed" | "no_show" | "cancelled", reason?: string) {
  if (status === "cancelled") return cancelBooking(id, "staff", reason);
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
    if (!b) throw new HttpError(404, "Booking not found");
    if (b.status === status) return b; // idempotent
    if (!STAFF_TRANSITIONS[b.status]?.includes(status)) {
      throw new HttpError(409, `Can't change a ${b.status.replace("_", " ")} appointment to ${status.replace("_", " ")}`);
    }
    if (status === "no_show") {
      if (nowSlotEAT() < `${b.slotDate} ${hhmm(b.slotTime)}`) throw new HttpError(409, "That appointment hasn't happened yet");
      if (b.checkedInAt) throw new HttpError(409, "This patient was checked in, so they can't be a no-show");
    }
    if (status === "completed" && !b.checkedInAt) throw new HttpError(409, "Check the patient in first");
    const patch: Record<string, unknown> = { status };
    if (status === "confirmed") {
      patch.reconfirmedAt = new Date();
      if (b.flag && SOFT_FLAGS.includes(b.flag)) Object.assign(patch, { flag: null, flagReason: null, flagSuggestion: null });
    }
    if (status === "no_show") Object.assign(patch, { flag: null, flagReason: null, flagSuggestion: null });
    const [row] = await tx.update(bookings).set(patch).where(eq(bookings.id, id)).returning();
    return row;
  });
}

/** Patient has arrived. Only on the day itself. A pending booking is confirmed by being here. */
export async function checkInBooking(id: string) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
    if (!b) throw new HttpError(404, "Booking not found");
    if (b.checkedInAt && b.status !== "cancelled") return b; // idempotent
    if (!LIVE_STATUSES.includes(b.status as any)) throw new HttpError(409, `A ${b.status.replace("_", " ")} appointment can't be checked in`);
    if (b.slotDate !== todayEAT()) throw new HttpError(409, "Check-in opens on the day of the appointment");
    const [row] = await tx.update(bookings).set({
      status: "confirmed", checkedInAt: new Date(), reconfirmedAt: b.reconfirmedAt ?? new Date(),
      flag: null, flagReason: null, flagSuggestion: null,
    }).where(eq(bookings.id, id)).returning();
    return row;
  });
}

// ── calls ────────────────────────────────────────────────────────────────────
export const CALL_OUTCOMES = ["coming", "no_answer", "resolved", "other"] as const;

/**
 * coming     → patient says they're coming: re-confirmed (clears the soft flags)
 * no_answer  → counted; stays on the list so it can be tried again
 * resolved   → reception dealt with the flag without moving/cancelling (e.g. doctor can attend after all)
 * other      → just a logged note
 */
export async function recordCall(id: string, userId: string, outcome: (typeof CALL_OUTCOMES)[number], note?: string) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
    if (!b) throw new HttpError(404, "Booking not found");
    await tx.insert(bookingCalls).values({ bookingId: id, userId, outcome, note: note?.slice(0, 300) || null });
    const patch: Record<string, unknown> = { lastCallAt: new Date() };
    if (outcome === "no_answer") patch.callAttempts = b.callAttempts + 1;
    if (outcome === "coming") {
      patch.reconfirmedAt = new Date(); patch.callAttempts = 0;
      if (b.flag && SOFT_FLAGS.includes(b.flag)) Object.assign(patch, { flag: null, flagReason: null, flagSuggestion: null });
      // Reaching the patient and hearing "coming" is exactly the confirmation a pending booking was waiting for.
      if (b.status === "pending" && (!b.flag || SOFT_FLAGS.includes(b.flag))) patch.status = "confirmed";
    }
    if (outcome === "resolved") Object.assign(patch, { flag: null, flagReason: null, flagSuggestion: null });
    const [row] = await tx.update(bookings).set(patch).where(eq(bookings.id, id)).returning();
    return row;
  });
}

export async function listCalls(bookingId: string) {
  return db.select({ id: bookingCalls.id, outcome: bookingCalls.outcome, note: bookingCalls.note, createdAt: bookingCalls.createdAt, by: users.firstName })
    .from(bookingCalls).leftJoin(users, eq(bookingCalls.userId, users.id))
    .where(eq(bookingCalls.bookingId, bookingId)).orderBy(desc(bookingCalls.createdAt));
}

// ── doctor change requests / time-off flags ──────────────────────────────────
const flagLive = (where: any, flag: string, reason: string, suggestion?: string | null) =>
  db.update(bookings).set({ flag, flagReason: reason.slice(0, 300), flagSuggestion: suggestion?.slice(0, 300) || null })
    .where(and(where, inArray(bookings.status, [...LIVE_STATUSES]), isNull(bookings.checkedInAt))).returning({ id: bookings.id });

/** A doctor says they can't keep one of THEIR appointments. The booking is held and reception is told to call. */
export async function requestChange(id: string, doctorId: string, reason: string, suggestion?: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  if (!b || b.doctorId !== doctorId) throw new HttpError(404, "Booking not found");
  if (!LIVE_STATUSES.includes(b.status as any)) throw new HttpError(409, "That appointment is no longer active");
  if (b.checkedInAt) throw new HttpError(409, "That patient has already arrived");
  await flagLive(eq(bookings.id, id), "doctor_request", reason, suggestion);
  return findBookingById(id);
}

/** A doctor can't work a whole day: every live booking of theirs that day is flagged. */
export async function requestDayOff(doctorId: string, date: string, reason: string) {
  const rows = await flagLive(and(eq(bookings.doctorId, doctorId), eq(bookings.slotDate, date)), "doctor_request", reason);
  return rows.length;
}

/**
 * Leave was just blocked: flag the live bookings it hits so they show up in reception's call queue.
 * With start/end times only bookings overlapping those hours are flagged; without, the whole day(s).
 */
export async function flagForTimeOff(
  doctorId: string, from: string, to: string, reason?: string | null, startTime?: string | null, endTime?: string | null,
) {
  const partial = startTime && endTime
    ? sql`${bookings.slotTime} < ${endTime}::time and (${bookings.slotTime} + make_interval(mins => ${bookings.durationMin})) > ${startTime}::time`
    : undefined;
  const rows = await flagLive(
    and(eq(bookings.doctorId, doctorId), gte(bookings.slotDate, from), lte(bookings.slotDate, to), partial),
    "time_off", reason ? `Doctor unavailable: ${reason}` : "Doctor unavailable (time off)",
  );
  return rows.length;
}

/** Live bookings that overlap a time-off window (used to tell the doctor/admin what needs rescheduling). */
export async function bookingsHitByTimeOff(doctorId: string, from: string, to: string, startTime?: string | null, endTime?: string | null) {
  const partial = startTime && endTime
    ? sql`${bookings.slotTime} < ${endTime}::time and (${bookings.slotTime} + make_interval(mins => ${bookings.durationMin})) > ${startTime}::time`
    : undefined;
  return bookingQuery().where(and(eq(bookings.doctorId, doctorId), gte(bookings.slotDate, from), lte(bookings.slotDate, to), inArray(bookings.status, [...LIVE_STATUSES]), partial))
    .orderBy(asc(bookings.slotDate), asc(bookings.slotTime));
}

// ── time off (doctor, reception or admin) ────────────────────────────────────
export const timeOffSchema = z.object({
  doctorId: uuid,
  startDate: dateStr,
  endDate: dateStr.optional(),
  startTime: timeStr.optional().nullable(),
  endTime: timeStr.optional().nullable(),
  reason: z.string().trim().max(200).optional(),
}).refine((v) => !v.endDate || v.endDate >= v.startDate, "End date must be on or after the start date")
  .refine((v) => (!v.startTime && !v.endTime) || (!!v.startTime && !!v.endTime && v.endTime > v.startTime), "End time must be after the start time")
  .refine((v) => !(v.startTime && v.endTime) || !v.endDate || v.endDate === v.startDate, "Part-day time off covers a single day");

export async function addTimeOff(input: z.infer<typeof timeOffSchema>, userId: string) {
  const endDate = input.endDate ?? input.startDate;
  const partial = !!(input.startTime && input.endTime);
  if (endDate < todayEAT()) throw new HttpError(422, "That day has already passed");
  const [doc] = await db.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, input.doctorId)).limit(1);
  if (!doc) throw new HttpError(404, "Doctor not found");
  const [row] = await db.insert(doctorTimeOff).values({
    doctorId: input.doctorId, startDate: input.startDate, endDate,
    startTime: partial ? input.startTime! : null, endTime: partial ? input.endTime! : null,
    reason: input.reason || null, createdBy: userId,
  }).returning();
  const affected = await bookingsHitByTimeOff(input.doctorId, input.startDate, endDate, row.startTime, row.endTime);
  await flagForTimeOff(input.doctorId, input.startDate, endDate, input.reason, row.startTime, row.endTime);
  return { timeOff: row, affected };
}

/** Removes a block and un-flags bookings that were flagged only because of it. */
export async function removeTimeOff(id: string, onlyDoctorId?: string) {
  const [row] = await db.select().from(doctorTimeOff).where(eq(doctorTimeOff.id, id)).limit(1);
  if (!row || (onlyDoctorId && row.doctorId !== onlyDoctorId)) throw new HttpError(404, "Not found");
  await db.delete(doctorTimeOff).where(eq(doctorTimeOff.id, id));
  const hit = row.startTime && row.endTime
    ? sql`${bookings.slotTime} < ${row.endTime}::time and (${bookings.slotTime} + make_interval(mins => ${bookings.durationMin})) > ${row.startTime}::time`
    : undefined;
  await db.update(bookings).set({ flag: null, flagReason: null, flagSuggestion: null })
    .where(and(eq(bookings.doctorId, row.doctorId), eq(bookings.flag, "time_off"), gte(bookings.slotDate, row.startDate), lte(bookings.slotDate, row.endDate), hit));
  // Anything still covered by another block stays flagged.
  const rest = await db.select().from(doctorTimeOff).where(and(eq(doctorTimeOff.doctorId, row.doctorId), lte(doctorTimeOff.startDate, row.endDate), gte(doctorTimeOff.endDate, row.startDate)));
  for (const r of rest) await flagForTimeOff(r.doctorId, r.startDate, r.endDate, r.reason, r.startTime, r.endTime);
  return row;
}

// ── doctor's own weekly hours ────────────────────────────────────────────────
export const weeklySchema = z.object({
  slots: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: timeStr,
    endTime: timeStr,
    slotMinutes: z.number().int().min(5).max(120).default(20),
    walkinSlots: z.number().int().min(0).max(20).default(0),
  })).max(28),
});

export async function saveWeekly(doctorId: string, slotsIn: z.infer<typeof weeklySchema>["slots"]) {
  const slots = [...slotsIn].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  for (let i = 0; i < slots.length; i++) {
    const x = slots[i], prev = slots[i - 1];
    if (x.endTime <= x.startTime) throw new HttpError(422, "Each block must end after it starts");
    if (toMin(x.endTime) - toMin(x.startTime) < x.slotMinutes) throw new HttpError(422, "A block must be at least one appointment long");
    if (x.walkinSlots * x.slotMinutes >= toMin(x.endTime) - toMin(x.startTime)) throw new HttpError(422, "Walk-in hold can't cover the whole block");
    if (prev && prev.dayOfWeek === x.dayOfWeek && x.startTime < prev.endTime) throw new HttpError(422, "Blocks on the same day can't overlap");
  }
  return db.transaction(async (tx) => {
    const [doc] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, doctorId)).limit(1);
    if (!doc) throw new HttpError(404, "Doctor not found");
    await tx.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId));
    if (slots.length === 0) return [];
    return tx.insert(doctorAvailability).values(slots.map((x) => ({
      doctorId, dayOfWeek: x.dayOfWeek, startTime: x.startTime, endTime: x.endTime, slotMinutes: x.slotMinutes, walkinSlots: x.walkinSlots, maxSlots: 20, isActive: true,
    }))).returning();
  });
}

/** Doctor's own calendar for one month: hours, blocks, and how many live bookings each day holds. */
export async function doctorMonth(doctorId: string, month: string) {
  const from = `${month}-01`;
  const to = addDays(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10), 0);
  const [hours, leave, counts] = await Promise.all([
    db.select().from(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId)).orderBy(asc(doctorAvailability.dayOfWeek), asc(doctorAvailability.startTime)),
    db.select().from(doctorTimeOff).where(and(eq(doctorTimeOff.doctorId, doctorId), lte(doctorTimeOff.startDate, to), gte(doctorTimeOff.endDate, from))).orderBy(asc(doctorTimeOff.startDate)),
    db.select({ d: bookings.slotDate, n: sql<number>`count(*)::int` }).from(bookings)
      .where(and(eq(bookings.doctorId, doctorId), gte(bookings.slotDate, from), lte(bookings.slotDate, to), inArray(bookings.status, [...LIVE_STATUSES]))).groupBy(bookings.slotDate),
  ]);
  const holidays = await db.select().from(bookingHolidays).where(and(gte(bookingHolidays.date, from), lte(bookingHolidays.date, to)));
  return { from, to, hours, timeOff: leave, bookingCounts: Object.fromEntries(counts.map((c) => [c.d, c.n])), holidays };
}

// ── hospital-wide closed days ────────────────────────────────────────────────
export async function listHolidays() {
  return db.select().from(bookingHolidays).where(gte(bookingHolidays.date, todayEAT())).orderBy(asc(bookingHolidays.date));
}

export async function addHoliday(date: string, name: string, userId: string) {
  if (date < todayEAT()) throw new HttpError(422, "That day has already passed");
  const [row] = await db.insert(bookingHolidays).values({ date, name, createdBy: userId }).onConflictDoNothing().returning();
  if (!row) throw new HttpError(409, "That day is already marked as closed");
  const affected = await flagLive(eq(bookings.slotDate, date), "holiday", `Closed: ${name}`);
  return { holiday: row, flagged: affected.length };
}

export async function removeHoliday(id: string) {
  const [row] = await db.delete(bookingHolidays).where(eq(bookingHolidays.id, id)).returning();
  if (!row) throw new HttpError(404, "Not found");
  await db.update(bookings).set({ flag: null, flagReason: null, flagSuggestion: null }).where(and(eq(bookings.flag, "holiday"), eq(bookings.slotDate, row.date)));
  return row;
}

// ── services ─────────────────────────────────────────────────────────────────
export const serviceSchema = z.object({
  departmentId: uuid,
  name: z.string().trim().min(2).max(120),
  nameSw: z.string().trim().max(120).optional().or(z.literal("")),
  durationMin: z.number().int().min(5).max(240),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
  doctorIds: z.array(uuid).max(100),
});

export async function listServices(opts: { departmentId?: string; activeOnly?: boolean } = {}) {
  const conds: any[] = [];
  if (opts.departmentId) conds.push(eq(bookingServices.departmentId, opts.departmentId));
  if (opts.activeOnly) conds.push(eq(bookingServices.isActive, true));
  const rows = await db.select().from(bookingServices).where(conds.length ? and(...conds) : undefined).orderBy(asc(bookingServices.sortOrder), asc(bookingServices.name));
  if (rows.length === 0) return [];
  const links = await db.select().from(bookingServiceDoctors).where(inArray(bookingServiceDoctors.serviceId, rows.map((r) => r.id)));
  return rows.map((r) => ({ ...r, doctorIds: links.filter((l) => l.serviceId === r.id).map((l) => l.doctorId) }));
}

export async function saveService(input: z.infer<typeof serviceSchema>, id?: string) {
  return db.transaction(async (tx) => {
    const values = { departmentId: input.departmentId, name: input.name, nameSw: input.nameSw || null, durationMin: input.durationMin, sortOrder: input.sortOrder, isActive: input.isActive };
    let row;
    if (id) {
      [row] = await tx.update(bookingServices).set(values).where(eq(bookingServices.id, id)).returning();
      if (!row) throw new HttpError(404, "Service not found");
    } else {
      [row] = await tx.insert(bookingServices).values(values).returning();
    }
    const docs = input.doctorIds.length
      ? await tx.select({ id: doctors.id }).from(doctors).where(and(inArray(doctors.id, input.doctorIds), eq(doctors.departmentId, input.departmentId)))
      : [];
    await tx.delete(bookingServiceDoctors).where(eq(bookingServiceDoctors.serviceId, row.id));
    if (docs.length) await tx.insert(bookingServiceDoctors).values(docs.map((d) => ({ serviceId: row.id, doctorId: d.id })));
    return { ...row, doctorIds: docs.map((d) => d.id) };
  });
}

export async function deleteService(id: string) {
  const [used] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.serviceId, id)).limit(1);
  if (used) {
    await db.update(bookingServices).set({ isActive: false }).where(eq(bookingServices.id, id));
    return { deleted: false, deactivated: true };
  }
  await db.delete(bookingServices).where(eq(bookingServices.id, id));
  return { deleted: true, deactivated: false };
}

// ── waiting list ─────────────────────────────────────────────────────────────
export const waitlistSchema = z.object({
  departmentId: uuid,
  doctorId: uuid.optional(),
  serviceId: uuid.optional(),
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  guestName: z.string().trim().min(2).max(150),
  guestPhone: z.string().min(9).max(20),
  note: z.string().trim().max(200).optional(),
  lang: z.enum(["en", "sw"]).optional(),
});
const MAX_WAITING_PER_PHONE = 2;

export async function joinWaitlist(input: z.infer<typeof waitlistSchema>, phoneVerified: boolean) {
  const phone = normalizeKenyanPhone(input.guestPhone);
  if (!phone) throw new HttpError(422, "Enter a valid Kenyan phone number");
  const { pool } = await poolFor({ departmentId: input.departmentId, doctorId: input.doctorId, serviceId: input.serviceId });
  if (pool.length === 0) throw new HttpError(404, "That doctor or department isn't available for booking");
  const [{ n }]: any = await db.select({ n: sql<number>`count(*)::int` }).from(bookingWaitlist)
    .where(and(eq(bookingWaitlist.guestPhone, phone), eq(bookingWaitlist.status, "waiting")));
  if (n >= MAX_WAITING_PER_PHONE) throw new HttpError(429, "This number is already on the waiting list. We'll call you when a time opens.");
  const from = input.fromDate && input.fromDate > todayEAT() ? input.fromDate : todayEAT();
  const [row] = await db.insert(bookingWaitlist).values({
    departmentId: input.departmentId, doctorId: input.doctorId ?? null, serviceId: input.serviceId ?? null,
    fromDate: from, toDate: input.toDate && input.toDate >= from ? input.toDate : null,
    guestName: input.guestName, guestPhone: phone, phoneVerified, note: input.note || null, lang: input.lang ?? "en",
  }).returning();
  return row;
}

/** Everyone waiting, each with the soonest slot that now fits them (if any), so reception can offer it. */
export async function waitlistWithMatches() {
  const rows = await db.select({
    id: bookingWaitlist.id, departmentId: bookingWaitlist.departmentId, doctorId: bookingWaitlist.doctorId, serviceId: bookingWaitlist.serviceId,
    fromDate: bookingWaitlist.fromDate, toDate: bookingWaitlist.toDate, guestName: bookingWaitlist.guestName, guestPhone: bookingWaitlist.guestPhone,
    phoneVerified: bookingWaitlist.phoneVerified, note: bookingWaitlist.note, callAttempts: bookingWaitlist.callAttempts, lastCallAt: bookingWaitlist.lastCallAt,
    createdAt: bookingWaitlist.createdAt, department: departments.name,
  }).from(bookingWaitlist).innerJoin(departments, eq(bookingWaitlist.departmentId, departments.id))
    .where(eq(bookingWaitlist.status, "waiting")).orderBy(asc(bookingWaitlist.createdAt)).limit(200);

  const settings = await getSettings();
  const today = todayEAT();
  const horizon = addDays(today, settings.horizonDays);
  const cache = new Map<string, Slot[]>();
  const out = [];
  for (const r of rows) {
    const from = r.fromDate > today ? r.fromDate : today;
    const to = r.toDate && r.toDate < horizon ? r.toDate : horizon;
    const key = `${r.departmentId}|${r.doctorId}|${r.serviceId}|${from}|${to}`;
    let free = cache.get(key);
    if (!free) {
      try {
        const { pool, service } = await poolFor({ departmentId: r.departmentId, doctorId: r.doctorId ?? undefined, serviceId: r.serviceId ?? undefined });
        free = (await freeSlots(pool.map((d) => d.id), from, to, { durationMin: service?.durationMin })).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
        (free as any).__pool = pool;
      } catch { free = []; }
      cache.set(key, free);
    }
    const next = free[0];
    const pool: any[] = (free as any).__pool ?? [];
    const doc = next ? pool.find((d) => d.id === next.doctorId) : null;
    out.push({ ...r, nextFree: next ? { date: next.date, time: next.time, doctorId: next.doctorId, doctor: doc ? `Dr. ${doc.firstName} ${doc.lastName}` : "" } : null });
  }
  // Those with a slot available now come first.
  return out.sort((a, b) => Number(!!b.nextFree) - Number(!!a.nextFree));
}

export async function waitlistCall(id: string, outcome: "no_answer" | "other") {
  const [w] = await db.select().from(bookingWaitlist).where(eq(bookingWaitlist.id, id)).limit(1);
  if (!w) throw new HttpError(404, "Not found");
  await db.update(bookingWaitlist).set({ lastCallAt: new Date(), callAttempts: outcome === "no_answer" ? w.callAttempts + 1 : w.callAttempts }).where(eq(bookingWaitlist.id, id));
}

export async function waitlistBook(id: string, target: { date: string; time: string; doctorId?: string }, userId: string) {
  const [w] = await db.select().from(bookingWaitlist).where(and(eq(bookingWaitlist.id, id), eq(bookingWaitlist.status, "waiting"))).limit(1);
  if (!w) throw new HttpError(404, "That person is no longer waiting");
  const made = await createBooking({
    departmentId: w.departmentId, serviceId: w.serviceId ?? undefined, doctorId: target.doctorId ?? w.doctorId ?? undefined,
    date: target.date, time: target.time, guestName: w.guestName, guestPhone: w.guestPhone, lang: w.lang as "en" | "sw", reason: w.note ?? undefined,
  }, { kind: "staff", userId }, { phoneVerified: w.phoneVerified });
  await db.update(bookingWaitlist).set({ status: "booked", bookingId: made.booking.id }).where(eq(bookingWaitlist.id, id));
  return made;
}

export async function waitlistRemove(id: string) {
  const [row] = await db.update(bookingWaitlist).set({ status: "removed" }).where(and(eq(bookingWaitlist.id, id), eq(bookingWaitlist.status, "waiting"))).returning();
  if (!row) throw new HttpError(404, "Not found");
}

// ── CSV export ───────────────────────────────────────────────────────────────
const csvCell = (v: unknown) => {
  let t = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // stops spreadsheet formula injection
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export async function exportBookingsCsv(from: string, to: string) {
  const rows = await bookingQuery().where(and(gte(bookings.slotDate, from), lte(bookings.slotDate, to))).orderBy(asc(bookings.slotDate), asc(bookings.slotTime)).limit(20000);
  const head = ["Reference", "Date", "Time", "Minutes", "Status", "Doctor", "Department", "Service", "Patient", "Phone", "Source", "Phone verified", "Checked in at", "Reconfirmed by phone", "Calls unanswered", "Booked at", "Cancelled by", "Cancel reason"];
  const lines = rows.map((r: any) => [
    r.reference, r.slotDate, hhmm(r.slotTime), r.durationMin, r.status, `Dr. ${r.doctorFirstName} ${r.doctorLastName}`, r.department, r.service ?? "",
    r.guestName, r.guestPhone, r.source, r.phoneVerified ? "yes" : "no", r.checkedInAt ?? "", r.reconfirmedAt ? "yes" : "no", r.callAttempts, r.createdAt, r.cancelledBy ?? "", r.cancelReason ?? "",
  ].map(csvCell).join(","));
  return "\uFEFF" + [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// ── worklist ─────────────────────────────────────────────────────────────────
/**
 * Everything reception has to act on:
 *  needsCall        flagged bookings (doctor asked for a change, leave, unverified phone, repeat no-shows)
 *  confirmTomorrow  tomorrow's bookings nobody has spoken to yet
 *  confirmToday     today's, still upcoming, nobody has spoken to yet (second chance after "no answer")
 *  awaitingOutcome  start time + grace has passed and the patient was never checked in
 */
export async function worklist() {
  const today = todayEAT();
  const tomorrow = addDays(today, 1);
  const now = nowSlotEAT();
  const live = inArray(bookings.status, [...LIVE_STATUSES]);
  const q = () => bookingQuery();

  const [needsCall, tomorrowRows, todayRows, recent] = await Promise.all([
    q().where(and(live, isNotNull(bookings.flag), isNull(bookings.checkedInAt), gte(bookings.slotDate, today)))
      .orderBy(asc(bookings.slotDate), asc(bookings.slotTime)).limit(200),
    q().where(and(live, eq(bookings.slotDate, tomorrow), isNull(bookings.reconfirmedAt), isNull(bookings.flag)))
      .orderBy(asc(bookings.slotTime)).limit(300),
    q().where(and(live, eq(bookings.slotDate, today), isNull(bookings.reconfirmedAt), isNull(bookings.checkedInAt), isNull(bookings.flag)))
      .orderBy(asc(bookings.slotTime)).limit(300),
    q().where(and(live, isNull(bookings.checkedInAt), gte(bookings.slotDate, addDays(today, -7)), lte(bookings.slotDate, today)))
      .orderBy(desc(bookings.slotDate), desc(bookings.slotTime)).limit(300),
  ]);

  const grace = (b: { slotDate: string; slotTime: string }) => minutesBetween(`${b.slotDate} ${hhmm(b.slotTime)}`, now) >= NO_SHOW_GRACE_MIN;
  return {
    needsCall,
    confirmTomorrow: tomorrowRows,
    confirmToday: todayRows.filter((b) => !grace(b)),
    awaitingOutcome: recent.filter(grace),
  };
}

/** Attended vs missed per doctor, last 90 days. */
export async function noShowStats(days = 90) {
  const since = addDays(todayEAT(), -days);
  const res: any = await db.execute(sql`
    select d.id as "doctorId", u.first_name as "firstName", u.last_name as "lastName", dep.name as department,
      count(*) filter (where b.checked_in_at is not null or b.status = 'completed')::int as attended,
      count(*) filter (where b.status = 'no_show')::int as "noShow",
      count(*) filter (where b.status = 'cancelled')::int as cancelled
    from bookings b
    join doctors d on d.id = b.doctor_id
    join staff st on st.id = d.staff_id
    join users u on u.id = st.user_id
    join departments dep on dep.id = b.department_id
    where b.slot_date >= ${since} and b.slot_date <= ${todayEAT()}
    group by d.id, u.first_name, u.last_name, dep.name
    order by "noShow" desc, attended desc`);
  return res.rows ?? res;
}

/** Live bookings that sit on a day a doctor is about to be blocked (so reception can move them). */
export async function bookingsInRange(doctorId: string, from: string, to: string) {
  return bookingQuery().where(and(eq(bookings.doctorId, doctorId), gte(bookings.slotDate, from), lte(bookings.slotDate, to), inArray(bookings.status, [...LIVE_STATUSES])))
    .orderBy(asc(bookings.slotDate), asc(bookings.slotTime));
}
