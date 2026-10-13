import { Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, admissions, dischargeSummaries, visits, patients, users, departments, doctors, staff, consultations, invoices } from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getDoctorByUserId, getPatientByUserId, isStaff } from "../utils/access";
import { audit } from "../utils/audit";
import { idFirstName, idLastName } from "../utils/patientIdentity";
import { activeGrant, resolveAccess, whoAmI } from "../utils/patientAccess";
import { dateStr, isUuid, todayEAT, uuid } from "../utils/validation";

const CLINICAL_ROLES = ["nurse", "doctor"];
const WARD_EDIT_ROLES = ["nurse", "doctor", "admin"];

export const DISCHARGE_CONDITIONS = ["Recovered", "Improved", "Stable", "Unchanged", "Referred to another facility", "Left against medical advice"] as const;

const doctorUser = alias(users, "admitting_doctor_user");
const dischargeUser = alias(users, "discharging_doctor_user");

// What is still owed for this stay (invoices raised against the admission's visit; waived invoices owe nothing).
const stayOutstanding = sql<string>`coalesce((select sum(${invoices.totalAmount} - ${invoices.paidAmount}) from ${invoices} where ${invoices.visitId} = ${admissions.visitId} and ${invoices.paymentStatus} <> 'waived'), 0)`;

/** Clinicians see their own department's ward; everyone else on staff (front desk, billing, admin) sees all. */
async function canSeeAdmission(req: ClerkRequest, a: { departmentId: string; admittedBy: string }) {
  const { role, dbUserId } = req.clerkUser!;
  if (!CLINICAL_ROLES.includes(role)) return true;
  const me = await whoAmI(dbUserId, role);
  return (!!me.departmentId && me.departmentId === a.departmentId) || (!!me.doctorId && me.doctorId === a.admittedBy);
}

// ── Admit ────────────────────────────────────────────────────────────────────
const admitSchema = z.object({
  visitId: uuid,
  ward: z.string().trim().min(1, "Enter the ward").max(100),
  bedNumber: z.string().trim().max(20).optional(),
}).strict();

export const admitPatient = async (req: ClerkRequest, res: Response) => {
  try {
    if (req.clerkUser!.role !== "doctor") return sendError(res, "Only doctors can admit patients", 403);
    const parsed = admitSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    if (!doctor) return sendError(res, "You don't have a doctor profile yet. Ask an admin to set it up.", 403);

    const admission = await db.transaction(async (tx) => {
      const [visit] = await tx.select().from(visits).where(eq(visits.id, d.visitId)).limit(1);
      if (!visit) throw new HttpError(404, "Visit not found");
      if (visit.assignedDoctorId !== doctor.id || visit.departmentId !== doctor.departmentId) {
        throw new HttpError(403, "You can only admit patients you are treating");
      }
      if (!["in_progress", "completed"].includes(visit.status)) throw new HttpError(409, "Pick the patient up before admitting them");

      // Serialise per patient so two doctors can't admit the same person at once.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`admit:${visit.patientId}`}))`);
      const [active] = await tx.select({ id: admissions.id }).from(admissions)
        .where(and(eq(admissions.patientId, visit.patientId), eq(admissions.admissionStatus, "admitted"))).limit(1);
      if (active) throw new HttpError(409, "This patient is already admitted");

      const [row] = await tx.insert(admissions).values({
        patientId: visit.patientId, visitId: visit.id, departmentId: visit.departmentId,
        admittedBy: doctor.id, ward: d.ward, bedNumber: d.bedNumber || null,
      }).returning();
      return row;
    });

    await audit(req, "admission.created", "admissions", admission.id, null, { patientId: admission.patientId, ward: admission.ward, bed: admission.bedNumber });
    return sendSuccess(res, admission, "Patient admitted", 201);
  } catch (err) {
    return handleError(res, err, "admitPatient");
  }
};

// ── List / detail ────────────────────────────────────────────────────────────
export const listAdmissions = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req) || ["lab_technician", "radiographer", "pharmacist"].includes(req.clerkUser!.role)) return sendError(res, "Access denied", 403);
    const { role, dbUserId } = req.clerkUser!;

    const status = req.query.status === "discharged" ? "discharged" : "admitted";
    let departmentId: string | undefined = isUuid(req.query.departmentId) ? String(req.query.departmentId) : undefined;
    let myDoctorId: string | null = null;
    if (CLINICAL_ROLES.includes(role)) {
      const me = await whoAmI(dbUserId, role);
      myDoctorId = me.doctorId;
      departmentId = me.departmentId ?? undefined;
      if (!departmentId && !myDoctorId) return sendSuccess(res, []);
    }

    const rows = await db
      .select({
        id: admissions.id, status: admissions.admissionStatus, ward: admissions.ward, bedNumber: admissions.bedNumber,
        admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt, admittedBy: admissions.admittedBy,
        departmentId: admissions.departmentId, department: departments.name, visitId: admissions.visitId,
        patientId: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
        firstName: idFirstName, lastName: idLastName,
        doctorFirstName: doctorUser.firstName, doctorLastName: doctorUser.lastName,
        outstanding: stayOutstanding,
      })
      .from(admissions)
      .innerJoin(patients, eq(admissions.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(departments, eq(admissions.departmentId, departments.id))
      .innerJoin(doctors, eq(admissions.admittedBy, doctors.id))
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(doctorUser, eq(staff.userId, doctorUser.id))
      .where(and(
        eq(admissions.admissionStatus, status),
        departmentId ? eq(admissions.departmentId, departmentId) : undefined,
      ))
      .orderBy(status === "admitted" ? admissions.admittedAt : desc(admissions.dischargedAt))
      .limit(status === "discharged" ? 100 : 500);

    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listAdmissions");
  }
};

export const getAdmission = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req) || ["lab_technician", "radiographer", "pharmacist"].includes(req.clerkUser!.role)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Admission not found", 404);

    const [a] = await db.select().from(admissions).where(eq(admissions.id, id)).limit(1);
    if (!a || !(await canSeeAdmission(req, a))) return sendError(res, "Admission not found", 404);

    const [patient] = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
        allergies: patients.allergies, bloodGroup: patients.bloodGroup, firstName: idFirstName, lastName: idLastName,
      })
      .from(patients).leftJoin(users, eq(patients.userId, users.id)).where(eq(patients.id, a.patientId)).limit(1);

    const [dept] = await db.select({ name: departments.name }).from(departments).where(eq(departments.id, a.departmentId)).limit(1);
    const [adm] = await db.select({ firstName: doctorUser.firstName, lastName: doctorUser.lastName })
      .from(doctors).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(doctorUser, eq(staff.userId, doctorUser.id))
      .where(eq(doctors.id, a.admittedBy)).limit(1);

    const access = await resolveAccess(req, a.patientId);
    const clinical = access.level === "clinical" || access.level === "triage";
    const isClinical = access.level === "clinical";

    // Allergies are clinical: only people with at least triage-level access see them.
    const safePatient = clinical ? patient : { ...patient, allergies: null, bloodGroup: null };

    const [summary] = await db.select().from(dischargeSummaries).where(eq(dischargeSummaries.admissionId, a.id)).limit(1);
    let dischargedByName: string | null = null;
    if (summary && clinical) {
      const [u] = await db.select({ firstName: dischargeUser.firstName, lastName: dischargeUser.lastName })
        .from(doctors).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(dischargeUser, eq(staff.userId, dischargeUser.id))
        .where(eq(doctors.id, summary.dischargedBy)).limit(1);
      dischargedByName = u ? `Dr. ${u.firstName} ${u.lastName}` : null;
    }

    // Suggestions for the discharge form, from the doctor's own consultation notes (clinical access only).
    let prefill: { finalDiagnosis: string | null; treatmentGiven: string | null } | null = null;
    if (isClinical && a.admissionStatus === "admitted") {
      const [c] = await db.select({ diagnosis: consultations.diagnosis, treatmentPlan: consultations.treatmentPlan }).from(consultations)
        .where(eq(consultations.visitId, a.visitId)).orderBy(desc(consultations.createdAt)).limit(1);
      prefill = c ? { finalDiagnosis: c.diagnosis, treatmentGiven: c.treatmentPlan } : null;
    }

    // Money is not clinical: everyone who can open the admission sees what is owed for the stay.
    const bills = await db.select({
      id: invoices.id, invoiceNumber: invoices.invoiceNumber, totalAmount: invoices.totalAmount,
      paidAmount: invoices.paidAmount, paymentStatus: invoices.paymentStatus,
    }).from(invoices).where(eq(invoices.visitId, a.visitId)).orderBy(desc(invoices.createdAt));

    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    const grant = doctor ? await activeGrant(req.clerkUser!.dbUserId, a.patientId) : null;
    const canDischarge = a.admissionStatus === "admitted" && !!doctor && (a.admittedBy === doctor.id || !!grant);
    const canEditBed = a.admissionStatus === "admitted" && WARD_EDIT_ROLES.includes(req.clerkUser!.role);

    return sendSuccess(res, {
      admission: a, department: dept?.name ?? null, admittedByName: adm ? `Dr. ${adm.firstName} ${adm.lastName}` : null,
      patient: safePatient,
      summary: clinical ? (summary ?? null) : null,
      dischargedByName, prefill, bills, conditions: DISCHARGE_CONDITIONS,
      canDischarge, canEditBed, hasSummary: !!summary,
    });
  } catch (err) {
    return handleError(res, err, "getAdmission");
  }
};

// ── Move bed / ward ──────────────────────────────────────────────────────────
const bedSchema = z.object({
  ward: z.string().trim().min(1, "Enter the ward").max(100),
  bedNumber: z.string().trim().max(20).optional(),
}).strict();

export const updateAdmissionBed = async (req: ClerkRequest, res: Response) => {
  try {
    if (!WARD_EDIT_ROLES.includes(req.clerkUser!.role)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Admission not found", 404);
    const parsed = bedSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const [a] = await db.select().from(admissions).where(eq(admissions.id, id)).limit(1);
    if (!a || !(await canSeeAdmission(req, a))) return sendError(res, "Admission not found", 404);

    const [updated] = await db.update(admissions)
      .set({ ward: parsed.data.ward, bedNumber: parsed.data.bedNumber || null })
      .where(and(eq(admissions.id, id), eq(admissions.admissionStatus, "admitted"))).returning();
    if (!updated) return sendError(res, "This patient is no longer admitted", 409);

    await audit(req, "admission.bed_changed", "admissions", id, { ward: a.ward, bed: a.bedNumber }, { ward: updated.ward, bed: updated.bedNumber });
    return sendSuccess(res, updated, "Bed updated");
  } catch (err) {
    return handleError(res, err, "updateAdmissionBed");
  }
};

// ── Discharge ────────────────────────────────────────────────────────────────
// Discharge is a clinical decision and is never blocked by an unpaid bill: the balance stays on the
// invoice for the billing desk to follow up. (Detaining a patient over a bill is not allowed.)
const dischargeSchema = z.object({
  finalDiagnosis: z.string().trim().min(1, "Enter the final diagnosis").max(5000),
  treatmentGiven: z.string().trim().min(1, "Describe the treatment given").max(10000),
  conditionOnDischarge: z.enum(DISCHARGE_CONDITIONS),
  followUpInstructions: z.string().trim().max(5000).optional(),
  followUpDate: dateStr.nullable().optional(),
}).strict();

export const dischargePatient = async (req: ClerkRequest, res: Response) => {
  try {
    if (req.clerkUser!.role !== "doctor") return sendError(res, "Only doctors can discharge patients", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Admission not found", 404);
    const parsed = dischargeSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    if (d.followUpDate && d.followUpDate < todayEAT()) return sendError(res, "The follow-up date can't be in the past", 422);

    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    if (!doctor) return sendError(res, "You don't have a doctor profile yet. Ask an admin to set it up.", 403);

    const result = await db.transaction(async (tx) => {
      const [a] = await tx.select().from(admissions).where(eq(admissions.id, id)).for("update");
      if (!a) throw new HttpError(404, "Admission not found");
      if (a.admissionStatus !== "admitted") throw new HttpError(409, "This patient has already been discharged");

      // Same rule as the rest of the clinical record: the admitting doctor, or a doctor they shared the record with.
      if (a.admittedBy !== doctor.id) {
        const grant = await activeGrant(req.clerkUser!.dbUserId, a.patientId);
        if (!grant) throw new HttpError(403, "Only the admitting doctor can discharge this patient. Ask them to share the record with you.");
      }

      const [summary] = await tx.insert(dischargeSummaries).values({
        admissionId: a.id, patientId: a.patientId, dischargedBy: doctor.id,
        finalDiagnosis: d.finalDiagnosis, treatmentGiven: d.treatmentGiven, conditionOnDischarge: d.conditionOnDischarge,
        followUpInstructions: d.followUpInstructions || null, followUpDate: d.followUpDate ?? null,
      }).returning();

      const now = new Date();
      await tx.update(admissions).set({ admissionStatus: "discharged", dischargedAt: now }).where(eq(admissions.id, a.id));

      // Close the visit if it is still open.
      await tx.update(visits).set({ status: "completed", departedAt: now })
        .where(and(eq(visits.id, a.visitId), inArray(visits.status, ["waiting", "in_triage", "triaged", "in_progress"])));

      const [{ owed }] = await tx.select({ owed: sql<string>`coalesce(sum(${invoices.totalAmount} - ${invoices.paidAmount}), 0)` })
        .from(invoices).where(and(eq(invoices.visitId, a.visitId), sql`${invoices.paymentStatus} <> 'waived'`));
      const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(invoices).where(eq(invoices.visitId, a.visitId));

      return { summaryId: summary.id as string, patientId: a.patientId as string, visitId: a.visitId as string, outstanding: owed, invoiceCount: Number(n) };
    });

    await audit(req, "admission.discharged", "admissions", id, null, { patientId: result.patientId, condition: d.conditionOnDischarge });
    return sendSuccess(res, result, "Patient discharged", 201);
  } catch (err) {
    return handleError(res, err, "dischargePatient");
  }
};

// ── The patient's own stays ──────────────────────────────────────────────────
export const getMyAdmissions = async (req: ClerkRequest, res: Response) => {
  try {
    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const rows = await db
      .select({
        id: admissions.id, status: admissions.admissionStatus, ward: admissions.ward, bedNumber: admissions.bedNumber,
        admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt, department: departments.name,
        admittedByFirst: doctorUser.firstName, admittedByLast: doctorUser.lastName,
        summaryId: dischargeSummaries.id, finalDiagnosis: dischargeSummaries.finalDiagnosis, treatmentGiven: dischargeSummaries.treatmentGiven,
        conditionOnDischarge: dischargeSummaries.conditionOnDischarge, followUpInstructions: dischargeSummaries.followUpInstructions,
        followUpDate: dischargeSummaries.followUpDate,
      })
      .from(admissions)
      .innerJoin(departments, eq(admissions.departmentId, departments.id))
      .innerJoin(doctors, eq(admissions.admittedBy, doctors.id))
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(doctorUser, eq(staff.userId, doctorUser.id))
      .leftJoin(dischargeSummaries, eq(dischargeSummaries.admissionId, admissions.id))
      .where(eq(admissions.patientId, patient.id))
      .orderBy(desc(admissions.admittedAt));

    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "getMyAdmissions");
  }
};
