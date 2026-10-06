import { and, eq, gt, gte, isNull, lte, notInArray, or, inArray, SQL } from "drizzle-orm";
import { db, accessGrants, admissions, appointments, consultations, visits } from "../db";
import type { ClerkRequest } from "../middleware/clerk.middleware";
import { getDoctorByUserId, getStaffByUserId } from "./access";
import { todayEAT } from "./validation";

/**
 * Who may see what about a patient.
 *   minimal  – identity only (name + patient number). Enough to find the right person, nothing clinical.
 *   basic    – demographics, insurance and appointment times (NO reasons, allergies, blood group or documents).
 *              Front desk, billing and admins.
 *   clinical – the full file. Doctors/nurses only while they have a reason to be treating the patient
 *              (see careRelationship) or a time-limited, audited emergency grant.
 */
export type AccessLevel = "minimal" | "basic" | "clinical";

export const FRONT_DESK_ROLES = ["receptionist", "billing_officer"];
export const BREAK_GLASS_ROLES = ["doctor", "nurse", "admin", "pharmacist", "lab_technician", "radiographer"];
export const BREAK_GLASS_HOURS = 4;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function whoAmI(userId: string, role: string) {
  const doc = role === "doctor" ? await getDoctorByUserId(userId) : null;
  if (doc) return { doctorId: doc.id as string | null, departmentId: doc.departmentId as string | null };
  const st = await getStaffByUserId(userId);
  return { doctorId: null as string | null, departmentId: (st?.departmentId ?? null) as string | null };
}

/** A concrete, explainable reason this clinician is currently caring for the patient, or null. */
async function careRelationship(userId: string, role: string, patientId: string): Promise<string | null> {
  const { doctorId, departmentId } = await whoAmI(userId, role);
  const today = todayEAT();

  if (doctorId) {
    const [prior] = await db.select({ id: consultations.id }).from(consultations)
      .where(and(eq(consultations.patientId, patientId), eq(consultations.doctorId, doctorId))).limit(1);
    if (prior) return "Your patient (previous consultation)";

    const [booked] = await db.select({ id: appointments.id }).from(appointments)
      .where(and(
        eq(appointments.patientId, patientId), eq(appointments.doctorId, doctorId),
        notInArray(appointments.status, ["cancelled", "no_show"]),
        gte(appointments.appointmentDate, addDays(today, -90)), lte(appointments.appointmentDate, addDays(today, 14)),
      )).limit(1);
    if (booked) return "Booked with you";
  }

  if (departmentId) {
    const [queued] = await db.select({ id: appointments.id }).from(appointments)
      .where(and(
        eq(appointments.patientId, patientId), eq(appointments.departmentId, departmentId), isNull(appointments.doctorId),
        inArray(appointments.status, ["pending", "confirmed"]),
        gte(appointments.appointmentDate, addDays(today, -1)), lte(appointments.appointmentDate, addDays(today, 1)),
      )).limit(1);
    if (queued) return "Booked in your department today";

    const [openVisit] = await db.select({ id: visits.id }).from(visits)
      .where(and(eq(visits.patientId, patientId), eq(visits.departmentId, departmentId), isNull(visits.departedAt))).limit(1);
    if (openVisit) return "In your department now (open visit)";

    const [admitted] = await db.select({ id: admissions.id }).from(admissions)
      .where(and(eq(admissions.patientId, patientId), eq(admissions.departmentId, departmentId), isNull(admissions.dischargedAt))).limit(1);
    if (admitted) return "Admitted in your department";
  }
  return null;
}

export async function resolveAccess(req: ClerkRequest, patientId: string): Promise<{ level: AccessLevel; reason?: string; expiresAt?: Date }> {
  const { role, dbUserId } = req.clerkUser!;
  if (FRONT_DESK_ROLES.includes(role)) return { level: "basic", reason: "Front desk / billing access" };

  const [grant] = await db.select().from(accessGrants)
    .where(and(eq(accessGrants.userId, dbUserId), eq(accessGrants.patientId, patientId), gt(accessGrants.expiresAt, new Date()))).limit(1);
  if (grant) return { level: "clinical", reason: "Emergency access", expiresAt: grant.expiresAt };

  if (role === "doctor" || role === "nurse") {
    const reason = await careRelationship(dbUserId, role, patientId);
    if (reason) return { level: "clinical", reason };
  }
  // Admins run the hospital, they don't treat patients: demographics yes, clinical record only via emergency access.
  return { level: role === "admin" ? "basic" : "minimal" };
}

/** SQL filter limiting which appointments this staff member may list. undefined = all, null = none. */
export async function appointmentScope(req: ClerkRequest): Promise<SQL | undefined | null> {
  const { role, dbUserId } = req.clerkUser!;
  if (role === "admin" || role === "receptionist") return undefined;
  const { doctorId, departmentId } = await whoAmI(dbUserId, role);
  if (role === "doctor") {
    const parts: SQL[] = [];
    if (doctorId) parts.push(eq(appointments.doctorId, doctorId));
    if (departmentId) parts.push(eq(appointments.departmentId, departmentId));
    return parts.length ? (or(...parts) as SQL) : null;
  }
  if (role === "nurse") return departmentId ? eq(appointments.departmentId, departmentId) : null;
  return null;
}

export async function canSeeAppointment(req: ClerkRequest, appt: { doctorId: string | null; departmentId: string }): Promise<boolean> {
  const { role, dbUserId } = req.clerkUser!;
  if (role === "admin" || role === "receptionist") return true;
  if (role !== "doctor" && role !== "nurse") return false;
  const { doctorId, departmentId } = await whoAmI(dbUserId, role);
  return (!!doctorId && appt.doctorId === doctorId) || (!!departmentId && appt.departmentId === departmentId);
}
