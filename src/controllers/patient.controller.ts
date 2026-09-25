import { Response } from "express";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { db, patients, users, documents, visits, departments } from "../db";
import { eq } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";
import { z } from "zod";

const updateSchema = z.object({
  dateOfBirth:       z.string().optional(),
  gender:            z.enum(["male", "female", "other"]).optional(),
  bloodGroup:        z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).optional(),
  nationalId:        z.string().optional(),
  address:           z.string().optional(),
  nextOfKinName:     z.string().optional(),
  nextOfKinPhone:    z.string().optional(),
  nextOfKinRelation: z.string().optional(),
  insuranceScheme:   z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]).optional(),
  insuranceNumber:   z.string().optional(),
  allergies:         z.string().optional(),
});

export const getMyProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select({
        id:                patients.id,
        patientNumber:     patients.patientNumber,
        dateOfBirth:       patients.dateOfBirth,
        gender:            patients.gender,
        bloodGroup:        patients.bloodGroup,
        nationalId:        patients.nationalId,
        address:           patients.address,
        nextOfKinName:     patients.nextOfKinName,
        nextOfKinPhone:    patients.nextOfKinPhone,
        nextOfKinRelation: patients.nextOfKinRelation,
        insuranceScheme:   patients.insuranceScheme,
        insuranceNumber:   patients.insuranceNumber,
        allergies:         patients.allergies,
        firstName:         users.firstName,
        lastName:          users.lastName,
        email:             users.email,
        phone:             users.phone,
        createdAt:         patients.createdAt,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);
    return sendSuccess(res, patient);
  } catch (err) {
    console.error("getMyProfile error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const updateMyProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const [updated] = await db
      .update(patients)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(patients.id, patient.id))
      .returning();

    return sendSuccess(res, updated, "Profile updated successfully");
  } catch (err) {
    console.error("updateMyProfile error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getMyDocuments = async (req: ClerkRequest, res: Response) => {
  try {
    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.patientId, patient.id));

    return sendSuccess(res, docs);
  } catch (err) {
    console.error("getMyDocuments error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getMyVisits = async (req: ClerkRequest, res: Response) => {
  try {
    const userId = req.clerkUser!.dbUserId;

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, userId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const myVisits = await db
      .select({
        id:          visits.id,
        visitNumber: visits.visitNumber,
        arrivedAt:   visits.arrivedAt,
        departedAt:  visits.departedAt,
        department:  departments.name,
      })
      .from(visits)
      .innerJoin(departments, eq(visits.departmentId, departments.id))
      .where(eq(visits.patientId, patient.id))
      .orderBy(visits.arrivedAt);

    return sendSuccess(res, myVisits);
  } catch (err) {
    console.error("getMyVisits error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};