import { desc, eq, inArray, ne, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, consultations, prescriptions, visits, departments, doctors, staff, users } from "../db";

const doctorUser = alias(users, "history_doctor_user");

/**
 * A patient's past consultations, newest first, with the medicines prescribed.
 * Only call this for someone who already has clinical access to the patient (see utils/patientAccess).
 */
export async function consultationHistory(patientId: string, opts: { limit?: number; excludeVisitId?: string } = {}) {
  const rows = await db
    .select({
      id: consultations.id, createdAt: consultations.createdAt, diagnosis: consultations.diagnosis, icdCode: consultations.icdCode,
      clinicalNotes: consultations.clinicalNotes, treatmentPlan: consultations.treatmentPlan, followUpDate: consultations.followUpDate,
      department: departments.name, doctorFirst: doctorUser.firstName, doctorLast: doctorUser.lastName,
    })
    .from(consultations)
    .innerJoin(visits, eq(consultations.visitId, visits.id))
    .innerJoin(departments, eq(visits.departmentId, departments.id))
    .innerJoin(doctors, eq(consultations.doctorId, doctors.id))
    .innerJoin(staff, eq(doctors.staffId, staff.id))
    .innerJoin(doctorUser, eq(staff.userId, doctorUser.id))
    .where(opts.excludeVisitId
      ? and(eq(consultations.patientId, patientId), ne(consultations.visitId, opts.excludeVisitId))
      : eq(consultations.patientId, patientId))
    .orderBy(desc(consultations.createdAt))
    .limit(opts.limit ?? 20);

  const meds = rows.length
    ? await db.select({
        consultationId: prescriptions.consultationId, drugName: prescriptions.drugName, dosage: prescriptions.dosage,
        frequency: prescriptions.frequency, duration: prescriptions.duration, instructions: prescriptions.instructions, isDispensed: prescriptions.isDispensed,
      }).from(prescriptions).where(inArray(prescriptions.consultationId, rows.map((r) => r.id)))
    : [];

  return rows.map((r) => ({
    id: r.id, date: r.createdAt, diagnosis: r.diagnosis, icdCode: r.icdCode, clinicalNotes: r.clinicalNotes,
    treatmentPlan: r.treatmentPlan, followUpDate: r.followUpDate, department: r.department,
    doctor: `Dr. ${r.doctorFirst} ${r.doctorLast}`,
    medicines: meds.filter((m) => m.consultationId === r.id),
  }));
}
