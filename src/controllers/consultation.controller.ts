import { Response } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, visits, patients, users, departments, consultations, prescriptions, triageRecords, appointments } from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getDoctorByUserId } from "../utils/access";
import { audit } from "../utils/audit";
import { idFirstName, idLastName } from "../utils/patientIdentity";
import { consultationHistory } from "../utils/consultationHistory";
import { dateStr, isUuid, todayEAT, uuid } from "../utils/validation";
import { enqueueVisit } from "./visit.controller";

/** Only a doctor of the patient's department may open or write the consultation. */
async function loadForDoctor(req: ClerkRequest, visitId: string) {
  if (req.clerkUser!.role !== "doctor") throw new HttpError(403, "Only doctors can use the consultation screen");
  if (!isUuid(visitId)) throw new HttpError(404, "Visit not found");
  const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
  if (!doctor) throw new HttpError(403, "You don't have a doctor profile yet. Ask an admin to set it up.");
  const [visit] = await db.select().from(visits).where(eq(visits.id, visitId)).limit(1);
  if (!visit) throw new HttpError(404, "Visit not found");
  if (visit.departmentId !== doctor.departmentId) throw new HttpError(403, "This patient is in a different department");
  return { visit, doctor };
}

export const getConsultation = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, doctor } = await loadForDoctor(req, req.params.id);

    const [existing] = await db.select().from(consultations).where(eq(consultations.visitId, visit.id)).limit(1);
    // A closed visit can only be reviewed by the doctor who wrote it.
    if (visit.departedAt && (!existing || existing.doctorId !== doctor.id)) return sendError(res, "This visit is closed", 409);

    const [patient] = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
        dobIsEstimated: patients.dobIsEstimated, allergies: patients.allergies, bloodGroup: patients.bloodGroup,
        firstName: idFirstName, lastName: idLastName,
      })
      .from(patients).leftJoin(users, eq(patients.userId, users.id)).where(eq(patients.id, visit.patientId)).limit(1);

    const [triage] = await db.select().from(triageRecords).where(eq(triageRecords.visitId, visit.id)).orderBy(desc(triageRecords.createdAt)).limit(1);
    const meds = existing ? await db.select().from(prescriptions).where(eq(prescriptions.consultationId, existing.id)) : [];
    const history = await consultationHistory(visit.patientId, { limit: 5, excludeVisitId: visit.id });

    const [dept] = await db.select({ name: departments.name }).from(departments).where(eq(departments.id, visit.departmentId)).limit(1);

    return sendSuccess(res, {
      visit: { id: visit.id, visitNumber: visit.visitNumber, queueNumber: visit.queueNumber, status: visit.status, isPriority: visit.isPriority, reason: visit.reason, department: dept?.name, departmentId: visit.departmentId },
      canEdit: visit.status === "in_progress" && visit.assignedDoctorId === doctor.id,
      patient, triage: triage ?? null,
      consultation: existing ?? null,
      prescriptions: meds,
      history,
    });
  } catch (err) {
    return handleError(res, err, "getConsultation");
  }
};

const rxSchema = z.object({
  drugName: z.string().trim().min(1, "Enter the medicine name").max(200),
  dosage: z.string().trim().min(1, "Enter a dosage for each medicine").max(100),
  frequency: z.string().trim().min(1, "Enter how often for each medicine").max(100),
  duration: z.string().trim().min(1, "Enter how long for each medicine").max(100),
  instructions: z.string().trim().max(1000).optional(),
});

const consultSchema = z.object({
  clinicalNotes: z.string().trim().max(20000).optional(),
  diagnosis: z.string().trim().max(2000).optional(),
  icdCode: z.string().trim().max(20).optional(),
  treatmentPlan: z.string().trim().max(5000).optional(),
  followUpDate: dateStr.nullable().optional(),
  referredTo: uuid.nullable().optional(),
  prescriptions: z.array(rxSchema).max(20).default([]), // only the editable (not yet dispensed) medicines
  complete: z.boolean().optional(),
}).strict();

export const saveConsultation = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, doctor } = await loadForDoctor(req, req.params.id);
    const parsed = consultSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const complete = !!d.complete;

    if (complete && !d.diagnosis && !d.clinicalNotes) return sendError(res, "Add a diagnosis or clinical notes before completing the visit", 422);
    if (d.followUpDate && d.followUpDate < todayEAT()) return sendError(res, "The follow-up date can't be in the past", 422);
    if (d.referredTo && d.referredTo === visit.departmentId) return sendError(res, "Choose a different department to refer to", 422);

    const result = await db.transaction(async (tx) => {
      // Only the doctor who picked the patient up can write, and only while the visit is in progress.
      const [locked] = await tx.select({ id: visits.id }).from(visits)
        .where(and(eq(visits.id, visit.id), eq(visits.status, "in_progress"), eq(visits.assignedDoctorId, doctor.id))).for("update");
      if (!locked) throw new HttpError(409, "Pick this patient up first (or they are with another doctor)");

      if (d.referredTo) {
        const [dept] = await tx.select({ id: departments.id }).from(departments).where(and(eq(departments.id, d.referredTo), eq(departments.isActive, true))).limit(1);
        if (!dept) throw new HttpError(404, "Referral department not found");
      }

      const values = {
        diagnosis: d.diagnosis || null, icdCode: d.icdCode || null, clinicalNotes: d.clinicalNotes || null,
        treatmentPlan: d.treatmentPlan || null, followUpDate: d.followUpDate ?? null, referredTo: d.referredTo ?? null,
      };
      let [row] = await tx.select().from(consultations).where(eq(consultations.visitId, visit.id)).limit(1);
      if (row) [row] = await tx.update(consultations).set(values).where(eq(consultations.id, row.id)).returning();
      else [row] = await tx.insert(consultations).values({ visitId: visit.id, doctorId: doctor.id, patientId: visit.patientId, ...values }).returning();

      // Replace the medicines that haven't been dispensed. Dispensed ones are locked: pharmacy has already handed them over.
      await tx.delete(prescriptions).where(and(eq(prescriptions.consultationId, row.id), eq(prescriptions.isDispensed, false)));
      if (d.prescriptions.length) {
        await tx.insert(prescriptions).values(d.prescriptions.map((m) => ({
          consultationId: row.id, patientId: visit.patientId,
          drugName: m.drugName, dosage: m.dosage, frequency: m.frequency, duration: m.duration, instructions: m.instructions || null,
        })));
      }

      let referral: { department: string; queueNumber: number; existing: boolean } | null = null;
      if (complete) {
        await tx.update(visits).set({ status: "completed", departedAt: new Date() }).where(eq(visits.id, visit.id));
        if (visit.appointmentId) await tx.update(appointments).set({ status: "completed", updatedAt: new Date() }).where(eq(appointments.id, visit.appointmentId));
        if (d.referredTo) {
          const q = await enqueueVisit(tx, { patientId: visit.patientId, departmentId: d.referredTo, reason: "Referred by the consulting doctor", isPriority: visit.isPriority, checkedInBy: req.clerkUser!.dbUserId });
          referral = { department: q.department, queueNumber: q.queueNumber, existing: q.existing };
        }
      }
      return { consultationId: row.id as string, referral };
    });

    await audit(req, complete ? "consultation.completed" : "consultation.saved", "consultations", result.consultationId, null,
      { visitId: visit.id, patientId: visit.patientId, medicines: d.prescriptions.length, referred: !!d.referredTo && complete });
    return sendSuccess(res, { ...result, completed: complete }, complete ? "Visit completed" : "Saved");
  } catch (err) {
    return handleError(res, err, "saveConsultation");
  }
};
