import { Request, Response } from "express";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db, departments, doctors, staff, users } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { handleError } from "../utils/errors";

// Keep in sync with departmentSlugEnum in the schema. Validating here avoids a Postgres
// "invalid input value for enum" 500 (previously hidden behind `slug as any`).
const slugSchema = z.enum([
  "outpatient_inpatient", "accident_emergency", "specialist_clinics", "laboratory",
  "pharmacy", "radiology", "physiotherapy", "dental", "maternity", "eye_care",
  "mother_child_health", "critical_care_icu",
]);

export const getAllDepartments = async (_req: Request, res: Response) => {
  try {
    const all = await db.select().from(departments)
      .where(eq(departments.isActive, true))
      .orderBy(asc(departments.name));
    return sendSuccess(res, all);
  } catch (err) {
    return handleError(res, err, "getAllDepartments");
  }
};

export const getDepartmentBySlug = async (req: Request, res: Response) => {
  try {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) return sendError(res, "Department not found", 404);

    const [dept] = await db.select().from(departments).where(eq(departments.slug, slug.data)).limit(1);
    if (!dept) return sendError(res, "Department not found", 404);
    return sendSuccess(res, dept);
  } catch (err) {
    return handleError(res, err, "getDepartmentBySlug");
  }
};

export const getDepartmentDoctors = async (req: Request, res: Response) => {
  try {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) return sendError(res, "Department not found", 404);

    const [dept] = await db.select().from(departments).where(eq(departments.slug, slug.data)).limit(1);
    if (!dept) return sendError(res, "Department not found", 404);

    const deptDoctors = await db
      .select({
        id: doctors.id, speciality: doctors.speciality, bio: doctors.bio,
        photoUrl: doctors.photoUrl, consultationFee: doctors.consultationFee,
        isAvailable: doctors.isAvailable, firstName: users.firstName, lastName: users.lastName,
      })
      .from(doctors)
      .innerJoin(staff, eq(doctors.staffId, staff.id))
      .innerJoin(users, eq(staff.userId, users.id))
      .where(and(eq(doctors.departmentId, dept.id), eq(users.isActive, true)));

    return sendSuccess(res, deptDoctors);
  } catch (err) {
    return handleError(res, err, "getDepartmentDoctors");
  }
};
