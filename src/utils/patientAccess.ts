import { and, desc, eq, gt, gte, isNull, lte, notInArray, or, sql, SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, accessGrants, admissions, appointments, consultations, doctors, staff, users, visits } from "../db";
import type { ClerkRequest } from "../middleware/clerk.middleware";
import { getDoctorByUserId, getStaffByUserId } from "./access";
import { todayEAT } from "./validation";

/**
 * Who may see what about a patient.
 *   minimal  – identity only (name + patient number).
 *   basic    – demographics, insurance and appointment times; no clinical detail. Front desk, billing, admins.
 *   triage   – basic + allergies and blood group. Nurses who have the patient in their department right now.
 *   clinical – the full file. ONLY the patient's primary doctor, doctors the primary doctor has shared the record
 *              with, or someone using audited emergency access. Being in the same department is NOT enough.
 */
export type AccessLevel = "minimal" | "basic" | "triage" | "clinical";

export const FRONT_DESK_ROLES = ["receptionist", "billing_officer"];
export const BREAK_GLASS_ROLES = ["doctor", "nurse", "admin", "pharmacist", "lab_technician", "radiographer"];
export const BREAK_GLASS_HOURS = 4;
export const SHARE_HOURS = 24;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function whoAmI(userId: string, role: string) {
  const doc = role === "doctor" ? await getDoctorByUserId(userId) : null;
  if (doc) return { doctorId: doc.id as string | null, departmentId: doc.departmentId as string | null };
  const st = await getStaffByUserId(userId);
  return { doctorId: null as string | null, departmentId: (st?.departmentId ?? null) as string | null };
}

/** Why this doctor is the patient's PRIMARY doctor right now, or null. */
export async function primaryReason(userId: string, patientId: string): Promise<string | null> {
  const doc = await getDoctorByUserId(userId);
  if (!doc) return null;
  const today = todayEAT();

  const [treating] = await db.select({ id: visits.id }).from(visits)
    .where(and(eq(visits.patientId, patientId), eq(visits.assignedDoctorId, doc.id), isNull(visits.departedAt))).limit(1);
  if (treating) return "Treating this patient";

  const [booked] = await db.select({ id: appointments.id }).from(appointments)
    .where(and(
      eq(appointments.patientId, patientId), eq(appointments.doctorId, doc.id),
      notInArray(appointments.status, ["cancelled", "no_show"]),
      gte(appointments.appointmentDate, addDays(today, -90)), lte(appointments.appointmentDate, addDays(today, 14)),
    )).limit(1);
  if (booked) return "Booked with you";

  const since = new Date(Date.now() - 90 * 86_400_000);
  const [recent] = await db.select({ id: consultations.id }).from(consultations)
    .where(and(eq(consultations.patientId, patientId), eq(consultations.doctorId, doc.id), gte(consultations.createdAt, since))).limit(1);
  if (recent) return "Your patient (seen in the last 90 days)";
  return null;
}

/** Nurses (triage and ward care): the patient is in their department right now. Gives the "triage" level only. */
async function nurseReason(userId: string, patientId: string): Promise<string | null> {
  const st = await getStaffByUserId(userId);
  const deptId = st?.departmentId;
  if (!deptId) return null;
  const [openVisit] = await db.select({ id: visits.id }).from(visits)
    .where(and(eq(visits.patientId, patientId), eq(visits.departmentId, deptId), isNull(visits.departedAt))).limit(1);
  if (openVisit) return "In your department now";
  const [admitted] = await db.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.departmentId, deptId), isNull(admissions.dischargedAt))).limit(1);
  return admitted ? "Admitted in your department" : null;
}

export async function activeGrant(userId: string, patientId: string) {
  const [grant] = await db.select().from(accessGrants)
    .where(and(eq(accessGrants.userId, userId), eq(accessGrants.patientId, patientId), gt(accessGrants.expiresAt, new Date())))
    .orderBy(desc(accessGrants.expiresAt)).limit(1);
  return grant ?? null;
}

export async function resolveAccess(req: ClerkRequest, patientId: string): Promise<{ level: AccessLevel; reason?: string; expiresAt?: Date }> {
  const { role, dbUserId } = req.clerkUser!;
  if (FRONT_DESK_ROLES.includes(role)) return { level: "basic", reason: "Front desk / billing access" };

  const grant = await activeGrant(dbUserId, patientId);
  if (grant) return { level: "clinical", reason: grant.kind === "shared" ? grant.reason : "Emergency access", expiresAt: grant.expiresAt };

  if (role === "doctor") {
    const reason = await primaryReason(dbUserId, patientId);
    if (reason) return { level: "clinical", reason };
  }
  if (role === "nurse") {
    const reason = await nurseReason(dbUserId, patientId);
    if (reason) return { level: "triage", reason };
  }
  // Admins run the hospital, they don't treat patients: demographics yes, clinical record only via emergency access.
  return { level: role === "admin" ? "basic" : "minimal" };
}

/** The doctor currently treating this patient (the person to ask for access), or null. */
export async function primaryDoctorFor(patientId: string) {
  const docUser = alias(users, "primary_doctor_user");
  const [row] = await db
    .select({ doctorId: doctors.id, userId: docUser.id, firstName: docUser.firstName, lastName: docUser.lastName, departmentId: visits.departmentId })
    .from(visits)
    .innerJoin(doctors, eq(visits.assignedDoctorId, doctors.id))
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .innerJoin(docUser, eq(staff.userId, docUser.id))
    .where(and(eq(visits.patientId, patientId), isNull(visits.departedAt)))
    .orderBy(sql`(${visits.status} = 'in_progress') desc`, desc(visits.arrivedAt))
    .limit(1);
  return row ?? null;
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
