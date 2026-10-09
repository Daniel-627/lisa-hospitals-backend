import { Response } from "express";
import { z } from "zod";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, patients, users, appointments, documents, departments, accessGrants } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { handleError, HttpError } from "../utils/errors";
import { getStaffByUserId, isStaff, nextNumber } from "../utils/access";
import { dateStr, isUuid, normalizeKenyanPhone, todayEAT, uuid } from "../utils/validation";
import { idEmail, idFirstName, idLastName, idPhone } from "../utils/patientIdentity";
import { audit } from "../utils/audit";
import { BREAK_GLASS_HOURS, BREAK_GLASS_ROLES, resolveAccess } from "../utils/patientAccess";
import { consultationHistory } from "../utils/consultationHistory";

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
      ? or(
          ilike(idFirstName, like), ilike(idLastName, like), ilike(patients.patientNumber, like), ilike(idPhone, like),
          ilike(sql`concat(${idFirstName}, ' ', ${idLastName})`, like), // "jane wanjiru"
        )
      : undefined;

    const list = await db
      .select({
        id: patients.id, patientNumber: patients.patientNumber, gender: patients.gender,
        insuranceScheme: patients.insuranceScheme, createdAt: patients.createdAt,
        firstName: idFirstName, lastName: idLastName, email: idEmail, phone: idPhone,
        hasAccount: sql<boolean>`${patients.userId} is not null`,
      })
      .from(patients)
      .leftJoin(users, eq(patients.userId, users.id)) // walk-ins have no user account
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
        allergies: patients.allergies, createdAt: patients.createdAt, dobIsEstimated: patients.dobIsEstimated,
        userId: patients.userId,
        firstName: idFirstName, lastName: idLastName, email: idEmail, phone: idPhone,
      })
      .from(patients)
      .leftJoin(users, eq(patients.userId, users.id))
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
        status: appointments.status, reason: appointments.reason, department: departments.name, departmentId: appointments.departmentId,
      })
      .from(appointments)
      .innerJoin(departments, eq(appointments.departmentId, departments.id))
      .where(eq(appointments.patientId, id))
      .orderBy(desc(appointments.appointmentDate));

    const { userId: linkedUserId, ...shown } = patient;
    const hasAccount = !!linkedUserId;

    if (access.level === "basic") {
      const { allergies, bloodGroup, ...demographics } = shown;
      return sendSuccess(res, {
        ...demographics, hasAccount, accessLevel: "basic", accessReason: access.reason,
        appointments: patientAppointments.map((a) => ({ ...a, reason: null })),
        documents: [],
      });
    }

    const patientDocuments = await db.select().from(documents).where(eq(documents.patientId, id)).orderBy(desc(documents.createdAt));
    const consultationList = await consultationHistory(id, { limit: 50 });
    await audit(req, "patient.viewed", "patients", id, null, { via: access.reason });

    return sendSuccess(res, {
      ...shown, hasAccount, accessLevel: "clinical", accessReason: access.reason, accessExpiresAt: access.expiresAt ?? null,
      appointments: patientAppointments, documents: patientDocuments, consultations: consultationList,
    });
  } catch (err) {
    return handleError(res, err, "getPatientById");
  }
};

// ── Reception: register and edit patients (works for walk-ins with no online account) ──────────────────
const REGISTER_ROLES = ["receptionist", "nurse", "doctor", "admin"];
const genderValue = z.enum(["male", "female", "other"]);

const patientFields = {
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  dateOfBirth: dateStr.optional(),
  approxAge: z.number().int().min(0).max(120).optional(), // for people who don't know their date of birth
  gender: genderValue.optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(255).optional(),
  nationalId: z.string().trim().min(5).max(20).optional(),
  address: z.string().trim().max(500).optional(),
  nextOfKinName: z.string().trim().max(200).optional(),
  nextOfKinPhone: z.string().trim().max(20).optional(),
  nextOfKinRelation: z.string().trim().max(50).optional(),
  insuranceScheme: z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]).optional(),
  insuranceNumber: z.string().trim().max(100).optional(),
};

const registerSchema = z.object({
  ...patientFields,
  gender: genderValue,
  unidentified: z.boolean().optional(),          // emergency patient who cannot be identified yet
  confirmNotDuplicate: z.boolean().optional(),   // reception checked the possible matches and this is a new person
}).strict();

const updatePatientSchema = z.object(patientFields).strict();

/** Turn a date of birth or an approximate age into a stored date. */
function resolveDob(d: { dateOfBirth?: string; approxAge?: number }): { dob: string; estimated: boolean } | null {
  const today = todayEAT();
  if (d.dateOfBirth) {
    if (d.dateOfBirth > today) throw new HttpError(422, "Date of birth can't be in the future");
    return { dob: d.dateOfBirth, estimated: false };
  }
  if (d.approxAge !== undefined) {
    const dob = `${Number(today.slice(0, 4)) - d.approxAge}-07-01`; // mid-year: the least wrong guess
    return { dob: dob > today ? today : dob, estimated: true };
  }
  return null;
}

export const registerPatient = async (req: ClerkRequest, res: Response) => {
  try {
    if (!REGISTER_ROLES.includes(req.clerkUser!.role)) return deny(res);
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const unidentified = !!d.unidentified;
    if (!unidentified && (!d.firstName || !d.lastName)) return sendError(res, "Enter the patient's first and last name", 422);
    const dobInfo = resolveDob(d);
    if (!dobInfo) return sendError(res, "Enter a date of birth or an approximate age", 422);

    let phone: string | undefined;
    if (d.phone) {
      const n = normalizeKenyanPhone(d.phone);
      if (!n) return sendError(res, "Enter a valid Kenyan phone number, or leave it blank", 422);
      phone = n;
    }
    const firstName = unidentified ? "Unknown" : d.firstName!;
    const lastName = unidentified ? "Patient" : d.lastName!;

    const identity = {
      id: patients.id, patientNumber: patients.patientNumber, dateOfBirth: patients.dateOfBirth,
      firstName: idFirstName, lastName: idLastName, phone: idPhone,
    };

    // Hard duplicate: the same national ID can only belong to one patient.
    if (d.nationalId) {
      const [hit] = await db.select(identity).from(patients).leftJoin(users, eq(patients.userId, users.id)).where(eq(patients.nationalId, d.nationalId)).limit(1);
      if (hit) {
        return res.status(409).json({ success: false, code: "DUPLICATE_ID", error: "A patient with this national ID is already registered.", matches: [hit] });
      }
    }
    // Soft duplicate: same name + date of birth, or same phone + first name. Reception confirms before we create a second record.
    if (!unidentified && !d.confirmNotDuplicate) {
      const first = firstName.toLowerCase(), last = lastName.toLowerCase();
      const conds = [and(sql`lower(${idFirstName}) = ${first}`, sql`lower(${idLastName}) = ${last}`, eq(patients.dateOfBirth, dobInfo.dob))];
      if (phone) conds.push(and(sql`${idPhone} = ${phone}`, sql`lower(${idFirstName}) = ${first}`));
      const matches = await db.select(identity).from(patients).leftJoin(users, eq(patients.userId, users.id)).where(or(...conds)).limit(5);
      if (matches.length) {
        return res.status(409).json({ success: false, code: "POSSIBLE_DUPLICATE", error: "This person may already be registered.", matches });
      }
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(patients).values({
        userId: null,
        patientNumber: await nextNumber("PT", "patient_number_seq", 7, tx),
        firstName, lastName, phone, email: d.email,
        dateOfBirth: dobInfo.dob, dobIsEstimated: dobInfo.estimated,
        gender: d.gender,
        nationalId: d.nationalId,
        address: d.address,
        nextOfKinName: d.nextOfKinName, nextOfKinPhone: d.nextOfKinPhone, nextOfKinRelation: d.nextOfKinRelation,
        insuranceScheme: d.insuranceScheme, insuranceNumber: d.insuranceNumber,
        registeredBy: req.clerkUser!.dbUserId,
      }).returning({ id: patients.id, patientNumber: patients.patientNumber });
      return row;
    });

    await audit(req, "patient.registered", "patients", created.id, null, { patientNumber: created.patientNumber, unidentified });
    return sendSuccess(res, created, "Patient registered", 201);
  } catch (err) {
    return handleError(res, err, "registerPatient");
  }
};

export const updatePatient = async (req: ClerkRequest, res: Response) => {
  try {
    if (!REGISTER_ROLES.includes(req.clerkUser!.role)) return deny(res);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Patient not found", 404);
    const parsed = updatePatientSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const [patient] = await db.select({ id: patients.id, userId: patients.userId }).from(patients).where(eq(patients.id, id)).limit(1);
    if (!patient) return sendError(res, "Patient not found", 404);

    // Clinicians can only edit patients they are treating; front desk and admins can edit any registration.
    const access = await resolveAccess(req, id);
    if (access.level === "minimal") return sendError(res, "You are not currently assigned to this patient.", 403);

    if (patient.userId && (d.firstName || d.lastName || d.phone || d.email)) {
      return sendError(res, "Name, phone and email belong to the patient's online account. The patient can change them there.", 403);
    }

    const patch: Record<string, any> = {};
    if (!patient.userId) {
      if (d.firstName) patch.firstName = d.firstName;
      if (d.lastName) patch.lastName = d.lastName;
      if (d.email) patch.email = d.email;
      if (d.phone) {
        const n = normalizeKenyanPhone(d.phone);
        if (!n) return sendError(res, "Enter a valid Kenyan phone number", 422);
        patch.phone = n;
      }
    }
    const dobInfo = resolveDob(d);
    if (dobInfo) { patch.dateOfBirth = dobInfo.dob; patch.dobIsEstimated = dobInfo.estimated; }
    for (const k of ["gender", "nationalId", "address", "nextOfKinName", "nextOfKinPhone", "nextOfKinRelation", "insuranceScheme", "insuranceNumber"] as const) {
      if (d[k] !== undefined) patch[k] = d[k];
    }
    if (Object.keys(patch).length === 0) return sendError(res, "Nothing to update", 422);

    await db.update(patients).set(patch).where(eq(patients.id, id)); // unique violations (national ID) → 409 via handleError
    await audit(req, "patient.updated", "patients", id, null, { fields: Object.keys(patch) });
    return sendSuccess(res, { id }, "Patient updated");
  } catch (err) {
    return handleError(res, err, "updatePatient");
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
