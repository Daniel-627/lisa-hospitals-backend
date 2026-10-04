import { Response } from "express";
import { z } from "zod";
import { and, asc, count, desc, eq, ilike, ne, or } from "drizzle-orm";
import {
  db, users, staff, doctors, doctorAvailability, departments, patients,
  appointments, newsPosts, enquiries, auditLogs,
} from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getStaffByUserId, nextNumber } from "../utils/access";
import { audit } from "../utils/audit";
import { dateStr, isUuid, timeStr, todayEAT, uuid } from "../utils/validation";

// ── helpers ──────────────────────────────────────────────────────────────────
const ROLES = [
  "patient", "doctor", "nurse", "receptionist", "lab_technician",
  "radiographer", "pharmacist", "billing_officer", "admin",
] as const;
const roleEnum = z.enum(ROLES);

const paging = (req: ClerkRequest, def = 50, max = 200) => ({
  limit: Math.min(Math.max(parseInt(String(req.query.limit ?? def), 10) || def, 1), max),
  offset: Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0),
});

const httpsUrl = z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Links must start with https://");

const safeUser = {
  id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email,
  phone: users.phone, role: users.role, isActive: users.isActive, createdAt: users.createdAt,
};

// ── dashboard ────────────────────────────────────────────────────────────────
export const getAdminStats = async (_req: ClerkRequest, res: Response) => {
  try {
    const [byRole, [pat], [pending], [unread], [published], [drafts]] = await Promise.all([
      db.select({ role: users.role, count: count() }).from(users).groupBy(users.role),
      db.select({ count: count() }).from(patients),
      db.select({ count: count() }).from(appointments).where(eq(appointments.status, "pending")),
      db.select({ count: count() }).from(enquiries).where(eq(enquiries.isRead, false)),
      db.select({ count: count() }).from(newsPosts).where(eq(newsPosts.isPublished, true)),
      db.select({ count: count() }).from(newsPosts).where(eq(newsPosts.isPublished, false)),
    ]);
    const usersByRole: Record<string, number> = {};
    byRole.forEach((r) => { usersByRole[r.role] = r.count; });

    return sendSuccess(res, {
      totalUsers: byRole.reduce((s, r) => s + r.count, 0),
      usersByRole,
      patients: pat.count,
      pendingAppointments: pending.count,
      unreadEnquiries: unread.count,
      publishedPosts: published.count,
      draftPosts: drafts.count,
    });
  } catch (err) {
    return handleError(res, err, "getAdminStats");
  }
};

// ── users ────────────────────────────────────────────────────────────────────
export const listUsers = async (req: ClerkRequest, res: Response) => {
  try {
    const { limit, offset } = paging(req);
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const role = roleEnum.safeParse(req.query.role);

    const conds = [];
    if (q) conds.push(or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(users.email, like), ilike(users.phone, like)));
    if (role.success) conds.push(eq(users.role, role.data));

    const rows = await db
      .select({ ...safeUser, staffId: staff.id, doctorId: doctors.id })
      .from(users)
      .leftJoin(staff, eq(staff.userId, users.id))
      .leftJoin(doctors, eq(doctors.staffId, staff.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listUsers");
  }
};

export const getUserDetail = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "User not found", 404);

    const [user] = await db.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return sendError(res, "User not found", 404);

    const [staffRow] = await db.select().from(staff).where(eq(staff.userId, id)).limit(1);
    const [doctorRow] = staffRow ? await db.select().from(doctors).where(eq(doctors.staffId, staffRow.id)).limit(1) : [];
    const slots = doctorRow
      ? await db.select().from(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorRow.id))
          .orderBy(asc(doctorAvailability.dayOfWeek), asc(doctorAvailability.startTime))
      : [];

    return sendSuccess(res, { user, staff: staffRow ?? null, doctor: doctorRow ?? null, availability: slots });
  } catch (err) {
    return handleError(res, err, "getUserDetail");
  }
};

const updateUserSchema = z.object({ role: roleEnum.optional(), isActive: z.boolean().optional() }).strict();

export const updateUser = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "User not found", 404);
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid role or status", 422);
    const { role, isActive } = parsed.data;
    if (role === undefined && isActive === undefined) return sendError(res, "Nothing to update", 422);

    const [target] = await db.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
    if (!target) return sendError(res, "User not found", 404);

    if (id === req.clerkUser!.dbUserId && ((role !== undefined && role !== target.role) || isActive === false)) {
      return sendError(res, "You can't change your own role or deactivate your own account", 400);
    }

    const losingAdmin = target.role === "admin" && ((role !== undefined && role !== "admin") || isActive === false);
    if (losingAdmin) {
      const [others] = await db.select({ count: count() }).from(users)
        .where(and(eq(users.role, "admin"), eq(users.isActive, true), ne(users.id, id)));
      if (others.count < 1) return sendError(res, "At least one active admin must remain", 400);
    }

    const patch: Record<string, any> = {};
    if (role !== undefined) patch.role = role;
    if (isActive !== undefined) patch.isActive = isActive;

    const [updated] = await db.update(users).set(patch).where(eq(users.id, id)).returning(safeUser);
    await audit(req, role !== undefined && role !== target.role ? "user.role_changed" : "user.status_changed", "users", id,
      { role: target.role, isActive: target.isActive }, { role: updated.role, isActive: updated.isActive });

    return sendSuccess(res, updated, "User updated");
  } catch (err) {
    return handleError(res, err, "updateUser");
  }
};

// ── staff + doctor profiles ─────────────────────────────────────────────────
const staffCreateSchema = z.object({
  departmentId: uuid.optional(),
  qualification: z.string().trim().max(200).optional(),
  employedAt: dateStr.optional(),
});

async function assertDepartment(tx: any, departmentId?: string) {
  if (!departmentId) return;
  const [d] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, departmentId)).limit(1);
  if (!d) throw new HttpError(404, "Department not found");
}

export const createStaffProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "User not found", 404);
    const parsed = staffCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw new HttpError(404, "User not found");
      if (user.role === "patient") throw new HttpError(400, "Give this user a staff role first");
      if (await getStaffByUserId(id, tx)) throw new HttpError(409, "This user already has a staff profile");
      await assertDepartment(tx, parsed.data.departmentId);

      const [row] = await tx.insert(staff).values({
        userId: id,
        departmentId: parsed.data.departmentId,
        staffNumber: await nextNumber("STF", "staff_number_seq", 5, tx),
        qualification: parsed.data.qualification,
        employedAt: parsed.data.employedAt ?? todayEAT(),
      }).returning();
      return row;
    });

    await audit(req, "staff.created", "staff", created.id, null, { userId: id, staffNumber: created.staffNumber });
    return sendSuccess(res, created, "Staff profile created", 201);
  } catch (err) {
    return handleError(res, err, "createStaffProfile");
  }
};

const staffUpdateSchema = z.object({
  departmentId: uuid.nullable().optional(),
  qualification: z.string().trim().max(200).nullable().optional(),
}).strict();

export const updateStaffProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params; // user id
    if (!isUuid(id)) return sendError(res, "User not found", 404);
    const parsed = staffUpdateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const existing = await getStaffByUserId(id);
    if (!existing) return sendError(res, "Staff profile not found", 404);
    if (parsed.data.departmentId) await assertDepartment(db, parsed.data.departmentId);

    const patch: Record<string, any> = {};
    if (parsed.data.departmentId !== undefined) patch.departmentId = parsed.data.departmentId;
    if (parsed.data.qualification !== undefined) patch.qualification = parsed.data.qualification;
    if (Object.keys(patch).length === 0) return sendError(res, "Nothing to update", 422);

    const [updated] = await db.update(staff).set(patch).where(eq(staff.id, existing.id)).returning();
    await audit(req, "staff.updated", "staff", existing.id,
      { departmentId: existing.departmentId, qualification: existing.qualification }, patch);
    return sendSuccess(res, updated, "Staff profile updated");
  } catch (err) {
    return handleError(res, err, "updateStaffProfile");
  }
};

const doctorCreateSchema = z.object({
  departmentId: uuid,
  speciality: z.string().trim().min(2, "Enter the doctor's speciality").max(200),
  bio: z.string().trim().max(5000).optional(),
  photoUrl: httpsUrl.optional(),
  consultationFee: z.number().min(0).max(1_000_000).optional(),
});

export const createDoctorProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params; // user id
    if (!isUuid(id)) return sendError(res, "User not found", 404);
    const parsed = doctorCreateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.select(safeUser).from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw new HttpError(404, "User not found");
      if (user.role !== "doctor") throw new HttpError(400, "Set this user's role to Doctor first");
      await assertDepartment(tx, d.departmentId);

      // One click for the admin: create the staff profile too if it doesn't exist yet.
      let staffRow = await getStaffByUserId(id, tx);
      if (!staffRow) {
        [staffRow] = await tx.insert(staff).values({
          userId: id, departmentId: d.departmentId,
          staffNumber: await nextNumber("STF", "staff_number_seq", 5, tx),
          employedAt: todayEAT(),
        }).returning();
      }
      const [existing] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.staffId, staffRow.id)).limit(1);
      if (existing) throw new HttpError(409, "This user already has a doctor profile");

      const [row] = await tx.insert(doctors).values({
        staffId: staffRow.id,
        departmentId: d.departmentId,
        speciality: d.speciality,
        bio: d.bio,
        photoUrl: d.photoUrl,
        consultationFee: d.consultationFee === undefined ? undefined : String(d.consultationFee),
      }).returning();
      return row;
    });

    await audit(req, "doctor.created", "doctors", created.id, null, { userId: id, speciality: created.speciality });
    return sendSuccess(res, created, "Doctor profile created", 201);
  } catch (err) {
    return handleError(res, err, "createDoctorProfile");
  }
};

const doctorUpdateSchema = z.object({
  speciality: z.string().trim().min(2).max(200).optional(),
  departmentId: uuid.optional(),
  bio: z.string().trim().max(5000).nullable().optional(),
  photoUrl: httpsUrl.nullable().optional(),
  consultationFee: z.number().min(0).max(1_000_000).nullable().optional(),
  isAvailable: z.boolean().optional(),
}).strict();

export const updateDoctor = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params; // doctor id
    if (!isUuid(id)) return sendError(res, "Doctor not found", 404);
    const parsed = doctorUpdateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const [existing] = await db.select().from(doctors).where(eq(doctors.id, id)).limit(1);
    if (!existing) return sendError(res, "Doctor not found", 404);
    if (parsed.data.departmentId) await assertDepartment(db, parsed.data.departmentId);

    const d = parsed.data;
    const patch: Record<string, any> = {};
    if (d.speciality !== undefined) patch.speciality = d.speciality;
    if (d.departmentId !== undefined) patch.departmentId = d.departmentId;
    if (d.bio !== undefined) patch.bio = d.bio;
    if (d.photoUrl !== undefined) patch.photoUrl = d.photoUrl;
    if (d.consultationFee !== undefined) patch.consultationFee = d.consultationFee === null ? null : String(d.consultationFee);
    if (d.isAvailable !== undefined) patch.isAvailable = d.isAvailable;
    if (Object.keys(patch).length === 0) return sendError(res, "Nothing to update", 422);

    const [updated] = await db.update(doctors).set(patch).where(eq(doctors.id, id)).returning();
    await audit(req, "doctor.updated", "doctors", id,
      { speciality: existing.speciality, isAvailable: existing.isAvailable, departmentId: existing.departmentId }, patch);
    return sendSuccess(res, updated, "Doctor updated");
  } catch (err) {
    return handleError(res, err, "updateDoctor");
  }
};

const availabilitySchema = z.object({
  slots: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: timeStr,
    endTime: timeStr,
    maxSlots: z.number().int().min(1).max(200).default(20),
  })).max(28),
});

export const setDoctorAvailability = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params; // doctor id
    if (!isUuid(id)) return sendError(res, "Doctor not found", 404);
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const slots = [...parsed.data.slots].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].endTime <= slots[i].startTime) return sendError(res, "Each slot must end after it starts", 422);
      const prev = slots[i - 1];
      if (prev && prev.dayOfWeek === slots[i].dayOfWeek && slots[i].startTime < prev.endTime) {
        return sendError(res, "Time slots on the same day can't overlap", 422);
      }
    }

    const saved = await db.transaction(async (tx) => {
      const [doc] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, id)).limit(1);
      if (!doc) throw new HttpError(404, "Doctor not found");
      await tx.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, id));
      if (slots.length === 0) return [];
      return tx.insert(doctorAvailability).values(slots.map((s) => ({
        doctorId: id, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, maxSlots: s.maxSlots, isActive: true,
      }))).returning();
    });

    await audit(req, "doctor.availability_set", "doctor_availability", id, null, { slots: slots.length });
    return sendSuccess(res, saved, "Schedule saved");
  } catch (err) {
    return handleError(res, err, "setDoctorAvailability");
  }
};

// ── enquiries (contact form inbox) ───────────────────────────────────────────
export const listEnquiries = async (req: ClerkRequest, res: Response) => {
  try {
    const { limit, offset } = paging(req, 30, 100);
    const unreadOnly = req.query.unread === "true";
    const rows = await db.select().from(enquiries)
      .where(unreadOnly ? eq(enquiries.isRead, false) : undefined)
      .orderBy(desc(enquiries.createdAt))
      .limit(limit).offset(offset);
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listEnquiries");
  }
};

export const setEnquiryRead = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = z.object({ isRead: z.boolean() }).safeParse(req.body);
    if (!isUuid(id) || !parsed.success) return sendError(res, "Invalid request", 422);
    const [row] = await db.update(enquiries).set({ isRead: parsed.data.isRead }).where(eq(enquiries.id, id)).returning();
    if (!row) return sendError(res, "Message not found", 404);
    return sendSuccess(res, row);
  } catch (err) {
    return handleError(res, err, "setEnquiryRead");
  }
};

export const deleteEnquiry = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Message not found", 404);
    const [row] = await db.delete(enquiries).where(eq(enquiries.id, id)).returning({ id: enquiries.id, subject: enquiries.subject });
    if (!row) return sendError(res, "Message not found", 404);
    await audit(req, "enquiry.deleted", "enquiries", id, { subject: row.subject }, null);
    return sendSuccess(res, null, "Message deleted");
  } catch (err) {
    return handleError(res, err, "deleteEnquiry");
  }
};

// ── news ─────────────────────────────────────────────────────────────────────
const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "post";

async function uniqueSlug(base: string, excludeId?: string) {
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const [hit] = await db.select({ id: newsPosts.id }).from(newsPosts).where(eq(newsPosts.slug, slug)).limit(1);
    if (!hit || hit.id === excludeId) return slug;
    slug = `${base}-${i}`;
  }
  throw new HttpError(409, "Couldn't find a free web address for this title — enter one manually");
}

const slugRule = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,298}$/, "Web address can only use lowercase letters, numbers and hyphens");
const newsSchema = z.object({
  title: z.string().trim().min(3, "Enter a title").max(300),
  slug: slugRule.optional(),
  excerpt: z.string().trim().max(500).nullable().optional(),
  body: z.string().trim().min(1, "Write the article text").max(50000),
  coverImage: httpsUrl.nullable().optional(),
  isPublished: z.boolean().default(false),
});

export const listAllNews = async (req: ClerkRequest, res: Response) => {
  try {
    const { limit, offset } = paging(req, 50, 200);
    const rows = await db
      .select({
        id: newsPosts.id, title: newsPosts.title, slug: newsPosts.slug, isPublished: newsPosts.isPublished,
        publishedAt: newsPosts.publishedAt, createdAt: newsPosts.createdAt, updatedAt: newsPosts.updatedAt,
      })
      .from(newsPosts).orderBy(desc(newsPosts.updatedAt)).limit(limit).offset(offset);
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listAllNews");
  }
};

export const getNewsAdmin = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Article not found", 404);
    const [row] = await db.select().from(newsPosts).where(eq(newsPosts.id, id)).limit(1);
    if (!row) return sendError(res, "Article not found", 404);
    return sendSuccess(res, row);
  } catch (err) {
    return handleError(res, err, "getNewsAdmin");
  }
};

export const createNews = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = newsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const slug = await uniqueSlug(d.slug ?? slugify(d.title));
    const author = await getStaffByUserId(req.clerkUser!.dbUserId);

    const [row] = await db.insert(newsPosts).values({
      authorId: author?.id ?? null,
      title: d.title, slug, excerpt: d.excerpt ?? null, body: d.body, coverImage: d.coverImage ?? null,
      isPublished: d.isPublished,
      publishedAt: d.isPublished ? new Date() : null,
    }).returning();

    await audit(req, d.isPublished ? "news.published" : "news.created", "news_posts", row.id, null, { title: row.title, slug: row.slug });
    return sendSuccess(res, row, "Article saved", 201);
  } catch (err) {
    return handleError(res, err, "createNews");
  }
};

export const updateNews = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Article not found", 404);
    const parsed = newsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;

    const [existing] = await db.select().from(newsPosts).where(eq(newsPosts.id, id)).limit(1);
    if (!existing) return sendError(res, "Article not found", 404);

    let slug = existing.slug;
    if (d.slug && d.slug !== existing.slug) {
      const [clash] = await db.select({ id: newsPosts.id }).from(newsPosts).where(and(eq(newsPosts.slug, d.slug), ne(newsPosts.id, id))).limit(1);
      if (clash) return sendError(res, "That web address is already used by another article", 409);
      slug = d.slug;
    }

    const [row] = await db.update(newsPosts).set({
      title: d.title, slug, excerpt: d.excerpt ?? null, body: d.body, coverImage: d.coverImage ?? null,
      isPublished: d.isPublished,
      // First publish stamps the date; later edits and unpublish/republish keep the original date.
      publishedAt: d.isPublished && !existing.publishedAt ? new Date() : existing.publishedAt,
    }).where(eq(newsPosts.id, id)).returning();

    const action = d.isPublished !== existing.isPublished ? (d.isPublished ? "news.published" : "news.unpublished") : "news.updated";
    await audit(req, action, "news_posts", id, { title: existing.title, isPublished: existing.isPublished }, { title: row.title, isPublished: row.isPublished });
    return sendSuccess(res, row, "Article saved");
  } catch (err) {
    return handleError(res, err, "updateNews");
  }
};

export const deleteNews = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Article not found", 404);
    const [row] = await db.delete(newsPosts).where(eq(newsPosts.id, id)).returning({ id: newsPosts.id, title: newsPosts.title });
    if (!row) return sendError(res, "Article not found", 404);
    await audit(req, "news.deleted", "news_posts", id, { title: row.title }, null);
    return sendSuccess(res, null, "Article deleted");
  } catch (err) {
    return handleError(res, err, "deleteNews");
  }
};

// ── audit log viewer ─────────────────────────────────────────────────────────
export const listAuditLogs = async (req: ClerkRequest, res: Response) => {
  try {
    const { limit, offset } = paging(req, 50, 200);
    const action = String(req.query.action ?? "").trim().slice(0, 100);

    const rows = await db
      .select({
        id: auditLogs.id, action: auditLogs.action, table: auditLogs.table, recordId: auditLogs.recordId,
        oldValues: auditLogs.oldValues, newValues: auditLogs.newValues, ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt, userFirstName: users.firstName, userLastName: users.lastName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(action ? eq(auditLogs.action, action) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit).offset(offset);

    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listAuditLogs");
  }
};
