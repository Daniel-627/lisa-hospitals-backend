import { Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, patients, users, documents, visits, departments } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { handleError } from "../utils/errors";
import { getPatientByUserId } from "../utils/access";
import { patientProfileUpdateSchema } from "../utils/validation";

export const getMyProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const [patient] = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, dateOfBirth: patients.dateOfBirth,
        gender: patients.gender, bloodGroup: patients.bloodGroup, nationalId: patients.nationalId,
        address: patients.address, nextOfKinName: patients.nextOfKinName,
        nextOfKinPhone: patients.nextOfKinPhone, nextOfKinRelation: patients.nextOfKinRelation,
        insuranceScheme: patients.insuranceScheme, insuranceNumber: patients.insuranceNumber,
        allergies: patients.allergies,
        firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone,
        createdAt: patients.createdAt,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .where(eq(patients.userId, req.clerkUser!.dbUserId))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);
    return sendSuccess(res, patient);
  } catch (err) {
    return handleError(res, err, "getMyProfile");
  }
};

export const updateMyProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = patientProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    if (Object.keys(parsed.data).length === 0) return sendError(res, "Nothing to update", 422);

    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    // Unique violations (e.g. nationalId) become a 409 via handleError.
    const [updated] = await db
      .update(patients)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(patients.id, patient.id))
      .returning();

    return sendSuccess(res, updated, "Profile updated successfully");
  } catch (err) {
    return handleError(res, err, "updateMyProfile");
  }
};

export const getMyDocuments = async (req: ClerkRequest, res: Response) => {
  try {
    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    // Staff can hide documents from the patient (isVisible=false) — respect it.
    const docs = await db.select().from(documents)
      .where(and(eq(documents.patientId, patient.id), eq(documents.isVisible, true)))
      .orderBy(desc(documents.createdAt));

    return sendSuccess(res, docs);
  } catch (err) {
    return handleError(res, err, "getMyDocuments");
  }
};

export const getMyVisits = async (req: ClerkRequest, res: Response) => {
  try {
    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const myVisits = await db
      .select({
        id: visits.id, visitNumber: visits.visitNumber,
        arrivedAt: visits.arrivedAt, departedAt: visits.departedAt,
        department: departments.name,
      })
      .from(visits)
      .innerJoin(departments, eq(visits.departmentId, departments.id))
      .where(eq(visits.patientId, patient.id))
      .orderBy(desc(visits.arrivedAt));

    return sendSuccess(res, myVisits);
  } catch (err) {
    return handleError(res, err, "getMyVisits");
  }
};
