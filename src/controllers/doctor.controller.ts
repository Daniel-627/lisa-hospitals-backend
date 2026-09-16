import { Request, Response } from "express";
import { db, doctors, staff, users, departments, doctorAvailability } from "../db";
import { eq } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";

export const getAllDoctors = async (req: Request, res: Response) => {
  try {
    const all = await db
      .select({
        id: doctors.id, speciality: doctors.speciality, bio: doctors.bio,
        photoUrl: doctors.photoUrl, consultationFee: doctors.consultationFee,
        isAvailable: doctors.isAvailable, departmentId: doctors.departmentId,
        firstName: users.firstName, lastName: users.lastName,
        email: users.email, phone: users.phone,
        department: departments.name, departmentSlug: departments.slug,
      })
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .innerJoin(departments, eq(doctors.departmentId, departments.id))
      .where(eq(doctors.isAvailable, true));

    return sendSuccess(res, all);
  } catch (err) {
    console.error("getAllDoctors error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getDoctorById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [doctor] = await db
      .select({
        id: doctors.id, speciality: doctors.speciality, bio: doctors.bio,
        photoUrl: doctors.photoUrl, consultationFee: doctors.consultationFee,
        isAvailable: doctors.isAvailable, departmentId: doctors.departmentId,
        firstName: users.firstName, lastName: users.lastName,
        email: users.email, phone: users.phone,
        department: departments.name, departmentSlug: departments.slug,
      })
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .innerJoin(departments, eq(doctors.departmentId, departments.id))
      .where(eq(doctors.id, id))
      .limit(1);

    if (!doctor) return sendError(res, "Doctor not found", 404);
    return sendSuccess(res, doctor);
  } catch (err) {
    console.error("getDoctorById error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getDoctorAvailability = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const slots = await db.select().from(doctorAvailability).where(eq(doctorAvailability.doctorId, id));
    return sendSuccess(res, slots);
  } catch (err) {
    console.error("getDoctorAvailability error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};