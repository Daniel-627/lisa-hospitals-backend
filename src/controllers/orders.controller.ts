import { Response } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db, visits, patients, users, doctors, staff, consultations, prescriptions,
  labOrders, labResults, radiologyOrders, radiologyResults,
} from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getDoctorByUserId, getStaffByUserId } from "../utils/access";
import { audit } from "../utils/audit";
import { idFirstName, idLastName } from "../utils/patientIdentity";
import { ordersForConsultations } from "../utils/orders";
import { autoBill } from "../utils/autoBilling";
import { isUuid } from "../utils/validation";
import { loadForDoctor } from "./consultation.controller";
import { privateFileUrl, signRecords } from "../utils/cloudinary";

const docUser = alias(users, "orders_doctor_user");
const need = (req: ClerkRequest, ...roles: string[]) => {
  if (!roles.includes(req.clerkUser!.role)) throw new HttpError(403, "Access denied");
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

// What a patient looks like on a worklist: enough to find and identify them, nothing from their record.
const patientCols = {
  patientId: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
  firstName: idFirstName, lastName: idLastName,
};

// ═════════════ Doctor: order tests ═════════════
const urgency = z.enum(["1_critical", "2_emergent", "3_urgent", "4_semi_urgent", "5_non_urgent"]);
const placeSchema = z.object({
  lab: z.array(z.object({
    testName: z.string().trim().min(1, "Enter the test name").max(200),
    testCode: z.string().trim().max(50).optional(),
    urgency: urgency.default("5_non_urgent"),
    instructions: z.string().trim().max(1000).optional(),
  })).max(20).default([]),
  radiology: z.array(z.object({
    modality: z.string().trim().min(1, "Choose the imaging type").max(100),
    bodyPart: z.string().trim().max(100).optional(),
    clinicalInfo: z.string().trim().max(2000).optional(),
  })).max(10).default([]),
}).strict();

export const placeOrders = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, doctor } = await loadForDoctor(req, req.params.id);
    const parsed = placeSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    if (!d.lab.length && !d.radiology.length) return sendError(res, "Add at least one test", 422);

    const made = await db.transaction(async (tx) => {
      // Only the treating doctor, and only while the visit is in progress.
      const [locked] = await tx.select({ id: visits.id }).from(visits)
        .where(and(eq(visits.id, visit.id), eq(visits.status, "in_progress"), eq(visits.assignedDoctorId, doctor.id))).for("update");
      if (!locked) throw new HttpError(409, "Pick this patient up first (or they are with another doctor)");

      // Orders hang off the consultation: create it (empty) if the doctor hasn't saved any notes yet.
      let [cons] = await tx.select().from(consultations).where(eq(consultations.visitId, visit.id)).limit(1);
      if (!cons) [cons] = await tx.insert(consultations).values({ visitId: visit.id, doctorId: doctor.id, patientId: visit.patientId }).returning();

      const lab = d.lab.length ? await tx.insert(labOrders).values(d.lab.map((t) => ({
        consultationId: cons.id, patientId: visit.patientId, orderedBy: doctor.id,
        testName: t.testName, testCode: t.testCode || null, urgency: t.urgency, instructions: t.instructions || null,
      }))).returning({ id: labOrders.id }) : [];
      const rad = d.radiology.length ? await tx.insert(radiologyOrders).values(d.radiology.map((t) => ({
        consultationId: cons.id, patientId: visit.patientId, orderedBy: doctor.id,
        modality: t.modality, bodyPart: t.bodyPart || null, clinicalInfo: t.clinicalInfo || null,
      }))).returning({ id: radiologyOrders.id }) : [];
      return { lab: lab.length, radiology: rad.length };
    });

    await audit(req, "orders.placed", "visits", visit.id, null, { patientId: visit.patientId, ...made });
    await autoBill(visit.id); // the tests go straight onto the visit's invoice
    return sendSuccess(res, made, "Orders sent", 201);
  } catch (err) {
    return handleError(res, err, "placeOrders");
  }
};

const kindOf = (k: string) => (k === "lab" ? { table: labOrders } : k === "radiology" ? { table: radiologyOrders } : null);

export const cancelOrder = async (req: ClerkRequest, res: Response) => {
  try {
    const k = kindOf(req.params.kind);
    if (!k || !isUuid(req.params.id)) return sendError(res, "Order not found", 404);
    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    if (!doctor) return sendError(res, "Access denied", 403);
    const t: any = k.table;
    const [updated] = await db.update(t).set({ status: "cancelled" })
      .where(and(eq(t.id, req.params.id), eq(t.orderedBy, doctor.id), eq(t.status, "pending"))).returning({ id: t.id, consultationId: t.consultationId });
    if (!updated) return sendError(res, "Only your own orders that haven't been started can be cancelled", 409);
    const [c] = await db.select({ visitId: consultations.visitId }).from(consultations).where(eq(consultations.id, updated.consultationId)).limit(1);
    await autoBill(c?.visitId); // a cancelled test comes off the invoice
    await audit(req, "orders.cancelled", req.params.kind === "lab" ? "lab_orders" : "radiology_orders", req.params.id, null, null);
    return sendSuccess(res, { id: req.params.id }, "Order cancelled");
  } catch (err) {
    return handleError(res, err, "cancelOrder");
  }
};

// The ordering doctor reviews the result and releases it to the patient.
export const releaseOrder = async (req: ClerkRequest, res: Response) => {
  try {
    const k = kindOf(req.params.kind);
    if (!k || !isUuid(req.params.id)) return sendError(res, "Order not found", 404);
    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    if (!doctor) return sendError(res, "Access denied", 403);
    const t: any = k.table;
    const [updated] = await db.update(t).set({ releasedAt: new Date() })
      .where(and(eq(t.id, req.params.id), eq(t.orderedBy, doctor.id), eq(t.status, "completed"))).returning({ id: t.id });
    if (!updated) return sendError(res, "Only your own completed results can be released", 409);
    await audit(req, "results.released", req.params.kind === "lab" ? "lab_orders" : "radiology_orders", req.params.id, null, null);
    return sendSuccess(res, { id: req.params.id }, "Released to the patient");
  } catch (err) {
    return handleError(res, err, "releaseOrder");
  }
};

// Results waiting for MY review (released=false) or already released (released=true).
export const myOrders = async (req: ClerkRequest, res: Response) => {
  try {
    const doctor = await getDoctorByUserId(req.clerkUser!.dbUserId);
    if (!doctor) return sendError(res, "Access denied", 403);
    const released = req.query.released === "true";

    const labRows = await db.select({ ...patientCols, id: labOrders.id, name: labOrders.testName, status: labOrders.status, urgency: labOrders.urgency, createdAt: labOrders.createdAt, releasedAt: labOrders.releasedAt, consultationId: labOrders.consultationId })
      .from(labOrders).innerJoin(patients, eq(labOrders.patientId, patients.id)).leftJoin(users, eq(patients.userId, users.id))
      .where(and(eq(labOrders.orderedBy, doctor.id), eq(labOrders.status, "completed"))).orderBy(desc(labOrders.createdAt)).limit(100);
    const radRows = await db.select({ ...patientCols, id: radiologyOrders.id, name: radiologyOrders.modality, bodyPart: radiologyOrders.bodyPart, status: radiologyOrders.status, createdAt: radiologyOrders.createdAt, releasedAt: radiologyOrders.releasedAt, consultationId: radiologyOrders.consultationId })
      .from(radiologyOrders).innerJoin(patients, eq(radiologyOrders.patientId, patients.id)).leftJoin(users, eq(patients.userId, users.id))
      .where(and(eq(radiologyOrders.orderedBy, doctor.id), eq(radiologyOrders.status, "completed"))).orderBy(desc(radiologyOrders.createdAt)).limit(100);

    const keepLab = labRows.filter((r) => (released ? !!r.releasedAt : !r.releasedAt));
    const keepRad = radRows.filter((r) => (released ? !!r.releasedAt : !r.releasedAt));
    const labIds = keepLab.map((r) => r.id), radIds = keepRad.map((r) => r.id);
    const labRes = labIds.length ? await db.select().from(labResults).where(inArray(labResults.labOrderId, labIds)) : [];
    const radRes = radIds.length ? signRecords(await db.select().from(radiologyResults).where(inArray(radiologyResults.radiologyOrderId, radIds))) : [];

    const out = [
      ...keepLab.map((r) => ({ kind: "lab", ...r, results: labRes.filter((x) => x.labOrderId === r.id) })),
      ...keepRad.map((r) => ({ kind: "radiology", ...r, results: radRes.filter((x) => x.radiologyOrderId === r.id) })),
    ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return sendSuccess(res, out);
  } catch (err) {
    return handleError(res, err, "myOrders");
  }
};

// ═════════════ Lab ═════════════
export const labWorklist = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "lab_technician");
    const open = inArray(labOrders.status, ["pending", "collected"]);
    const where = req.query.done === "true" ? or(open, and(eq(labOrders.status, "completed"), gte(labOrders.createdAt, hoursAgo(48)))) : open;
    const rows = await db
      .select({ ...patientCols, id: labOrders.id, testName: labOrders.testName, testCode: labOrders.testCode, urgency: labOrders.urgency, instructions: labOrders.instructions, status: labOrders.status, createdAt: labOrders.createdAt, doctorFirst: docUser.firstName, doctorLast: docUser.lastName })
      .from(labOrders)
      .innerJoin(patients, eq(labOrders.patientId, patients.id)).leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(doctors, eq(labOrders.orderedBy, doctors.id)).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(docUser, eq(staff.userId, docUser.id))
      .where(where).orderBy(asc(labOrders.urgency), asc(labOrders.createdAt));
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "labWorklist");
  }
};

export const labCollect = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "lab_technician");
    if (!isUuid(req.params.id)) return sendError(res, "Order not found", 404);
    const [updated] = await db.update(labOrders).set({ status: "collected", collectedAt: new Date() })
      .where(and(eq(labOrders.id, req.params.id), eq(labOrders.status, "pending"))).returning({ id: labOrders.id });
    if (!updated) return sendError(res, "This order is not waiting for a sample", 409);
    await audit(req, "lab.collected", "lab_orders", req.params.id, null, null);
    return sendSuccess(res, { id: req.params.id }, "Sample marked as collected");
  } catch (err) {
    return handleError(res, err, "labCollect");
  }
};

const labResultSchema = z.object({
  results: z.array(z.object({
    analyte: z.string().trim().min(1, "Name each result (for example Haemoglobin)").max(100),
    result: z.string().trim().min(1, "Enter a value for each result").max(500),
    unit: z.string().trim().max(50).optional(),
    referenceRange: z.string().trim().max(100).optional(),
    isAbnormal: z.boolean().optional(),
  })).min(1, "Enter at least one result").max(40),
  notes: z.string().trim().max(2000).optional(),
}).strict();

export const labSubmitResult = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "lab_technician");
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Order not found", 404);
    const parsed = labResultSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const tech = await getStaffByUserId(req.clerkUser!.dbUserId);

    const abnormal = await db.transaction(async (tx) => {
      const [order] = await tx.update(labOrders).set({ status: "completed" })
        .where(and(eq(labOrders.id, id), inArray(labOrders.status, ["pending", "collected"]))).returning({ id: labOrders.id, patientId: labOrders.patientId });
      if (!order) throw new HttpError(409, "This order is already completed or cancelled");
      await tx.insert(labResults).values(d.results.map((r, i) => ({
        labOrderId: id, patientId: order.patientId, processedBy: tech?.id ?? null,
        analyte: r.analyte, result: r.result, unit: r.unit || null, referenceRange: r.referenceRange || null,
        isAbnormal: !!r.isAbnormal, notes: i === 0 ? d.notes || null : null,
      })));
      return d.results.some((r) => r.isAbnormal);
    });

    await audit(req, "lab.resulted", "lab_orders", id, null, { values: d.results.length, abnormal });
    return sendSuccess(res, { id }, "Results saved and sent to the doctor", 201);
  } catch (err) {
    return handleError(res, err, "labSubmitResult");
  }
};

// ═════════════ Radiology ═════════════
export const radiologyWorklist = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "radiographer");
    const where = req.query.done === "true"
      ? or(eq(radiologyOrders.status, "pending"), and(eq(radiologyOrders.status, "completed"), gte(radiologyOrders.createdAt, hoursAgo(48))))
      : eq(radiologyOrders.status, "pending");
    const rows = await db
      .select({ ...patientCols, id: radiologyOrders.id, modality: radiologyOrders.modality, bodyPart: radiologyOrders.bodyPart, clinicalInfo: radiologyOrders.clinicalInfo, status: radiologyOrders.status, createdAt: radiologyOrders.createdAt, doctorFirst: docUser.firstName, doctorLast: docUser.lastName })
      .from(radiologyOrders)
      .innerJoin(patients, eq(radiologyOrders.patientId, patients.id)).leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(doctors, eq(radiologyOrders.orderedBy, doctors.id)).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(docUser, eq(staff.userId, docUser.id))
      .where(where).orderBy(asc(radiologyOrders.createdAt));
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "radiologyWorklist");
  }
};

const radResultSchema = z.object({
  findings: z.string().trim().max(10000).optional(),
  impression: z.string().trim().max(5000).optional(),
  imageUrl: privateFileUrl("Upload the image with the upload button").optional(),
  reportUrl: privateFileUrl("Upload the report with the upload button").optional(),
}).strict();

export const radiologySubmitResult = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "radiographer");
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Order not found", 404);
    const parsed = radResultSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    if (!d.findings && !d.impression) return sendError(res, "Enter the findings or the impression", 422);
    const tech = await getStaffByUserId(req.clerkUser!.dbUserId);

    await db.transaction(async (tx) => {
      const [order] = await tx.update(radiologyOrders).set({ status: "completed" })
        .where(and(eq(radiologyOrders.id, id), eq(radiologyOrders.status, "pending"))).returning({ id: radiologyOrders.id, patientId: radiologyOrders.patientId });
      if (!order) throw new HttpError(409, "This order is already completed or cancelled");
      await tx.insert(radiologyResults).values({
        radiologyOrderId: id, patientId: order.patientId, processedBy: tech?.id ?? null,
        findings: d.findings || null, impression: d.impression || null, imageUrl: d.imageUrl || null, reportUrl: d.reportUrl || null,
      });
    });
    await audit(req, "radiology.resulted", "radiology_orders", id, null, null);
    return sendSuccess(res, { id }, "Report saved and sent to the doctor", 201);
  } catch (err) {
    return handleError(res, err, "radiologySubmitResult");
  }
};

// ═════════════ Pharmacy ═════════════
// Only completed consultations are dispensable: a half-written draft prescription must not reach the counter.
export const pharmacyWorklist = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "pharmacist");
    const todo = and(eq(prescriptions.isDispensed, false), eq(visits.status, "completed"), gte(prescriptions.createdAt, hoursAgo(24 * 7)));
    const where = req.query.done === "true" ? or(todo, and(eq(prescriptions.isDispensed, true), gte(prescriptions.dispensedAt, hoursAgo(24)))) : todo;
    const rows = await db
      .select({
        ...patientCols, allergies: patients.allergies,
        id: prescriptions.id, drugName: prescriptions.drugName, dosage: prescriptions.dosage, frequency: prescriptions.frequency,
        duration: prescriptions.duration, instructions: prescriptions.instructions, isDispensed: prescriptions.isDispensed,
        dispensedAt: prescriptions.dispensedAt, createdAt: prescriptions.createdAt, doctorFirst: docUser.firstName, doctorLast: docUser.lastName,
      })
      .from(prescriptions)
      .innerJoin(consultations, eq(prescriptions.consultationId, consultations.id))
      .innerJoin(visits, eq(consultations.visitId, visits.id))
      .innerJoin(patients, eq(prescriptions.patientId, patients.id)).leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(doctors, eq(consultations.doctorId, doctors.id)).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(docUser, eq(staff.userId, docUser.id))
      .where(where).orderBy(asc(prescriptions.createdAt));
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "pharmacyWorklist");
  }
};

export const dispense = async (req: ClerkRequest, res: Response) => {
  try {
    need(req, "pharmacist");
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Prescription not found", 404);
    const [rx] = await db.select({ id: prescriptions.id, isDispensed: prescriptions.isDispensed, visitStatus: visits.status })
      .from(prescriptions).innerJoin(consultations, eq(prescriptions.consultationId, consultations.id)).innerJoin(visits, eq(consultations.visitId, visits.id))
      .where(eq(prescriptions.id, id)).limit(1);
    if (!rx) return sendError(res, "Prescription not found", 404);
    if (rx.visitStatus !== "completed") return sendError(res, "The doctor hasn't completed this consultation yet", 409);

    const tech = await getStaffByUserId(req.clerkUser!.dbUserId);
    const [updated] = await db.update(prescriptions).set({ isDispensed: true, dispensedAt: new Date(), dispensedBy: tech?.id ?? null })
      .where(and(eq(prescriptions.id, id), eq(prescriptions.isDispensed, false))).returning({ id: prescriptions.id });
    if (!updated) return sendError(res, "Already dispensed", 409);
    await audit(req, "pharmacy.dispensed", "prescriptions", id, null, null);
    return sendSuccess(res, { id }, "Dispensed");
  } catch (err) {
    return handleError(res, err, "dispense");
  }
};

// ═════════════ Patient: my released results ═════════════
export const getMyResults = async (req: ClerkRequest, res: Response) => {
  try {
    const [me] = await db.select({ id: patients.id }).from(patients).where(eq(patients.userId, req.clerkUser!.dbUserId)).limit(1);
    if (!me) return sendError(res, "Patient profile not found", 404);

    const labs = await db.select().from(labOrders).where(and(eq(labOrders.patientId, me.id), eq(labOrders.status, "completed")));
    const rads = await db.select().from(radiologyOrders).where(and(eq(radiologyOrders.patientId, me.id), eq(radiologyOrders.status, "completed")));
    const relLabs = labs.filter((o) => o.releasedAt);
    const relRads = rads.filter((o) => o.releasedAt);
    const labRes = relLabs.length ? await db.select().from(labResults).where(inArray(labResults.labOrderId, relLabs.map((o) => o.id))) : [];
    const radRes = relRads.length ? signRecords(await db.select().from(radiologyResults).where(inArray(radiologyResults.radiologyOrderId, relRads.map((o) => o.id)))) : [];

    const out = [
      ...relLabs.map((o) => ({ kind: "lab", id: o.id, name: o.testName, releasedAt: o.releasedAt, results: labRes.filter((r) => r.labOrderId === o.id).map(({ analyte, result, unit, referenceRange, isAbnormal, notes }) => ({ analyte, result, unit, referenceRange, isAbnormal, notes })) })),
      ...relRads.map((o) => ({ kind: "radiology", id: o.id, name: `${o.modality}${o.bodyPart ? ` · ${o.bodyPart}` : ""}`, releasedAt: o.releasedAt, results: radRes.filter((r) => r.radiologyOrderId === o.id).map(({ findings, impression, imageUrl, reportUrl }) => ({ findings, impression, imageUrl, reportUrl })) })),
    ].sort((a, b) => +new Date(b.releasedAt as any) - +new Date(a.releasedAt as any));
    return sendSuccess(res, out);
  } catch (err) {
    return handleError(res, err, "getMyResults");
  }
};
