import { z } from "zod";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, appointments, departments, doctors } from "../db";
import { HttpError } from "../utils/errors";
import { dateStr, timeStr, uuid, nowSlotEAT, todayEAT } from "../utils/validation";

export const bookAppointmentSchema = z.object({
  departmentId:    uuid,
  doctorId:        uuid.optional(),
  appointmentDate: dateStr,
  appointmentTime: timeStr,
  reason:          z.string().max(1000).optional(),
});
export type BookInput = z.infer<typeof bookAppointmentSchema>;

const MAX_ADVANCE_DAYS = 180;
const FREE_STATUSES = ["cancelled", "no_show"] as const;

/**
 * Books an appointment. Pass a transaction as `executor` to nest (creates a savepoint).
 * Advisory locks make the conflict checks race-free without needing a unique index.
 */
export async function bookAppointment(patientId: string, input: BookInput, executor: any = db) {
  const { appointmentDate: date, appointmentTime: time } = input;

  if (`${date} ${time}` <= nowSlotEAT()) {
    throw new HttpError(422, "Appointment time must be in the future");
  }
  const daysAhead = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayEAT()}T00:00:00Z`)) / 86_400_000;
  if (daysAhead > MAX_ADVANCE_DAYS) {
    throw new HttpError(422, `Appointments can only be booked up to ${MAX_ADVANCE_DAYS} days ahead`);
  }

  return executor.transaction(async (tx: any) => {
    const [dept] = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.id, input.departmentId), eq(departments.isActive, true)))
      .limit(1);
    if (!dept) throw new HttpError(404, "Department not found");

    if (input.doctorId) {
      const [doc] = await tx
        .select({ id: doctors.id, departmentId: doctors.departmentId })
        .from(doctors)
        .where(and(eq(doctors.id, input.doctorId), eq(doctors.isAvailable, true)))
        .limit(1);
      if (!doc) throw new HttpError(404, "Doctor not found or unavailable");
      if (doc.departmentId !== dept.id) throw new HttpError(422, "Doctor does not belong to that department");
    }

    // Always lock patient first, then doctor, to keep lock order consistent.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appt:p:${patientId}:${date}:${time}`}))`);
    if (input.doctorId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appt:d:${input.doctorId}:${date}:${time}`}))`);
    }

    const [patientClash] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(
        eq(appointments.patientId, patientId),
        eq(appointments.appointmentDate, date),
        eq(appointments.appointmentTime, time),
        notInArray(appointments.status, [...FREE_STATUSES]),
      ))
      .limit(1);
    if (patientClash) throw new HttpError(409, "You already have an appointment at that time");

    if (input.doctorId) {
      const [doctorClash] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(
          eq(appointments.doctorId, input.doctorId),
          eq(appointments.appointmentDate, date),
          eq(appointments.appointmentTime, time),
          notInArray(appointments.status, [...FREE_STATUSES]),
        ))
        .limit(1);
      if (doctorClash) throw new HttpError(409, "That doctor is already booked at that time");
    }

    const [created] = await tx.insert(appointments).values({
      patientId,
      departmentId: input.departmentId,
      doctorId: input.doctorId,
      appointmentDate: date,
      appointmentTime: time,
      reason: input.reason,
      bookedOnline: true,
      status: "pending",
    }).returning();
    return created;
  });
}

/** Cancels an appointment. Pass `patientId` to scope to a patient's own appointments. */
export async function cancelAppointmentRecord(id: string, scope: { patientId?: string } = {}, executor: any = db) {
  const where = scope.patientId
    ? and(eq(appointments.id, id), eq(appointments.patientId, scope.patientId))
    : eq(appointments.id, id);

  const [appt] = await executor.select().from(appointments).where(where).limit(1);
  if (!appt) throw new HttpError(404, "Appointment not found");
  if (appt.status === "cancelled") return appt; // idempotent
  if (appt.status === "completed" || appt.status === "no_show") {
    throw new HttpError(409, `Cannot cancel a ${appt.status.replace("_", " ")} appointment`);
  }

  const [updated] = await executor
    .update(appointments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(appointments.id, id))
    .returning();
  return updated;
}
