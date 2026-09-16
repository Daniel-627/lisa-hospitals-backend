import { Request, Response } from "express";
import { db, patients, users, appointments, visits, documents, departments } from "../db";
import { eq, count } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";
import { z } from "zod";

export const getStaffDashboard = async (req: AuthRequest, res: Response) => {
  try {
    const [totalPatients] = await db
      .select({ count: count() })
      .from(patients);

    const [totalAppointments] = await db
      .select({ count: count() })
      .from(appointments);

    const [pendingAppointments] = await db
      .select({ count: count() })
      .from(appointments)
      .where(eq(appointments.status, "pending"));

    const [confirmedAppointments] = await db
      .select({ count: count() })
      .from(appointments)
      .where(eq(appointments.status, "confirmed"));

    return sendSuccess(res, {
      totalPatients:        totalPatients.count,
      totalAppointments:    totalAppointments.count,
      pendingAppointments:  pendingAppointments.count,
      confirmedAppointments:confirmedAppointments.count,
    });
  } catch (err) {
    console.error("getStaffDashboard error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getAllPatients = async (req: AuthRequest, res: Response) => {
  try {
    const allPatients = await db
      .select({
        id:            patients.id,
        patientNumber: patients.patientNumber,
        gender:        patients.gender,
        bloodGroup:    patients.bloodGroup,
        insuranceScheme: patients.insuranceScheme,
        createdAt:     patients.createdAt,
        firstName:     users.firstName,
        lastName:      users.lastName,
        email:         users.email,
        phone:         users.phone,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .orderBy(patients.createdAt);

    return sendSuccess(res, allPatients);
  } catch (err) {
    console.error("getAllPatients error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getPatientById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

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
        createdAt:         patients.createdAt,
        firstName:         users.firstName,
        lastName:          users.lastName,
        email:             users.email,
        phone:             users.phone,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .where(eq(patients.id, id))
      .limit(1);

    if (!patient) return sendError(res, "Patient not found", 404);

    // Get their appointments
    const patientAppointments = await db
      .select({
        id:              appointments.id,
        appointmentDate: appointments.appointmentDate,
        appointmentTime: appointments.appointmentTime,
        status:          appointments.status,
        reason:          appointments.reason,
        department:      departments.name,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .where(eq(appointments.patientId, id))
      .orderBy(appointments.appointmentDate);

    // Get their documents
    const patientDocuments = await db
      .select()
      .from(documents)
      .where(eq(documents.patientId, id));

    return sendSuccess(res, {
      ...patient,
      appointments: patientAppointments,
      documents:    patientDocuments,
    });
  } catch (err) {
    console.error("getPatientById error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

const documentSchema = z.object({
  patientId:    z.string().uuid(),
  documentType: z.enum([
    "lab_result", "radiology_report", "prescription",
    "discharge_summary", "referral_letter", "medical_certificate",
    "vaccination_record", "antenatal_card", "invoice",
    "insurance_claim", "admission_letter",
  ]),
  title:     z.string().min(1),
  fileUrl:   z.string().url(),
  fileSize:  z.number().optional(),
  mimeType:  z.string().optional(),
  relatedId: z.string().uuid().optional(),
});

export const uploadDocument = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.errors[0].message, 422);
    }

    const [doc] = await db.insert(documents).values({
      patientId:    parsed.data.patientId,
      documentType: parsed.data.documentType,
      title:        parsed.data.title,
      fileUrl:      parsed.data.fileUrl,
      fileSize:     parsed.data.fileSize,
      mimeType:     parsed.data.mimeType,
      relatedId:    parsed.data.relatedId,
      uploadedBy:   req.user!.id as any,
      isVisible:    true,
    }).returning();

    return sendSuccess(res, doc, "Document uploaded successfully", 201);
  } catch (err) {
    console.error("uploadDocument error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};