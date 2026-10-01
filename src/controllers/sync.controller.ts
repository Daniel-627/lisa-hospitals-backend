import { Response } from "express";
import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import {
  db, syncQueue, appointments, patients, visits, triageRecords,
  consultations, labOrders,
} from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import type { UserRole } from "../middleware/clerk.middleware";
import { HttpError, isUniqueViolation } from "../utils/errors";
import { getDoctorByUserId, getPatientByUserId, getStaffByUserId, nextNumber } from "../utils/access";
import { bookAppointment, bookAppointmentSchema, cancelAppointmentRecord } from "../services/appointments.service";
import { patientProfileUpdateSchema, uuid } from "../utils/validation";

const ACTIONS = [
  "CREATE_APPOINTMENT", "CANCEL_APPOINTMENT", "UPDATE_TRIAGE",
  "CREATE_CONSULTATION", "CREATE_LAB_ORDER", "UPDATE_PATIENT_PROFILE", "CREATE_VISIT",
] as const;
type Action = (typeof ACTIONS)[number];

const syncItemSchema = z.object({
  id:               z.string().min(1).max(100), // client-generated id, used for idempotency
  action:           z.enum(ACTIONS),
  payload:          z.record(z.string(), z.any()),
  createdOfflineAt: z.string().refine((s) => !isNaN(Date.parse(s)), "Invalid createdOfflineAt"),
});

const pushSchema = z.object({
  deviceId: z.string().min(1).max(100),
  queue:    z.array(syncItemSchema).max(100),
});

// ── Who may do what ──────────────────────────────────────────────────────────
const ALLOWED: Record<Action, UserRole[]> = {
  CREATE_APPOINTMENT:     ["patient", "receptionist", "admin"],
  CANCEL_APPOINTMENT:     ["patient", "receptionist", "nurse", "doctor", "admin"],
  UPDATE_PATIENT_PROFILE: ["patient"],
  CREATE_VISIT:           ["receptionist", "nurse", "doctor", "admin"],
  UPDATE_TRIAGE:          ["nurse", "doctor", "admin"],
  CREATE_CONSULTATION:    ["doctor"],
  CREATE_LAB_ORDER:       ["doctor"],
};

// ── Payload schemas (never spread raw payloads into the DB) ──────────────────
const urgency = z.enum(["1_critical", "2_emergent", "3_urgent", "4_semi_urgent", "5_non_urgent"]);
const num = (min: number, max: number) => z.number().min(min).max(max).transform(String).optional();

const schemas = {
  CREATE_APPOINTMENT: bookAppointmentSchema.extend({ patientId: uuid.optional() }),
  CANCEL_APPOINTMENT: z.object({ appointmentId: uuid }),
  UPDATE_PATIENT_PROFILE: patientProfileUpdateSchema,
  CREATE_VISIT: z.object({
    patientId: uuid, departmentId: uuid, appointmentId: uuid.optional(),
    arrivedAt: z.string().refine((s) => !isNaN(Date.parse(s))).optional(),
  }),
  UPDATE_TRIAGE: z.object({
    visitId: uuid,
    temperature: num(25, 45), pulseRate: z.number().int().min(0).max(300).optional(),
    weight: num(0, 500), height: num(0, 300), oxygenSaturation: num(0, 100),
    bloodPressure: z.string().regex(/^\d{2,3}\/\d{2,3}$/).optional(),
    urgencyLevel: urgency.optional(),
    chiefComplaint: z.string().max(2000).optional(),
  }),
  CREATE_CONSULTATION: z.object({
    visitId: uuid,
    diagnosis: z.string().max(4000).optional(),
    clinicalNotes: z.string().max(10000).optional(),
    treatmentPlan: z.string().max(4000).optional(),
    followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  CREATE_LAB_ORDER: z.object({
    consultationId: uuid,
    testName: z.string().trim().min(1).max(200),
    testCode: z.string().max(50).optional(),
    urgency: urgency.optional(),
    instructions: z.string().max(2000).optional(),
  }),
} as const;

type Ctx = { userId: string; role: UserRole };

async function processAction(tx: any, ctx: Ctx, action: Action, rawPayload: unknown) {
  if (!ALLOWED[action].includes(ctx.role)) throw new HttpError(403, "Not permitted to perform this action");

  const parsed = (schemas[action] as z.ZodTypeAny).safeParse(rawPayload);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues[0].message);
  const p: any = parsed.data;

  switch (action) {
    case "CREATE_APPOINTMENT": {
      let patientId: string;
      if (ctx.role === "patient") {
        const me = await getPatientByUserId(ctx.userId, tx);
        if (!me) throw new HttpError(404, "Patient not found");
        patientId = me.id;
      } else {
        if (!p.patientId) throw new HttpError(422, "patientId is required");
        patientId = p.patientId;
      }
      const { patientId: _ignored, ...input } = p;
      await bookAppointment(patientId, input, tx);
      return;
    }

    case "CANCEL_APPOINTMENT": {
      if (ctx.role === "patient") {
        const me = await getPatientByUserId(ctx.userId, tx);
        if (!me) throw new HttpError(404, "Patient not found");
        await cancelAppointmentRecord(p.appointmentId, { patientId: me.id }, tx); // ownership enforced
      } else {
        await cancelAppointmentRecord(p.appointmentId, {}, tx);
      }
      return;
    }

    case "UPDATE_PATIENT_PROFILE": {
      const me = await getPatientByUserId(ctx.userId, tx);
      if (!me) throw new HttpError(404, "Patient not found");
      if (Object.keys(p).length === 0) throw new HttpError(422, "Nothing to update");
      await tx.update(patients).set({ ...p, updatedAt: new Date() }).where(eq(patients.id, me.id));
      return;
    }

    case "CREATE_VISIT": {
      await tx.insert(visits).values({
        patientId: p.patientId,
        departmentId: p.departmentId,
        appointmentId: p.appointmentId,
        visitNumber: await nextNumber("VIS", "visit_number_seq", 9, tx),
        arrivedAt: p.arrivedAt ? new Date(p.arrivedAt) : new Date(),
      });
      return;
    }

    case "UPDATE_TRIAGE": {
      const [visit] = await tx.select({ id: visits.id }).from(visits).where(eq(visits.id, p.visitId)).limit(1);
      if (!visit) throw new HttpError(404, "Visit not found");
      const nurse = await getStaffByUserId(ctx.userId, tx);
      const { visitId, ...vitals } = p;
      await tx.insert(triageRecords).values({
        visitId,
        nurseId: nurse?.id ?? null, // taken from the session, never from the client
        ...vitals,
        urgencyLevel: vitals.urgencyLevel ?? "5_non_urgent",
      });
      return;
    }

    case "CREATE_CONSULTATION": {
      const doctor = await getDoctorByUserId(ctx.userId, tx);
      if (!doctor) throw new HttpError(403, "No doctor profile for this account");
      const [visit] = await tx.select().from(visits).where(eq(visits.id, p.visitId)).limit(1);
      if (!visit) throw new HttpError(404, "Visit not found");
      await tx.insert(consultations).values({
        visitId: visit.id,
        patientId: visit.patientId,  // derived from the visit, not trusted from the client
        doctorId: doctor.id,         // derived from the session
        diagnosis: p.diagnosis,
        clinicalNotes: p.clinicalNotes,
        treatmentPlan: p.treatmentPlan,
        followUpDate: p.followUpDate,
      });
      return;
    }

    case "CREATE_LAB_ORDER": {
      const doctor = await getDoctorByUserId(ctx.userId, tx);
      if (!doctor) throw new HttpError(403, "No doctor profile for this account");
      const [consult] = await tx.select().from(consultations).where(eq(consultations.id, p.consultationId)).limit(1);
      if (!consult) throw new HttpError(404, "Consultation not found");
      if (consult.doctorId !== doctor.id) throw new HttpError(403, "Not your consultation");
      await tx.insert(labOrders).values({
        consultationId: consult.id,
        patientId: consult.patientId,
        orderedBy: doctor.id,
        testName: p.testName,
        testCode: p.testCode,
        urgency: p.urgency ?? "5_non_urgent",
        instructions: p.instructions,
      });
      return;
    }
  }
}

export const pushSync = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const { deviceId, queue } = parsed.data;
    const ctx: Ctx = { userId: req.clerkUser!.dbUserId, role: req.clerkUser!.role };

    // Dependencies (visit → triage → consultation) must apply in the order they happened offline.
    const ordered = [...queue].sort((a, b) => Date.parse(a.createdOfflineAt) - Date.parse(b.createdOfflineAt));

    const synced: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const item of ordered) {
      const row = {
        userId: ctx.userId, deviceId, clientId: item.id, action: item.action,
        payload: JSON.stringify(item.payload), createdOfflineAt: new Date(item.createdOfflineAt),
      };

      try {
        // Idempotent: a retried batch must not create duplicates.
        const [already] = await db.select({ id: syncQueue.id }).from(syncQueue)
          .where(and(eq(syncQueue.deviceId, deviceId), eq(syncQueue.clientId, item.id), eq(syncQueue.status, "synced")))
          .limit(1);
        if (already) { synced.push(item.id); continue; }

        // Action + audit row commit together, or not at all.
        await db.transaction(async (tx) => {
          await processAction(tx, ctx, item.action, item.payload);
          await tx.insert(syncQueue).values({ ...row, status: "synced", syncedAt: new Date() });
        });
        synced.push(item.id);
      } catch (err: any) {
        // Lost a race with a duplicate submit (partial unique index) → already applied.
        if (isUniqueViolation(err) && String(err?.constraint ?? err?.cause?.constraint ?? "").includes("sync_queue")) {
          synced.push(item.id);
          continue;
        }
        const safe = err instanceof HttpError ? err.message : "Could not process this record";
        if (!(err instanceof HttpError)) console.error("sync item failed:", item.action, err);
        try {
          await db.insert(syncQueue).values({ ...row, status: "failed", errorMessage: safe.slice(0, 500) });
        } catch (logErr) {
          console.error("could not record failed sync item:", logErr);
        }
        failed.push({ id: item.id, error: safe });
      }
    }

    return sendSuccess(res, {
      synced, failed, total: queue.length, success: synced.length,
    }, `${synced.length} of ${queue.length} records synced`);
  } catch (err) {
    console.error("pushSync error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const pullSync = async (req: ClerkRequest, res: Response) => {
  try {
    const since = req.query.since as string | undefined;
    const sinceDate = since ? new Date(since) : new Date(0);
    if (isNaN(sinceDate.getTime())) return sendError(res, "Invalid 'since' timestamp", 422);

    const syncedAt = new Date(); // captured BEFORE querying so nothing falls between two pulls
    const data: Record<string, unknown> = {};

    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (patient) {
      data.appointments = await db.select().from(appointments)
        .where(and(eq(appointments.patientId, patient.id), gt(appointments.updatedAt, sinceDate)));
    }

    return sendSuccess(res, { ...data, syncedAt: syncedAt.toISOString() });
  } catch (err) {
    console.error("pullSync error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};
