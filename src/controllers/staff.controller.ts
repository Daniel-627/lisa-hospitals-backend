import { Response } from "express";
import { z } from "zod";
import { count, desc, eq, ilike, or } from "drizzle-orm";
import { db, patients, users, appointments, documents, departments } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { handleError, HttpError } from "../utils/errors";
import { getStaffByUserId, isStaff } from "../utils/access";
import { isUuid, uuid } from "../utils/validation";

const deny = (res: Response) => sendError(res, "Access denied", 403);

export const getStaffDashboard = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);

    // One pass over appointments instead of four sequential queries.
    const [[p], byStatus] = await Promise.all([
      db.select({ count: count() }).from(patients),
      db.select({ status: appointments.status, count: count() }).from(appointments).groupBy(appointments.status),
    ]);
    const n = (s: string) => byStatus.find((r) => r.status === s)?.count ?? 0;

    return sendSuccess(res, {
      totalPatients: p.count,
      totalAppointments: byStatus.reduce((sum, r) => sum + r.count, 0),
      pendingAppointments: n("pending"),
      confirmedAppointments: n("confirmed"),
    });
  } catch (err) {
    return handleError(res, err, "getStaffDashboard");
  }
};

export const getAllPatients = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    // Optional search: ?q=jane / PT-1000012 / 0712...  (LIKE wildcards in the input are escaped)
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const search = q
      ? or(
          ilike(users.firstName, like), ilike(users.lastName, like),
          ilike(patients.patientNumber, like), ilike(users.phone, like),
        )
      : undefined;

    const list = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, gender: patients.gender,
        bloodGroup: patients.bloodGroup, insuranceScheme: patients.insuranceScheme,
        createdAt: patients.createdAt,
        firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .where(search)
      .orderBy(desc(patients.createdAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(res, list);
  } catch (err) {
    return handleError(res, err, "getAllPatients");
  }
};

export const getPatientById = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Patient not found", 404);

    const [patient] = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, dateOfBirth: patients.dateOfBirth,
        gender: patients.gender, bloodGroup: patients.bloodGroup, nationalId: patients.nationalId,
        address: patients.address, nextOfKinName: patients.nextOfKinName,
        nextOfKinPhone: patients.nextOfKinPhone, nextOfKinRelation: patients.nextOfKinRelation,
        insuranceScheme: patients.insuranceScheme, insuranceNumber: patients.insuranceNumber,
        allergies: patients.allergies, createdAt: patients.createdAt,
        firstName: users.firstName, lastName: users.lastName, email: users.email, phone: users.phone,
      })
      .from(patients)
      .innerJoin(users, eq(patients.userId, users.id))
      .where(eq(patients.id, id))
      .limit(1);

    if (!patient) return sendError(res, "Patient not found", 404);

    const [patientAppointments, patientDocuments] = await Promise.all([
      db.select({
          id: appointments.id, appointmentDate: appointments.appointmentDate,
          appointmentTime: appointments.appointmentTime, status: appointments.status,
          reason: appointments.reason, department: departments.name,
        })
        .from(appointments)
        .innerJoin(departments, eq(appointments.departmentId, departments.id))
        .where(eq(appointments.patientId, id))
        .orderBy(desc(appointments.appointmentDate)),
      db.select().from(documents).where(eq(documents.patientId, id)).orderBy(desc(documents.createdAt)),
    ]);

    return sendSuccess(res, { ...patient, appointments: patientAppointments, documents: patientDocuments });
  } catch (err) {
    return handleError(res, err, "getPatientById");
  }
};

const documentSchema = z.object({
  patientId: uuid,
  documentType: z.enum([
    "lab_result", "radiology_report", "prescription", "discharge_summary",
    "referral_letter", "medical_certificate", "vaccination_record",
    "antenatal_card", "invoice", "insurance_claim", "admission_letter",
  ]),
  title:     z.string().trim().min(1).max(200),
  fileUrl:   z.string().url().max(500).refine((u) => u.startsWith("https://"), "File URL must use https"),
  fileSize:  z.number().int().min(0).optional(),
  mimeType:  z.string().max(100).optional(),
  relatedId: uuid.optional(),
});

export const uploadDocument = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);

    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const [patient] = await db.select({ id: patients.id }).from(patients)
      .where(eq(patients.id, parsed.data.patientId)).limit(1);
    if (!patient) throw new HttpError(404, "Patient not found");

    // documents.uploadedBy references staff.id (NOT users.id). Admins may have no staff row → null.
    const staffRecord = await getStaffByUserId(req.clerkUser!.dbUserId);

    // Fields are listed explicitly (not spread): with "strict": false in tsconfig, zod's inferred
    // type makes every field optional, which Drizzle's insert type rejects.
    const [doc] = await db.insert(documents).values({
      patientId:    parsed.data.patientId,
      documentType: parsed.data.documentType,
      title:        parsed.data.title,
      fileUrl:      parsed.data.fileUrl,
      fileSize:     parsed.data.fileSize,
      mimeType:     parsed.data.mimeType,
      relatedId:    parsed.data.relatedId,
      uploadedBy:   staffRecord?.id ?? null,
      isVisible:    true,
    }).returning();

    return sendSuccess(res, doc, "Document uploaded successfully", 201);
  } catch (err) {
    return handleError(res, err, "uploadDocument");
  }
};