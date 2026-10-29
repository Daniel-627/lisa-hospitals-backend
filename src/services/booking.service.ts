import crypto from "crypto";
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db, bookings, bookingSettings, doctorAvailability, doctorTimeOff, doctors, staff, users, departments,
} from "../db";
import { HttpError } from "../utils/errors";
import { dateStr, nowSlotEAT, normalizeKenyanPhone, timeStr, todayEAT, uuid } from "../utils/validation";

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;

export const LIVE_STATUSES = ["pending", "confirmed"] as const;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_PATIENT_RESCHEDULES = 2;

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
export type Slot = { doctorId: string; date: string; time: string; durationMin: number };

/**
 * Every free slot in [from, to] for the given doctors. A slot exists when:
 *  - the doctor works that weekday (doctor_availability, cut into slotMinutes pieces that fit the window),
 *  - the doctor isn't on leave that day,
 *  - nobody holds a live (pending/confirmed) booking at that time,
 *  - it is at least `leadMinutes` away and within `horizonDays`.
 * `ignoreBookingId` lets a reschedule treat its own current slot as free.
 */
export async function freeSlots(
  doctorIds: string[], from: string, to: string, opts: { ignoreBookingId?: string; ignoreRules?: boolean } = {}, ex: Executor = db,
): Promise<Slot[]> {
  if (doctorIds.length === 0 || to < from) return [];
  const settings = await getSettings(ex);
  const now = nowSlotEAT();
  const today = todayEAT();
  const lastDay = opts.ignoreRules ? to : [to, addDays(today, settings.horizonDays)].sort()[0];
  if (lastDay < from) return [];

  const [avail, leave, taken] = await Promise.all([
    ex.select().from(doctorAvailability).where(and(inArray(doctorAvailability.doctorId, doctorIds), eq(doctorAvailability.isActive, true))),
    ex.select().from(doctorTimeOff).where(and(inArray(doctorTimeOff.doctorId, doctorIds), lte(doctorTimeOff.startDate, lastDay), gte(doctorTimeOff.endDate, from))),
    ex.select({ id: bookings.id, doctorId: bookings.doctorId, d: bookings.slotDate, t: bookings.slotTime, dur: bookings.durationMin })
      .from(bookings)
      .where(and(inArray(bookings.doctorId, doctorIds), gte(bookings.slotDate, from), lte(bookings.slotDate, lastDay), inArray(bookings.status, [...LIVE_STATUSES]))),
  ]);

  const busy = new Set(taken.filter((b) => b.id !== opts.ignoreBookingId).map((b) => `${b.doctorId}|${b.d}|${hhmm(b.t)}`));
  const out: Slot[] = [];
  for (let d = from; d <= lastDay; d = addDays(d, 1)) {
    const dow = dowOf(d);
    for (const docId of doctorIds) {
      if (leave.some((l) => l.doctorId === docId && l.startDate <= d && l.endDate >= d)) continue;
      for (const a of avail.filter((x) => x.doctorId === docId && x.dayOfWeek === dow)) {
        const step = Math.max(5, a.slotMinutes);
        for (let m = toMin(a.startTime); m + step <= toMin(a.endTime); m += step) {
          const time = fromMin(m);
          if (!opts.ignoreRules && minutesBetween(now, `${d} ${time}`) < settings.leadMinutes) continue;
          if (busy.has(`${docId}|${d}|${time}`)) continue;
          out.push({ doctorId: docId, date: d, time, durationMin: step });
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
  doctorId: uuid.optional(),            // omit = "first available doctor in the department"
  date: dateStr,
  time: timeStr,
  guestName: z.string().trim().min(2).max(150),
  guestPhone: z.string().min(9).max(20),
  guestEmail: z.string().email().max(255).optional().or(z.literal("")),
  reason: z.string().trim().max(300).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

const lock = (ex: Executor, key: string) => ex.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

export type Actor = { kind: "guest" } | { kind: "staff"; userId: string };

export async function createBooking(input: CreateBookingInput, actor: Actor, opts: { phoneVerified: boolean }) {
  const phone = normalizeKenyanPhone(input.guestPhone);
  if (!phone) throw new HttpError(422, "Enter a valid Kenyan phone number");

  const pool = await bookableDoctors({ departmentId: input.departmentId, doctorId: input.doctorId });
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

        const free = await freeSlots(pool.map((d) => d.id), input.date, input.date, { ignoreRules: actor.kind === "staff" }, tx as any);
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
          status: opts.phoneVerified || actor.kind === "staff" ? "confirmed" : "pending",
          guestName: input.guestName,
          guestPhone: phone,
          guestEmail: input.guestEmail || null,
          phoneVerified: opts.phoneVerified,
          reason: input.reason || null,
          source: actor.kind === "staff" ? "reception" : "online",
          manageTokenHash: hashToken(token),
          createdBy: actor.kind === "staff" ? actor.userId : null,
        }).returning();
        return { booking: row, manageToken: token, doctor: doc };
      });
    } catch (err: any) {
      // Unique index fired (two requests raced past the check): try again so a different doctor/slot can be offered.
      if ((err?.code === "23505" || err?.cause?.code === "23505") && attempt < 2) continue;
      if (err?.code === "23505" || err?.cause?.code === "23505") throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
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
  doctorId: bookings.doctorId, departmentId: bookings.departmentId,
  doctorFirstName: users.firstName, doctorLastName: users.lastName, speciality: doctors.speciality, department: departments.name,
});

export const bookingQuery = (ex: Executor = db) =>
  ex.select(bookingView()).from(bookings)
    .innerJoin(doctors, eq(bookings.doctorId, doctors.id))
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .innerJoin(users, eq(staff.userId, users.id))
    .innerJoin(departments, eq(bookings.departmentId, departments.id));

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
        const pool = await bookableDoctors({ departmentId: b.departmentId, doctorId }, tx as any);
        if (pool.length === 0) throw new HttpError(404, "That doctor isn't available for booking");
        if (doctorId === b.doctorId && target.date === b.slotDate && target.time === hhmm(b.slotTime)) {
          throw new HttpError(422, "That's the same time you already have");
        }

        await lock(tx as any, `bk:${b.departmentId}:${target.date}`);
        const free = await freeSlots([doctorId], target.date, target.date, { ignoreBookingId: id, ignoreRules: who === "staff" }, tx as any);
        if (!free.some((s) => s.time === target.time)) throw new HttpError(409, "Sorry, that time isn't available. Please pick another slot.");
        if (nowSlotEAT() > `${target.date} ${target.time}`) throw new HttpError(422, "That time has already passed");

        const [row] = await tx.update(bookings).set({
          doctorId, slotDate: target.date, slotTime: target.time,
          status: b.status === "pending" ? "pending" : "confirmed",
          rescheduleCount: b.rescheduleCount + (who === "patient" ? 1 : 0),
        }).where(eq(bookings.id, id)).returning();
        return { before: b, after: row };
      });
    } catch (err: any) {
      if ((err?.code === "23505" || err?.cause?.code === "23505")) {
        if (attempt === 0) continue;
        throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
      }
      throw err;
    }
  }
  throw new HttpError(409, "Sorry, that time was just taken. Please pick another slot.");
}

const STAFF_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
};

export async function setBookingStatus(id: string, status: "confirmed" | "completed" | "no_show" | "cancelled", reason?: string) {
  if (status === "cancelled") return cancelBooking(id, "staff", reason);
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update").limit(1);
    if (!b) throw new HttpError(404, "Booking not found");
    if (b.status === status) return b; // idempotent
    if (!STAFF_TRANSITIONS[b.status]?.includes(status)) {
      throw new HttpError(409, `Can't change a ${b.status.replace("_", " ")} appointment to ${status.replace("_", " ")}`);
    }
    if ((status === "completed" || status === "no_show") && nowSlotEAT() < `${b.slotDate} ${hhmm(b.slotTime)}`) {
      throw new HttpError(409, "That appointment hasn't happened yet");
    }
    const [row] = await tx.update(bookings).set({ status }).where(eq(bookings.id, id)).returning();
    return row;
  });
}

/** Live bookings that sit on a day a doctor is about to be blocked (so reception can move them). */
export async function bookingsInRange(doctorId: string, from: string, to: string) {
  return bookingQuery().where(and(eq(bookings.doctorId, doctorId), gte(bookings.slotDate, from), lte(bookings.slotDate, to), inArray(bookings.status, [...LIVE_STATUSES])))
    .orderBy(asc(bookings.slotDate), asc(bookings.slotTime));
}
