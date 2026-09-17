import { Request, Response } from "express";
import { db, syncQueue, appointments, patients, visits, triageRecords, consultations } from "../db";
import { eq, gt, and } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";
import { z } from "zod";

const syncItemSchema = z.object({
  id:               z.string(),
  action:           z.enum([
    "CREATE_APPOINTMENT", "CANCEL_APPOINTMENT", "UPDATE_TRIAGE",
    "CREATE_CONSULTATION", "CREATE_LAB_ORDER",
    "UPDATE_PATIENT_PROFILE", "CREATE_VISIT",
  ]),
  payload:          z.record(z.any()),
  createdOfflineAt: z.string(),
});

const pushSchema = z.object({
  deviceId: z.string(),
  queue:    z.array(syncItemSchema),
});

export const pushSync = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.issues[0].message, 422);
    }

    const { deviceId, queue } = parsed.data;
    const synced: string[]    = [];
    const failed: { id: string; error: string }[] = [];

    for (const item of queue) {
      try {
        await processAction(req.user!.id, item.action, item.payload);

        // Record in sync_queue
        await db.insert(syncQueue).values({
          userId:           req.user!.id,
          deviceId,
          action:           item.action,
          payload:          JSON.stringify(item.payload),
          status:           "synced",
          createdOfflineAt: new Date(item.createdOfflineAt),
          syncedAt:         new Date(),
        });

        synced.push(item.id);
      } catch (err: any) {
        // Record failed item
        await db.insert(syncQueue).values({
          userId:           req.user!.id,
          deviceId,
          action:           item.action,
          payload:          JSON.stringify(item.payload),
          status:           "failed",
          errorMessage:     err.message?.slice(0, 500),
          createdOfflineAt: new Date(item.createdOfflineAt),
        });

        failed.push({ id: item.id, error: err.message });
      }
    }

    return sendSuccess(res, {
      synced,
      failed,
      total:   queue.length,
      success: synced.length,
    }, `${synced.length} of ${queue.length} records synced`);

  } catch (err) {
    console.error("pushSync error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

// Process each action type
async function processAction(userId: string, action: string, payload: any) {
  switch (action) {

    case "CREATE_APPOINTMENT": {
      const [patient] = await db
        .select()
        .from(patients)
        .where(eq(patients.userId, userId))
        .limit(1);

      if (!patient) throw new Error("Patient not found");

      await db.insert(appointments).values({
        patientId:       patient.id,
        departmentId:    payload.departmentId,
        doctorId:        payload.doctorId,
        appointmentDate: payload.appointmentDate,
        appointmentTime: payload.appointmentTime,
        reason:          payload.reason,
        bookedOnline:    true,
        status:          "pending",
      });
      break;
    }

    case "CANCEL_APPOINTMENT": {
      await db
        .update(appointments)
        .set({ status: "cancelled" })
        .where(eq(appointments.id, payload.appointmentId));
      break;
    }

    case "UPDATE_PATIENT_PROFILE": {
      const [patient] = await db
        .select()
        .from(patients)
        .where(eq(patients.userId, userId))
        .limit(1);

      if (!patient) throw new Error("Patient not found");

      await db
        .update(patients)
        .set({ ...payload, updatedAt: new Date() })
        .where(eq(patients.id, patient.id));
      break;
    }

    case "CREATE_VISIT": {
      await db.insert(visits).values({
        patientId:    payload.patientId,
        departmentId: payload.departmentId,
        visitNumber:  `VIS-${Date.now().toString().slice(-8)}`,
        arrivedAt:    new Date(payload.arrivedAt),
      });
      break;
    }

    case "UPDATE_TRIAGE": {
      await db.insert(triageRecords).values({
        visitId:          payload.visitId,
        temperature:      payload.temperature,
        bloodPressure:    payload.bloodPressure,
        pulseRate:        payload.pulseRate,
        weight:           payload.weight,
        height:           payload.height,
        oxygenSaturation: payload.oxygenSaturation,
        urgencyLevel:     payload.urgencyLevel || "5_non_urgent",
        chiefComplaint:   payload.chiefComplaint,
      });
      break;
    }

    case "CREATE_CONSULTATION": {
      await db.insert(consultations).values({
        visitId:       payload.visitId,
        doctorId:      payload.doctorId,
        patientId:     payload.patientId,
        diagnosis:     payload.diagnosis,
        clinicalNotes: payload.clinicalNotes,
        treatmentPlan: payload.treatmentPlan,
        followUpDate:  payload.followUpDate,
      });
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export const pullSync = async (req: AuthRequest, res: Response) => {
  try {
    const since = req.query.since as string;
    const sinceDate = since ? new Date(since) : new Date(0);

    // Pull latest data relevant to this user's role
    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, req.user!.id))
      .limit(1);

    let data: any = {};

    if (patient) {
      // Pull patient's appointments updated since last sync
      const patientAppointments = await db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.patientId, patient.id),
            gt(appointments.updatedAt, sinceDate)
          )
        );

      data.appointments = patientAppointments;
    }

    return sendSuccess(res, {
      ...data,
      syncedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error("pullSync error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};