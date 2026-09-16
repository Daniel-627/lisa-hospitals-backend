import { Request, Response } from "express";
import { db, departments, doctors, staff, users } from "../db";
import { eq } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response.js";

export const getAllDepartments = async (req: Request, res: Response) => {
  try {
    const all = await db.select().from(departments).where(eq(departments.isActive, true));
    return sendSuccess(res, all);
  } catch (err) {
    console.error("getAllDepartments error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getDepartmentBySlug = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const [dept] = await db.select().from(departments).where(eq(departments.slug, slug as any)).limit(1);
    if (!dept) return sendError(res, "Department not found", 404);
    return sendSuccess(res, dept);
  } catch (err) {
    console.error("getDepartmentBySlug error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getDepartmentDoctors = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const [dept] = await db.select().from(departments).where(eq(departments.slug, slug as any)).limit(1);
    if (!dept) return sendError(res, "Department not found", 404);

    const deptDoctors = await db
      .select({
        id: doctors.id, speciality: doctors.speciality, bio: doctors.bio,
        photoUrl: doctors.photoUrl, consultationFee: doctors.consultationFee,
        isAvailable: doctors.isAvailable, firstName: users.firstName,
        lastName: users.lastName, email: users.email, phone: users.phone,
      })
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .where(eq(doctors.departmentId, dept.id));

    return sendSuccess(res, deptDoctors);
  } catch (err) {
    console.error("getDepartmentDoctors error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};