import { Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, doctors, staff, users, departments, doctorAvailability } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { handleError } from "../utils/errors";
import { isUuid } from "../utils/validation";

// Public-facing fields only: doctors' personal email/phone are intentionally NOT exposed.
const publicFields = {
  id: doctors.id, speciality: doctors.speciality, bio: doctors.bio,
  photoUrl: doctors.photoUrl, consultationFee: doctors.consultationFee,
  isAvailable: doctors.isAvailable, departmentId: doctors.departmentId,
  firstName: users.firstName, lastName: users.lastName,
  department: departments.name, departmentSlug: departments.slug,
};

export const getAllDoctors = async (_req: Request, res: Response) => {
  try {
    const all = await db
      .select(publicFields)
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .innerJoin(departments, eq(doctors.departmentId, departments.id))
      .where(and(eq(doctors.isAvailable, true), eq(users.isActive, true)))
      .orderBy(asc(users.lastName));
    return sendSuccess(res, all);
  } catch (err) {
    return handleError(res, err, "getAllDoctors");
  }
};

export const getDoctorById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Doctor not found", 404);

    const [doctor] = await db
      .select(publicFields)
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .innerJoin(departments, eq(doctors.departmentId, departments.id))
      .where(eq(doctors.id, id))
      .limit(1);

    if (!doctor) return sendError(res, "Doctor not found", 404);
    return sendSuccess(res, doctor);
  } catch (err) {
    return handleError(res, err, "getDoctorById");
  }
};

export const getDoctorAvailability = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Doctor not found", 404);

    const slots = await db.select().from(doctorAvailability)
      .where(and(eq(doctorAvailability.doctorId, id), eq(doctorAvailability.isActive, true)))
      .orderBy(asc(doctorAvailability.dayOfWeek), asc(doctorAvailability.startTime));
    return sendSuccess(res, slots);
  } catch (err) {
    return handleError(res, err, "getDoctorAvailability");
  }
};
