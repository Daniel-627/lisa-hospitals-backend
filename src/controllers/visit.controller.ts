import { Response } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, visits, patients, users, departments, doctors, staff, appointments, triageRecords } from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getStaffByUserId, nextNumber } from "../utils/access";
import { audit } from "../utils/audit";
import { idFirstName, idLastName } from "../utils/patientIdentity";
import { whoAmI } from "../utils/patientAccess";
import { isUuid, todayEAT, uuid } from "../utils/validation";

const CHECKIN_ROLES = ["receptionist", "nurse", "doctor", "admin"];
const CLINICAL_ROLES = ["nurse", "doctor"];

const deny = (res: Response) => sendError(res, "Access denied", 403);

// ── Check in ─────────────────────────────────────────────────────────────────
const checkInSchema = z.object({
  patientId: uuid,
  departmentId: uuid.optional(),
  appointmentId: uuid.optional(),
  doctorId: uuid.optional(),            // optional: ask for a specific doctor
  isPriority: z.boolean().optional(),   // emergency / needs to be seen first
  reason: z.string().trim().max(300).optional(),
}).strict();

export const checkIn = async (req: ClerkRequest, res: Response) => {
  try {
    if (!CHECKIN_ROLES.includes(req.clerkUser!.role)) return deny(res);
    const parsed = checkInSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    if (!d.appointmentId && !d.departmentId) return sendError(res, "Choose a department", 422);

    // Clinicians only check patients into their own department (front desk and admins: any).
    if (CLINICAL_ROLES.includes(req.clerkUser!.role) && d.departmentId) {
      const me = await whoAmI(req.clerkUser!.dbUserId, req.clerkUser!.role);
      if (me.departmentId && me.departmentId !== d.departmentId && !d.appointmentId) {
        return sendError(res, "You can only check patients into your own department", 403);
      }
    }

    const today = todayEAT();

    const visit = await db.transaction(async (tx) => {
      const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, d.patientId)).limit(1);
      if (!patient) throw new HttpError(404, "Patient not found");

      let departmentId = d.departmentId;
      let doctorId = d.doctorId;

      if (d.appointmentId) {
        const [appt] = await tx.select().from(appointments).where(eq(appointments.id, d.appointmentId)).limit(1);
        if (!appt || appt.patientId !== d.patientId) throw new HttpError(404, "Appointment not found for this patient");
        if (!["pending", "confirmed"].includes(appt.status)) throw new HttpError(409, `This appointment is ${appt.status.replace("_", " ")}`);
        if (appt.appointmentDate !== today) throw new HttpError(409, "This appointment is not for today");
        if (departmentId && departmentId !== appt.departmentId) throw new HttpError(422, "That department doesn't match the appointment");
        departmentId = appt.departmentId;
        doctorId = doctorId ?? appt.doctorId ?? undefined;
      }

      const [dept] = await tx.select({ id: departments.id, name: departments.name }).from(departments)
        .where(and(eq(departments.id, departmentId!), eq(departments.isActive, true))).limit(1);
      if (!dept) throw new HttpError(404, "Department not found");

      if (doctorId) {
        const [doc] = await tx.select({ id: doctors.id, departmentId: doctors.departmentId }).from(doctors).where(eq(doctors.id, doctorId)).limit(1);
        if (!doc || doc.departmentId !== dept.id) throw new HttpError(422, "That doctor doesn't work in this department");
      }

      // Serialise queue numbering per department per day, so two desks can't issue the same number.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`queue:${dept.id}:${today}`}))`);

      const [already] = await tx.select({ n: visits.queueNumber }).from(visits)
        .where(and(eq(visits.patientId, d.patientId), eq(visits.departmentId, dept.id), eq(visits.queueDate, today), inArray(visits.status, ["waiting", "in_triage", "triaged", "in_progress"]))).limit(1);
      if (already) throw new HttpError(409, `Already checked in to ${dept.name} (queue #${already.n})`);

      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${visits.queueNumber}), 0) + 1` }).from(visits)
        .where(and(eq(visits.departmentId, dept.id), eq(visits.queueDate, today)));

      const [row] = await tx.insert(visits).values({
        patientId: d.patientId,
        appointmentId: d.appointmentId,
        departmentId: dept.id,
        visitNumber: await nextNumber("VIS", "visit_number_seq", 9, tx),
        status: "waiting",
        queueNumber: Number(next),
        queueDate: today,
        isPriority: !!d.isPriority,
        reason: d.reason,
        assignedDoctorId: doctorId,
        checkedInBy: req.clerkUser!.dbUserId,
      }).returning({ id: visits.id, visitNumber: visits.visitNumber, queueNumber: visits.queueNumber });

      if (d.appointmentId) {
        await tx.update(appointments).set({ status: "confirmed", updatedAt: new Date() })
          .where(and(eq(appointments.id, d.appointmentId), eq(appointments.status, "pending")));
      }
      return { ...row, department: dept.name, departmentId: dept.id };
    });

    await audit(req, "visit.checked_in", "visits", visit.id, null, { patientId: d.patientId, department: visit.department, queueNumber: visit.queueNumber, priority: !!d.isPriority });
    return sendSuccess(res, visit, "Checked in", 201);
  } catch (err) {
    return handleError(res, err, "checkIn");
  }
};

// ── The queue board ──────────────────────────────────────────────────────────
const doctorUser = alias(users, "doctor_user");

// The latest triage record for each visit (urgency drives the order patients are seen in).
const latestUrgency = sql<string | null>`(select ${triageRecords.urgencyLevel} from ${triageRecords} where ${triageRecords.visitId} = ${visits.id} order by ${triageRecords.createdAt} desc limit 1)`;
const latestComplaint = sql<string | null>`(select ${triageRecords.chiefComplaint} from ${triageRecords} where ${triageRecords.visitId} = ${visits.id} order by ${triageRecords.createdAt} desc limit 1)`;

export const getQueue = async (req: ClerkRequest, res: Response) => {
  try {
    const { role, dbUserId } = req.clerkUser!;
    if (!CHECKIN_ROLES.includes(role)) return deny(res);

    // Doctors and nurses see only their own department. Front desk and admins can see any, or all.
    let departmentId: string | undefined = isUuid(req.query.departmentId) ? String(req.query.departmentId) : undefined;
    if (CLINICAL_ROLES.includes(role)) {
      const me = await whoAmI(dbUserId, role);
      if (!me.departmentId) return sendSuccess(res, { visits: [], departmentId: null, note: "You are not assigned to a department yet. Ask an admin to set your department." });
      departmentId = me.departmentId;
    }

    const today = todayEAT();
    const open = ["waiting", "in_triage", "triaged", "in_progress"];
    const statuses = req.query.done === "true" ? [...open, "completed", "left"] : open;
    const showReason = CLINICAL_ROLES.includes(role);

    const rows = await db
      .select({
        id: visits.id, visitNumber: visits.visitNumber, queueNumber: visits.queueNumber, status: visits.status,
        isPriority: visits.isPriority, arrivedAt: visits.arrivedAt, calledAt: visits.calledAt, departedAt: visits.departedAt,
        reason: visits.reason, assignedDoctorId: visits.assignedDoctorId,
        urgencyLevel: latestUrgency, chiefComplaint: latestComplaint,
        departmentId: visits.departmentId, department: departments.name,
        patientId: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
        firstName: idFirstName, lastName: idLastName,
        doctorFirstName: doctorUser.firstName, doctorLastName: doctorUser.lastName,
      })
      .from(visits)
      .innerJoin(patients, eq(visits.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(departments, eq(visits.departmentId, departments.id))
      .leftJoin(doctors, eq(visits.assignedDoctorId, doctors.id))
      .leftJoin(staff, eq(doctors.staffId, staff.id))
      .leftJoin(doctorUser, eq(staff.userId, doctorUser.id))
      .where(and(
        eq(visits.queueDate, today),
        inArray(visits.status, statuses as any),
        departmentId ? eq(visits.departmentId, departmentId) : undefined,
      ))
      // Emergencies first, then by triage urgency (most urgent first; not-yet-triaged last), then first-come-first-served.
      .orderBy(desc(visits.isPriority), sql`${latestUrgency} asc nulls last`, asc(visits.arrivedAt));

    // Why they came / their complaint is clinical: front desk and admins never see it.
    const out = rows.map(({ chiefComplaint, ...r }) => ({ ...r, reason: showReason ? (chiefComplaint ?? r.reason) : null }));
    return sendSuccess(res, { visits: out, departmentId: departmentId ?? null });
  } catch (err) {
    return handleError(res, err, "getQueue");
  }
};

// ── Clinician actions ────────────────────────────────────────────────────────
async function loadVisitForClinician(req: ClerkRequest, id: string) {
  if (!CLINICAL_ROLES.includes(req.clerkUser!.role)) throw new HttpError(403, "Access denied");
  if (!isUuid(id)) throw new HttpError(404, "Visit not found");
  const [visit] = await db.select().from(visits).where(eq(visits.id, id)).limit(1);
  if (!visit) throw new HttpError(404, "Visit not found");
  const me = await whoAmI(req.clerkUser!.dbUserId, req.clerkUser!.role);
  if (!me.departmentId || me.departmentId !== visit.departmentId) throw new HttpError(403, "This patient is in a different department");
  return { visit, me };
}

export const pickUp = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, me } = await loadVisitForClinician(req, req.params.id);
    const [updated] = await db.update(visits)
      .set({ status: "in_progress", calledAt: new Date(), assignedDoctorId: me.doctorId ?? visit.assignedDoctorId })
      // only if still available: two clinicians can't both take the same patient
      .where(and(eq(visits.id, visit.id), inArray(visits.status, req.clerkUser!.role === "doctor" ? ["waiting", "triaged"] : ["waiting"])))
      .returning({ id: visits.id });
    if (!updated) return sendError(res, "This patient was already picked up", 409);
    await audit(req, "visit.picked_up", "visits", visit.id, null, { patientId: visit.patientId });
    return sendSuccess(res, { id: visit.id }, "Patient picked up");
  } catch (err) {
    return handleError(res, err, "pickUp");
  }
};

export const releaseVisit = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, me } = await loadVisitForClinician(req, req.params.id);
    if (visit.assignedDoctorId && me.doctorId && visit.assignedDoctorId !== me.doctorId) {
      return sendError(res, "This patient is assigned to another doctor", 403);
    }
    const [wasTriaged] = await db.select({ id: triageRecords.id }).from(triageRecords).where(eq(triageRecords.visitId, visit.id)).limit(1);
    const [updated] = await db.update(visits)
      .set({ status: wasTriaged ? "triaged" : "waiting", calledAt: null, assignedDoctorId: null })
      .where(and(eq(visits.id, visit.id), eq(visits.status, "in_progress"))).returning({ id: visits.id });
    if (!updated) return sendError(res, "This patient is not in progress", 409);
    await audit(req, "visit.released", "visits", visit.id, null, { patientId: visit.patientId });
    return sendSuccess(res, { id: visit.id }, "Returned to the queue");
  } catch (err) {
    return handleError(res, err, "releaseVisit");
  }
};

export const completeVisit = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit, me } = await loadVisitForClinician(req, req.params.id);
    if (visit.assignedDoctorId && me.doctorId && visit.assignedDoctorId !== me.doctorId) {
      return sendError(res, "This patient is assigned to another doctor", 403);
    }
    const [updated] = await db.update(visits)
      .set({ status: "completed", departedAt: new Date() })
      .where(and(eq(visits.id, visit.id), eq(visits.status, "in_progress"))).returning({ id: visits.id });
    if (!updated) return sendError(res, "Pick the patient up before completing the visit", 409);
    if (visit.appointmentId) {
      await db.update(appointments).set({ status: "completed", updatedAt: new Date() }).where(eq(appointments.id, visit.appointmentId));
    }
    await audit(req, "visit.completed", "visits", visit.id, null, { patientId: visit.patientId });
    return sendSuccess(res, { id: visit.id }, "Visit completed");
  } catch (err) {
    return handleError(res, err, "completeVisit");
  }
};

// Patient walked out before being seen (front desk, nurses, doctors, admins).
export const markLeft = async (req: ClerkRequest, res: Response) => {
  try {
    if (!CHECKIN_ROLES.includes(req.clerkUser!.role)) return deny(res);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Visit not found", 404);

    const [visit] = await db.select().from(visits).where(eq(visits.id, id)).limit(1);
    if (!visit) return sendError(res, "Visit not found", 404);
    if (CLINICAL_ROLES.includes(req.clerkUser!.role)) {
      const me = await whoAmI(req.clerkUser!.dbUserId, req.clerkUser!.role);
      if (me.departmentId !== visit.departmentId) return sendError(res, "This patient is in a different department", 403);
    }
    const [updated] = await db.update(visits).set({ status: "left", departedAt: new Date() })
      .where(and(eq(visits.id, id), inArray(visits.status, ["waiting", "in_triage", "triaged", "in_progress"]))).returning({ id: visits.id });
    if (!updated) return sendError(res, "This visit is already closed", 409);
    await audit(req, "visit.left", "visits", id, null, { patientId: visit.patientId });
    return sendSuccess(res, { id }, "Marked as left");
  } catch (err) {
    return handleError(res, err, "markLeft");
  }
};

// ── Triage (nurse takes vitals and sets how urgent the patient is) ───────────
export const getVisitDetail = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit } = await loadVisitForClinician(req, req.params.id);
    if (visit.departedAt) return sendError(res, "This visit is closed", 409);

    const [row] = await db
      .select({
        patientId: patients.id, patientNumber: patients.patientNumber, gender: patients.gender, dateOfBirth: patients.dateOfBirth,
        allergies: patients.allergies, bloodGroup: patients.bloodGroup, firstName: idFirstName, lastName: idLastName,
        department: departments.name,
      })
      .from(patients)
      .leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(departments, eq(departments.id, visit.departmentId))
      .where(eq(patients.id, visit.patientId)).limit(1);

    const [latest] = await db.select().from(triageRecords).where(eq(triageRecords.visitId, visit.id)).orderBy(desc(triageRecords.createdAt)).limit(1);
    return sendSuccess(res, {
      visit: { id: visit.id, visitNumber: visit.visitNumber, queueNumber: visit.queueNumber, status: visit.status, isPriority: visit.isPriority, reason: visit.reason, arrivedAt: visit.arrivedAt },
      patient: row,
      triage: latest ?? null,
    });
  } catch (err) {
    return handleError(res, err, "getVisitDetail");
  }
};

export const startTriage = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit } = await loadVisitForClinician(req, req.params.id);
    const [updated] = await db.update(visits).set({ status: "in_triage", calledAt: new Date() })
      .where(and(eq(visits.id, visit.id), eq(visits.status, "waiting"))).returning({ id: visits.id });
    if (!updated) return sendError(res, "This patient is no longer waiting for triage", 409);
    await audit(req, "triage.started", "visits", visit.id, null, { patientId: visit.patientId });
    return sendSuccess(res, { id: visit.id }, "Triage started");
  } catch (err) {
    return handleError(res, err, "startTriage");
  }
};

export const cancelTriage = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit } = await loadVisitForClinician(req, req.params.id);
    const [updated] = await db.update(visits).set({ status: "waiting", calledAt: null })
      .where(and(eq(visits.id, visit.id), eq(visits.status, "in_triage"))).returning({ id: visits.id });
    if (!updated) return sendError(res, "This patient is not in triage", 409);
    return sendSuccess(res, { id: visit.id }, "Returned to the queue");
  } catch (err) {
    return handleError(res, err, "cancelTriage");
  }
};

const URGENCY = ["1_critical", "2_emergent", "3_urgent", "4_semi_urgent", "5_non_urgent"] as const;
const triageSchema = z.object({
  temperature: z.number().min(25).max(45).optional(),            // °C
  bloodPressure: z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/, "Blood pressure should look like 120/80").optional(),
  pulseRate: z.number().int().min(20).max(300).optional(),       // beats per minute
  oxygenSaturation: z.number().min(0).max(100).optional(),       // SpO2 %
  weight: z.number().min(0.3).max(500).optional(),               // kg
  height: z.number().min(20).max(260).optional(),                // cm
  urgencyLevel: z.enum(URGENCY),
  chiefComplaint: z.string().trim().max(2000).optional(),
}).strict();

export const recordTriage = async (req: ClerkRequest, res: Response) => {
  try {
    const { visit } = await loadVisitForClinician(req, req.params.id);
    const parsed = triageSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const nurse = await getStaffByUserId(req.clerkUser!.dbUserId);
    const emergency = d.urgencyLevel === "1_critical" || d.urgencyLevel === "2_emergent";

    await db.transaction(async (tx) => {
      // Allowed while in triage, or to re-triage a patient who is already waiting for the doctor (they may get worse).
      const [updated] = await tx.update(visits)
        .set({ status: "triaged", isPriority: sql<boolean>`${visits.isPriority} or ${emergency}` })
        .where(and(eq(visits.id, visit.id), inArray(visits.status, ["in_triage", "triaged"]))).returning({ id: visits.id });
      if (!updated) throw new HttpError(409, "Start triage on this patient first");

      await tx.insert(triageRecords).values({
        visitId: visit.id,
        nurseId: nurse?.id ?? null,
        temperature: d.temperature === undefined ? undefined : d.temperature.toFixed(1),
        bloodPressure: d.bloodPressure,
        pulseRate: d.pulseRate,
        oxygenSaturation: d.oxygenSaturation === undefined ? undefined : d.oxygenSaturation.toFixed(1),
        weight: d.weight === undefined ? undefined : d.weight.toFixed(2),
        height: d.height === undefined ? undefined : d.height.toFixed(2),
        urgencyLevel: d.urgencyLevel,
        chiefComplaint: d.chiefComplaint,
      });
    });

    await audit(req, "triage.recorded", "visits", visit.id, null, { urgency: d.urgencyLevel });
    return sendSuccess(res, { id: visit.id }, "Triage saved", 201);
  } catch (err) {
    return handleError(res, err, "recordTriage");
  }
};
