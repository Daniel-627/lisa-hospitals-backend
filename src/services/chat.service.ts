import { and, asc, desc, eq, gt, ilike, or, sql } from "drizzle-orm";
import { db, bookings, chatMessages, chatThreads, departments, doctors, staff, users } from "../db";
import { HttpError } from "../utils/errors";
import { normalizeKenyanPhone } from "../utils/validation";

const MAX_BODY = 2000;
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim() : "");

/** The patient's single thread (created on first use). */
async function threadFor(userId: string) {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  if (t) return t;
  await db.insert(chatThreads).values({ patientUserId: userId }).onConflictDoNothing();
  const [made] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  return made;
}

async function append(threadId: string, sender: "patient" | "staff", senderUserId: string, raw: unknown) {
  const body = clean(raw);
  if (!body) throw new HttpError(422, "Type a message first");
  if (body.length > MAX_BODY) throw new HttpError(422, `Please keep messages under ${MAX_BODY} characters`);
  const [m] = await db.insert(chatMessages).values({ threadId, sender, senderUserId, body }).returning();
  const read = sender === "patient" ? { patientReadAt: m.createdAt } : { staffReadAt: m.createdAt };
  await db.update(chatThreads).set({ lastMessageAt: m.createdAt, lastSender: sender, ...read }).where(eq(chatThreads.id, threadId));
  return m;
}

/** What the PATIENT gets: no staff identity at all, every reply is simply "Lisa". */
const forPatient = (m: typeof chatMessages.$inferSelect) => ({
  id: m.id, from: m.sender === "patient" ? "you" : "lisa", body: m.body, createdAt: m.createdAt,
});

export async function patientMessages(userId: string, after?: string) {
  const t = await threadFor(userId);
  const since = after ? new Date(after) : null;
  const rows = await db.select().from(chatMessages)
    .where(since && !isNaN(+since) ? and(eq(chatMessages.threadId, t.id), gt(chatMessages.createdAt, since)) : eq(chatMessages.threadId, t.id))
    .orderBy(asc(chatMessages.createdAt)).limit(500);
  return rows.map(forPatient);
}

export async function patientSend(userId: string, body: unknown) {
  const t = await threadFor(userId);
  return forPatient(await append(t.id, "patient", userId, body));
}

export async function patientMarkRead(userId: string) {
  const t = await threadFor(userId);
  await db.update(chatThreads).set({ patientReadAt: new Date() }).where(eq(chatThreads.id, t.id));
}

export async function patientUnread(userId: string) {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  return !!t && t.lastSender === "staff" && (!t.patientReadAt || t.patientReadAt < t.lastMessageAt);
}

// ── Staff side ────────────────────────────────────────────────────────────────
const STAFF_ROLE_LABEL: Record<string, string> = {
  admin: "Admin", receptionist: "Receptionist / Secretary", doctor: "Doctor", nurse: "Nurse",
};

export async function staffThreads(q?: string) {
  const term = clean(q);
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  const rows = await db.select({
    id: chatThreads.id, lastMessageAt: chatThreads.lastMessageAt, lastSender: chatThreads.lastSender, staffReadAt: chatThreads.staffReadAt,
    firstName: users.firstName, lastName: users.lastName, phone: users.phone,
    preview: sql<string>`(select left(body, 90) from chat_messages m where m.thread_id = ${chatThreads.id} order by m.created_at desc limit 1)`,
  }).from(chatThreads).innerJoin(users, eq(users.id, chatThreads.patientUserId))
    .where(like ? or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(users.phone, like), sql`${users.firstName} || ' ' || ${users.lastName} ilike ${like}`) : undefined)
    .orderBy(desc(chatThreads.lastMessageAt)).limit(200);
  return rows.map((r) => ({
    id: r.id, patientName: `${r.firstName} ${r.lastName}`, phone: r.phone, preview: r.preview, lastMessageAt: r.lastMessageAt,
    lastSender: r.lastSender, unread: r.lastSender === "patient" && (!r.staffReadAt || r.staffReadAt < r.lastMessageAt),
  }));
}

export async function staffUnreadCount() {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(chatThreads)
    .where(and(eq(chatThreads.lastSender, "patient"), or(sql`${chatThreads.staffReadAt} is null`, sql`${chatThreads.staffReadAt} < ${chatThreads.lastMessageAt}`)));
  return r?.n ?? 0;
}

export async function visitsFor(phone: string, email: string) {
  const p = normalizeKenyanPhone(phone) ?? phone;
  return db.select({
    id: bookings.id, reference: bookings.reference, slotDate: bookings.slotDate, slotTime: bookings.slotTime, status: bookings.status,
    checkedInAt: bookings.checkedInAt, department: departments.name, doctorFirst: users.firstName, doctorLast: users.lastName,
    cancelReason: bookings.cancelReason, reason: bookings.reason,
  }).from(bookings)
    .innerJoin(departments, eq(departments.id, bookings.departmentId))
    .innerJoin(doctors, eq(doctors.id, bookings.doctorId))
    .innerJoin(staff, eq(staff.id, doctors.staffId))
    .innerJoin(users, eq(users.id, staff.userId))
    .where(or(eq(bookings.guestPhone, p), sql`lower(${bookings.guestEmail}) = ${email.toLowerCase()}`))
    .orderBy(desc(bookings.slotDate), desc(bookings.slotTime)).limit(300);
}

export const shapeVisit = (v: Awaited<ReturnType<typeof visitsFor>>[number]) => ({
  id: v.id, reference: v.reference, date: v.slotDate, time: String(v.slotTime).slice(0, 5), status: v.status,
  attended: !!v.checkedInAt, department: v.department, doctor: `Dr ${v.doctorFirst} ${v.doctorLast}`,
  reason: v.reason, cancelReason: v.cancelReason,
});

export async function staffThread(threadId: string, readerId: string) {
  const [t] = await db.select({
    id: chatThreads.id, userId: chatThreads.patientUserId, firstName: users.firstName, lastName: users.lastName, phone: users.phone, email: users.email,
  }).from(chatThreads).innerJoin(users, eq(users.id, chatThreads.patientUserId)).where(eq(chatThreads.id, threadId)).limit(1);
  if (!t) throw new HttpError(404, "Conversation not found");
  await db.update(chatThreads).set({ staffReadAt: new Date() }).where(eq(chatThreads.id, threadId));
  const sender = db.$with("s").as(db.select({ id: users.id, fn: users.firstName, ln: users.lastName, role: users.role }).from(users));
  const rows = await db.with(sender).select({
    id: chatMessages.id, sender: chatMessages.sender, body: chatMessages.body, createdAt: chatMessages.createdAt,
    fn: sender.fn, ln: sender.ln, role: sender.role, senderUserId: chatMessages.senderUserId,
  }).from(chatMessages).leftJoin(sender, eq(sender.id, chatMessages.senderUserId))
    .where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.createdAt)).limit(500);
  const visits = (await visitsFor(t.phone, t.email)).slice(0, 8).map(shapeVisit);
  return {
    patient: { name: `${t.firstName} ${t.lastName}`, phone: t.phone, email: t.email },
    visits,
    messages: rows.map((m) => ({
      id: m.id, from: m.sender, body: m.body, createdAt: m.createdAt,
      // Labelled for colleagues only: who in the team wrote the reply.
      by: m.sender === "staff" ? { name: `${m.fn ?? "Staff"} ${m.ln ?? ""}`.trim(), role: STAFF_ROLE_LABEL[m.role ?? ""] ?? m.role ?? "Staff", id: m.senderUserId } : null,
    })),
  };
}

export async function staffSend(threadId: string, staffUserId: string, body: unknown) {
  const [t] = await db.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
  if (!t) throw new HttpError(404, "Conversation not found");
  return append(threadId, "staff", staffUserId, body);
}
