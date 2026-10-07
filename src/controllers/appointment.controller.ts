import { Response } from "express";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, appointments, departments, patients, users } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { handleError } from "../utils/errors";
import { getPatientByUserId, hasRole } from "../utils/access";
import { bookAppointment, cancelAppointmentRecord, bookAppointmentSchema } from "../services/appointments.service";
import { dateStr, isUuid } from "../utils/validation";
import { appointmentScope, canSeeAppointment } from "../utils/patientAccess";
import { idFirstName, idLastName, idPhone } from "../utils/patientIdentity";

const STAFF_STATUS_ROLES = ["receptionist", "nurse", "doctor", "admin"] as const;

export const createAppointment = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = bookAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const appointment = await bookAppointment(patient.id, parsed.data);
    return sendSuccess(res, appointment, "Appointment booked successfully", 201);
  } catch (err) {
    return handleError(res, err, "createAppointment");
  }
};

export const getMyAppointments = async (req: ClerkRequest, res: Response) => {
  try {
    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const mine = await db
      .select({
        id: appointments.id,
        appointmentDate: appointments.appointmentDate,
        appointmentTime: appointments.appointmentTime,
        status: appointments.status,
        reason: appointments.reason,
        bookedOnline: appointments.bookedOnline,
        createdAt: appointments.createdAt,
        department: departments.name,
        departmentSlug: departments.slug,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .where(eq(appointments.patientId, patient.id))
      .orderBy(desc(appointments.appointmentDate), desc(appointments.appointmentTime));

    return sendSuccess(res, mine);
  } catch (err) {
    return handleError(res, err, "getMyAppointments");
  }
};

export const getAppointmentById = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Appointment not found", 404);

    const [appointment] = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
    if (!appointment) return sendError(res, "Appointment not found", 404);

    // 1) Your own appointment (patients, and staff acting as patients): no internal staff notes.
    const mine = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (mine && appointment.patientId === mine.id) {
      const { notes, ...safe } = appointment;
      return sendSuccess(res, safe);
    }
    // 2) Staff: only appointments they have a reason to see. 404 (not 403) so IDs can't be probed.
    if (!(await canSeeAppointment(req, appointment))) return sendError(res, "Appointment not found", 404);
    if (["receptionist", "admin"].includes(req.clerkUser!.role)) {
      const { reason, notes, ...safe } = appointment; // front desk/admin don't need clinical details
      return sendSuccess(res, safe);
    }
    return sendSuccess(res, appointment);
  } catch (err) {
    return handleError(res, err, "getAppointmentById");
  }
};

export const cancelAppointment = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Appointment not found", 404);

    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const updated = await cancelAppointmentRecord(id, { patientId: patient.id });
    return sendSuccess(res, updated, "Appointment cancelled");
  } catch (err) {
    return handleError(res, err, "cancelAppointment");
  }
};

export const getAllAppointments = async (req: ClerkRequest, res: Response) => {
  try {
    if (req.clerkUser!.role === "patient") return sendError(res, "Access denied", 403);

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    // Optional filters: ?status=pending&date=2026-10-05
    const status = statusSchema.shape.status.safeParse(req.query.status);
    const date = dateStr.safeParse(req.query.date);
    const conditions = [];
    if (status.success) conditions.push(eq(appointments.status, status.data));
    if (date.success) conditions.push(eq(appointments.appointmentDate, date.data));

    // Doctors and nurses only see their own / their department's appointments.
    const scope = await appointmentScope(req);
    if (scope === null) return sendSuccess(res, []);
    if (scope) conditions.push(scope);

    const all = await db
      .select({
        id: appointments.id,
        appointmentDate: appointments.appointmentDate,
        appointmentTime: appointments.appointmentTime,
        status: appointments.status,
        reason: appointments.reason,
        bookedOnline: appointments.bookedOnline,
        createdAt: appointments.createdAt,
        department: departments.name,
        patientId: patients.id,
        patientNumber: patients.patientNumber,
        patientFirstName: idFirstName,
        patientLastName: idLastName,
        patientPhone: idPhone,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id)) // walk-ins have no user account
      .where(conditions.length ? and(...conditions) : undefined)
      // A single day reads best as a schedule (earliest first); otherwise newest first.
      .orderBy(...(date.success
        ? [asc(appointments.appointmentTime)]
        : [desc(appointments.appointmentDate), desc(appointments.appointmentTime)]))
      .limit(limit)
      .offset(offset);

    const hideReason = ["receptionist", "admin"].includes(req.clerkUser!.role);
    return sendSuccess(res, hideReason ? all.map((a) => ({ ...a, reason: null })) : all);
  } catch (err) {
    return handleError(res, err, "getAllAppointments");
  }
};

const statusSchema = z.object({
  status: z.enum(["pending", "confirmed", "completed", "cancelled", "no_show"]),
});

export const updateAppointmentStatus = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...STAFF_STATUS_ROLES)) return sendError(res, "Access denied", 403);

    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Appointment not found", 404);

    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid status", 422);

    const [updated] = await db
      .update(appointments)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(appointments.id, id))
      .returning();

    if (!updated) return sendError(res, "Appointment not found", 404);
    return sendSuccess(res, updated, "Status updated");
  } catch (err) {
    return handleError(res, err, "updateAppointmentStatus");
  }
};
