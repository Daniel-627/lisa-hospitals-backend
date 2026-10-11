import { Response } from "express";
import { z } from "zod";
import { and, desc, eq, gt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, accessGrants, accessRequests, doctors, patients, staff, users } from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { audit } from "../utils/audit";
import { idFirstName, idLastName } from "../utils/patientIdentity";
import { primaryDoctorFor, primaryReason, resolveAccess, SHARE_HOURS } from "../utils/patientAccess";
import { isUuid, uuid } from "../utils/validation";

const doctorOnly = (req: ClerkRequest) => {
  if (req.clerkUser!.role !== "doctor") throw new HttpError(403, "Only doctors can do this");
};
const myName = (req: ClerkRequest) => `Dr. ${req.clerkUser!.firstName} ${req.clerkUser!.lastName}`;
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600 * 1000);

// A doctor asks the treating doctor to share the record.
export const requestAccess = async (req: ClerkRequest, res: Response) => {
  try {
    doctorOnly(req);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Patient not found", 404);
    const parsed = z.object({ message: z.string().trim().max(500).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return sendError(res, "Invalid message", 422);

    const [patient] = await db.select({ id: patients.id }).from(patients).where(eq(patients.id, id)).limit(1);
    if (!patient) return sendError(res, "Patient not found", 404);
    if ((await resolveAccess(req, id)).level === "clinical") return sendError(res, "You already have access to this record", 409);

    const primary = await primaryDoctorFor(id);
    if (!primary) return sendError(res, "No doctor is treating this patient right now. Pick them up from the queue to open their record, or use emergency access.", 409);
    if (primary.userId === req.clerkUser!.dbUserId) return sendError(res, "You are the treating doctor", 409);

    const [pending] = await db.select({ id: accessRequests.id }).from(accessRequests)
      .where(and(eq(accessRequests.patientId, id), eq(accessRequests.requesterId, req.clerkUser!.dbUserId), eq(accessRequests.status, "pending"))).limit(1);
    if (pending) return sendSuccess(res, { id: pending.id }, "You have already asked. Waiting for the treating doctor.");

    const [row] = await db.insert(accessRequests).values({
      patientId: id, requesterId: req.clerkUser!.dbUserId, primaryUserId: primary.userId, message: parsed.data.message || null,
    }).returning({ id: accessRequests.id });
    await audit(req, "access.requested", "patients", id, null, { from: myName(req) });
    return sendSuccess(res, row, `Request sent to Dr. ${primary.firstName} ${primary.lastName}`, 201);
  } catch (err) {
    return handleError(res, err, "requestAccess");
  }
};

// Requests waiting for ME (the treating doctor).
export const listAccessRequests = async (req: ClerkRequest, res: Response) => {
  try {
    doctorOnly(req);
    const requester = alias(users, "requester_user");
    const rows = await db
      .select({
        id: accessRequests.id, patientId: patients.id, patientNumber: patients.patientNumber, message: accessRequests.message, createdAt: accessRequests.createdAt,
        patientFirst: idFirstName, patientLast: idLastName, requesterFirst: requester.firstName, requesterLast: requester.lastName,
      })
      .from(accessRequests)
      .innerJoin(patients, eq(accessRequests.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id))
      .innerJoin(requester, eq(accessRequests.requesterId, requester.id))
      .where(and(eq(accessRequests.primaryUserId, req.clerkUser!.dbUserId), eq(accessRequests.status, "pending")))
      .orderBy(desc(accessRequests.createdAt));
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listAccessRequests");
  }
};

export const decideAccessRequest = async (req: ClerkRequest, res: Response) => {
  try {
    doctorOnly(req);
    const { id } = req.params;
    const parsed = z.object({ approve: z.boolean() }).safeParse(req.body);
    if (!isUuid(id) || !parsed.success) return sendError(res, "Invalid request", 422);

    const [request] = await db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
    if (!request || request.primaryUserId !== req.clerkUser!.dbUserId) return sendError(res, "Request not found", 404);
    if (request.status !== "pending") return sendError(res, "This request was already answered", 409);

    await db.transaction(async (tx) => {
      await tx.update(accessRequests).set({ status: parsed.data.approve ? "approved" : "denied", decidedAt: new Date() }).where(eq(accessRequests.id, id));
      if (parsed.data.approve) {
        await tx.insert(accessGrants).values({
          userId: request.requesterId, patientId: request.patientId, kind: "shared", grantedBy: req.clerkUser!.dbUserId,
          reason: `Shared by ${myName(req)}`, expiresAt: hoursFromNow(SHARE_HOURS),
        });
      }
    });
    await audit(req, parsed.data.approve ? "access.shared" : "access.denied", "patients", request.patientId, null, { requester: request.requesterId });
    return sendSuccess(res, { id }, parsed.data.approve ? `Access shared for ${SHARE_HOURS} hours` : "Request denied");
  } catch (err) {
    return handleError(res, err, "decideAccessRequest");
  }
};

// The treating doctor shares the record without waiting to be asked (e.g. to get a colleague's opinion).
export const shareRecord = async (req: ClerkRequest, res: Response) => {
  try {
    doctorOnly(req);
    const { id } = req.params;
    const parsed = z.object({ doctorId: uuid }).safeParse(req.body);
    if (!isUuid(id) || !parsed.success) return sendError(res, "Choose a doctor to share with", 422);

    // Only the primary doctor can share. A doctor who was themselves given access can't pass it on.
    if (!(await primaryReason(req.clerkUser!.dbUserId, id))) return sendError(res, "Only the treating doctor can share this record", 403);

    const [target] = await db.select({ userId: staff.userId, first: users.firstName, last: users.lastName })
      .from(doctors).innerJoin(staff, eq(doctors.staffId, staff.id)).innerJoin(users, eq(staff.userId, users.id))
      .where(eq(doctors.id, parsed.data.doctorId)).limit(1);
    if (!target) return sendError(res, "Doctor not found", 404);
    if (target.userId === req.clerkUser!.dbUserId) return sendError(res, "You already have access", 422);

    const [grant] = await db.insert(accessGrants).values({
      userId: target.userId, patientId: id, kind: "shared", grantedBy: req.clerkUser!.dbUserId,
      reason: `Shared by ${myName(req)}`, expiresAt: hoursFromNow(SHARE_HOURS),
    }).returning({ id: accessGrants.id, expiresAt: accessGrants.expiresAt });
    await audit(req, "access.shared", "patients", id, null, { with: `Dr. ${target.first} ${target.last}` });
    return sendSuccess(res, grant, `Shared with Dr. ${target.first} ${target.last} for ${SHARE_HOURS} hours`, 201);
  } catch (err) {
    return handleError(res, err, "shareRecord");
  }
};

export const revokeShare = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Share not found", 404);
    const [grant] = await db.select().from(accessGrants).where(and(eq(accessGrants.id, id), eq(accessGrants.kind, "shared"), gt(accessGrants.expiresAt, new Date()))).limit(1);
    if (!grant) return sendError(res, "Share not found", 404);
    if (grant.grantedBy !== req.clerkUser!.dbUserId && req.clerkUser!.role !== "admin") return sendError(res, "Only the doctor who shared this can take it back", 403);
    await db.update(accessGrants).set({ expiresAt: new Date() }).where(eq(accessGrants.id, id));
    await audit(req, "access.revoked", "patients", grant.patientId, null, { grantId: id });
    return sendSuccess(res, { id }, "Access removed");
  } catch (err) {
    return handleError(res, err, "revokeShare");
  }
};
