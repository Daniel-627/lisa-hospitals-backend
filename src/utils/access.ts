import { eq, sql } from "drizzle-orm";
import { db, patients, staff, doctors } from "../db";
import type { ClerkRequest, UserRole } from "../middleware/clerk.middleware";

export const STAFF_ROLES: UserRole[] = [
  "doctor", "nurse", "receptionist", "lab_technician",
  "radiographer", "pharmacist", "billing_officer", "admin",
];

export const hasRole = (req: ClerkRequest, ...roles: UserRole[]) =>
  !!req.clerkUser && roles.includes(req.clerkUser.role);

export const isStaff = (req: ClerkRequest) => hasRole(req, ...STAFF_ROLES);

// `ex` lets callers pass a transaction.
export async function getPatientByUserId(userId: string, ex: any = db) {
  const [p] = await ex.select().from(patients).where(eq(patients.userId, userId)).limit(1);
  return (p ?? null) as typeof patients.$inferSelect | null;
}

export async function getStaffByUserId(userId: string, ex: any = db) {
  const [s] = await ex.select().from(staff).where(eq(staff.userId, userId)).limit(1);
  return (s ?? null) as typeof staff.$inferSelect | null;
}

export async function getDoctorByUserId(userId: string, ex: any = db) {
  const [d] = await ex
    .select({ id: doctors.id, staffId: staff.id, departmentId: doctors.departmentId })
    .from(doctors)
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .where(eq(staff.userId, userId))
    .limit(1);
  return (d ?? null) as { id: string; staffId: string; departmentId: string } | null;
}

type Seq = "patient_number_seq" | "invoice_number_seq" | "visit_number_seq";

/** Collision-free human-readable numbers from a DB sequence (see migrations/001). */
export async function nextNumber(prefix: string, seq: Seq, width: number, ex: any = db) {
  const res: any = await ex.execute(sql`select nextval(${sql.raw(`'${seq}'`)}) as n`);
  const rows = res.rows ?? res; // node-postgres returns {rows}, postgres-js returns an array
  return `${prefix}-${String(rows[0].n).padStart(width, "0")}`;
}
