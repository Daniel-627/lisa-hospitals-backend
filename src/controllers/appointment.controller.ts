import { Response } from "express";
import { db, appointments, patients, departments } from "../db";
import { eq, and } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { z } from "zod";

const createSchema = z.object({
  departmentId:    z.string().uuid(),
  doctorId:        z.string().uuid().optional(),
  appointmentDate: z.string(),
  appointmentTime: z.string(),
  reason:          z.string().optional(),
});

export const createAppointment = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const [appointment] = await db.insert(appointments).values({
      patientId:       patient.id,
      departmentId:    parsed.data.departmentId,
      doctorId:        parsed.data.doctorId,
      appointmentDate: parsed.data.appointmentDate,
      appointmentTime: parsed.data.appointmentTime,
      reason:          parsed.data.reason,
      bookedOnline:    true,
      status:          "pending",
    }).returning();

    return sendSuccess(res, appointment, "Appointment booked successfully", 201);
  } catch (err) {
    console.error("createAppointment error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getMyAppointments = async (req: ClerkRequest, res: Response) => {
  try {
    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const myAppointments = await db
      .select({
        id:              appointments.id,
        appointmentDate: appointments.appointmentDate,
        appointmentTime: appointments.appointmentTime,
        status:          appointments.status,
        reason:          appointments.reason,
        bookedOnline:    appointments.bookedOnline,
        createdAt:       appointments.createdAt,
        department:      departments.name,
        departmentSlug:  departments.slug,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .where(eq(appointments.patientId, patient.id))
      .orderBy(appointments.appointmentDate);

    return sendSuccess(res, myAppointments);
  } catch (err) {
    console.error("getMyAppointments error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getAppointmentById = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;

    const [appointment] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .limit(1);

    if (!appointment) return sendError(res, "Appointment not found", 404);
    return sendSuccess(res, appointment);
  } catch (err) {
    console.error("getAppointmentById error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const cancelAppointment = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const [appointment] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, id), eq(appointments.patientId, patient.id)))
      .limit(1);

    if (!appointment) return sendError(res, "Appointment not found", 404);
    if (appointment.status === "completed") return sendError(res, "Cannot cancel a completed appointment", 400);

    const [updated] = await db
      .update(appointments)
      .set({ status: "cancelled" })
      .where(eq(appointments.id, id))
      .returning();

    return sendSuccess(res, updated, "Appointment cancelled");
  } catch (err) {
    console.error("cancelAppointment error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getAllAppointments = async (req: AuthRequest, res: Response) => {
  try {
    const all = await db
      .select({
        id:              appointments.id,
        appointmentDate: appointments.appointmentDate,
        appointmentTime: appointments.appointmentTime,
        status:          appointments.status,
        reason:          appointments.reason,
        bookedOnline:    appointments.bookedOnline,
        createdAt:       appointments.createdAt,
        department:      departments.name,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .orderBy(appointments.appointmentDate);

    return sendSuccess(res, all);
  } catch (err) {
    console.error("getAllAppointments error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const updateAppointmentStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["pending", "confirmed", "completed", "cancelled", "no_show"];
    if (!validStatuses.includes(status)) return sendError(res, "Invalid status", 422);

    const [updated] = await db
      .update(appointments)
      .set({ status })
      .where(eq(appointments.id, id))
      .returning();

    if (!updated) return sendError(res, "Appointment not found", 404);
    return sendSuccess(res, updated, "Status updated");
  } catch (err) {
    console.error("updateAppointmentStatus error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};