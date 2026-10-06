import { Response } from "express";
import { z } from "zod";
import { count, desc, eq, ilike, or } from "drizzle-orm";
import { db, patients, users, appointments, documents, departments, accessGrants } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { handleError, HttpError } from "../utils/errors";
import { getStaffByUserId, isStaff } from "../utils/access";
import { isUuid, uuid } from "../utils/validation";
import { audit } from "../utils/audit";
import { BREAK_GLASS_HOURS, BREAK_GLASS_ROLES, resolveAccess } from "../utils/patientAccess";

const deny = (res: Response) => sendError(res, "Access denied", 403);

export const getStaffDashboard = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);

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

// Search list: identity + contact only. No blood group, allergies or anything clinical.
export const getAllPatients = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return deny(res);

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const q = String(req.query.q ?? "").trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const search = q
      ? or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(patients.patientNumber, like), ilike(users.phone, like))
      : undefined;

    const list = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, gender: patients.gender,
        insuranceScheme: patients.insuranceScheme, createdAt: patients.createdAt,
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

    const access = await resolveAccess(req, id);

    // Not this person's patient: identity only, plus the option to request audited emergency access.
    if (access.level === "minimal") {
      return res.status(403).json({
        success: false,
        error: "You are not currently assigned to this patient.",
        code: "ACCESS_REQUIRED",
        canRequestEmergencyAccess: BREAK_GLASS_ROLES.includes(req.clerkUser!.role),
        patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName, patientNumber: patient.patientNumber },
      });
    }

    const patientAppointments = await db
      .select({
        id: appointments.id, appointmentDate: appointments.appointmentDate, appointmentTime: appointments.appointmentTime,
        status: appointments.status, reason: appointments.reason, department: departments.name,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .where(eq(appointments.patientId, id))
      .orderBy(desc(appointments.appointmentDate));

    if (access.level === "basic") {
      const { allergies, bloodGroup, ...demographics } = patient;
      return sendSuccess(res, {
        ...demographics, accessLevel: "basic", accessReason: access.reason,
        appointments: patientAppointments.map((a) => ({ ...a, reason: null })),
        documents: [],
      });
    }

    const patientDocuments = await db.select().from(documents).where(eq(documents.patientId, id)).orderBy(desc(documents.createdAt));
    await audit(req, "patient.viewed", "patients", id, null, { via: access.reason });

    return sendSuccess(res, {
      ...patient, accessLevel: "clinical", accessReason: access.reason, accessExpiresAt: access.expiresAt ?? null,
      appointments: patientAppointments, documents: patientDocuments,
    });
  } catch (err) {
    return handleError(res, err, "getPatientById");
  }
};

const emergencySchema = z.object({ reason: z.string().trim().min(10, "Please explain why you need access (at least 10 characters)").max(500) });

export const requestEmergencyAccess = async (req: ClerkRequest, res: Response) => {
  try {
    if (!BREAK_GLASS_ROLES.includes(req.clerkUser!.role)) return deny(res);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Patient not found", 404);
    const parsed = emergencySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id)).limit(1);
    if (!patient) return sendError(res, "Patient not found", 404);

    const expiresAt = new Date(Date.now() + BREAK_GLASS_HOURS * 3600 * 1000);
    await db.insert(accessGrants).values({ userId: req.clerkUser!.dbUserId, patientId: id, reason: parsed.data.reason, expiresAt });
    await audit(req, "patient.break_glass", "patients", id, null, { reason: parsed.data.reason, expiresAt });

    return sendSuccess(res, { expiresAt }, `Emergency access granted for ${BREAK_GLASS_HOURS} hours. This has been logged.`, 201);
  } catch (err) {
    return handleError(res, err, "requestEmergencyAccess");
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

    await audit(req, "document.uploaded", "documents", doc.id, null, { patientId: doc.patientId, type: doc.documentType, title: doc.title });
    return sendSuccess(res, doc, "Document uploaded successfully", 201);
  } catch (err) {
    return handleError(res, err, "uploadDocument");
  }
};
