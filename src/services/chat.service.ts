import { and, asc, desc, eq, gt, ilike, or, sql } from "drizzle-orm";
import { db, bookings, chatMessages, chatThreads, departments, doctors, staff, users } from "../db";
import { HttpError } from "../utils/errors";
import { cloudinaryConfigured, isPrivateFileUrl, signFileUrl } from "../utils/cloudinary";
import { rt, setStaffUnreadCounter } from "../realtime";
import { normalizeKenyanPhone } from "../utils/validation";

const MAX_BODY = 2000;
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim() : "");

export type AttachmentInput = { url?: unknown; name?: unknown } | null | undefined;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

/** Only a private chat file uploaded to OUR Cloudinary account is accepted. */
function checkAttachment(a: AttachmentInput) {
  if (!a || !a.url) return null;
  if (!cloudinaryConfigured()) throw new HttpError(503, "File upload isn't set up yet.");
  const url = typeof a.url === "string" ? a.url : "";
  if (url.length > 500 || !isPrivateFileUrl(url) || !url.includes("/lisa/private/chat/")) throw new HttpError(422, "Attach the file with the paperclip button");
  const name = clean(a.name).replace(/[\u0000-\u001f\\/]/g, "").slice(0, 150) || "file";
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  return { url, name, kind: IMAGE_EXT.has(ext) ? "image" : "file" };
}

/** The patient's single thread (created on first use). */
async function threadFor(userId: string) {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  if (t) return t;
  await db.insert(chatThreads).values({ patientUserId: userId }).onConflictDoNothing();
  const [made] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  return made;
}

type Row = typeof chatMessages.$inferSelect;
const attach = (m: Row) => (m.attachmentUrl ? { url: signFileUrl(m.attachmentUrl), name: m.attachmentName ?? "file", kind: m.attachmentKind ?? "file" } : null);

/** What the PATIENT gets: no staff identity at all, every reply is simply "Lisa". */
const forPatient = (m: Row) => ({ id: m.id, from: m.sender === "patient" ? "you" : "lisa", body: m.body, attachment: attach(m), createdAt: m.createdAt });

const STAFF_ROLE_LABEL: Record<string, string> = { admin: "Admin", receptionist: "Receptionist / Secretary", doctor: "Doctor", nurse: "Nurse" };

/** What COLLEAGUES get: who wrote each reply (name + role). */
async function forStaffMsg(m: Row) {
  let by: { name: string; role: string; id: string } | null = null;
  if (m.sender === "staff" && m.senderUserId) {
    const [u] = await db.select({ fn: users.firstName, ln: users.lastName, role: users.role }).from(users).where(eq(users.id, m.senderUserId)).limit(1);
    by = { name: `${u?.fn ?? "Staff"} ${u?.ln ?? ""}`.trim(), role: STAFF_ROLE_LABEL[u?.role ?? ""] ?? u?.role ?? "Staff", id: m.senderUserId };
  }
  return { id: m.id, from: m.sender, body: m.body, attachment: attach(m), createdAt: m.createdAt, by };
}

async function append(thread: { id: string; patientUserId: string }, sender: "patient" | "staff", senderUserId: string, raw: unknown, file?: AttachmentInput) {
  const body = clean(raw);
  const a = checkAttachment(file);
  if (!body && !a) throw new HttpError(422, "Type a message first");
  if (body.length > MAX_BODY) throw new HttpError(422, `Please keep messages under ${MAX_BODY} characters`);
  const [m] = await db.insert(chatMessages).values({
    threadId: thread.id, sender, senderUserId, body,
    ...(a ? { attachmentUrl: a.url, attachmentName: a.name, attachmentKind: a.kind } : {}),
  }).returning();
  const read = sender === "patient" ? { patientReadAt: m.createdAt } : { staffReadAt: m.createdAt };
  await db.update(chatThreads).set({ lastMessageAt: m.createdAt, lastSender: sender, ...read }).where(eq(chatThreads.id, thread.id));

  // Push to everyone who should see it right now.
  if (rt.enabled()) {
    rt.toPatient(thread.patientUserId, "message", { message: forPatient(m) });
    const label = (m.body || (a ? `📎 ${a.name}` : "")).slice(0, 90);
    const [p] = await db.select({ fn: users.firstName, ln: users.lastName }).from(users).where(eq(users.id, thread.patientUserId)).limit(1);
    rt.toStaff("message", { threadId: thread.id, patientUserId: thread.patientUserId, patientName: `${p?.fn ?? ""} ${p?.ln ?? ""}`.trim(), preview: label, message: await forStaffMsg(m) });
    if (sender === "staff") rt.toPatient(thread.patientUserId, "unread", { unread: true });
    rt.toStaff("unread", { count: await staffUnreadCount() });
  }
  return m;
}

export async function patientMessages(userId: string, after?: string) {
  const t = await threadFor(userId);
  const since = after ? new Date(after) : null;
  const rows = await db.select().from(chatMessages)
    .where(since && !isNaN(+since) ? and(eq(chatMessages.threadId, t.id), gt(chatMessages.createdAt, since)) : eq(chatMessages.threadId, t.id))
    .orderBy(asc(chatMessages.createdAt)).limit(500);
  // seenAt: when the front desk last opened this chat (no names), so the patient can see "Seen".
  return { messages: rows.map(forPatient), seenAt: t.staffReadAt };
}

export async function patientSend(userId: string, body: unknown, file?: AttachmentInput) {
  const t = await threadFor(userId);
  return forPatient(await append(t, "patient", userId, body, file));
}

export async function patientMarkRead(userId: string) {
  const t = await threadFor(userId);
  const at = new Date();
  await db.update(chatThreads).set({ patientReadAt: at }).where(eq(chatThreads.id, t.id));
  rt.toStaff("read", { threadId: t.id, by: "patient", at });
}

export async function patientUnread(userId: string) {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.patientUserId, userId)).limit(1);
  return !!t && t.lastSender === "staff" && (!t.patientReadAt || t.patientReadAt < t.lastMessageAt);
}

// ── Staff side ────────────────────────────────────────────────────────────────
export async function staffThreads(q?: string) {
  const term = clean(q);
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  const rows = await db.select({
    id: chatThreads.id, patientUserId: chatThreads.patientUserId, lastMessageAt: chatThreads.lastMessageAt, lastSender: chatThreads.lastSender, staffReadAt: chatThreads.staffReadAt,
    firstName: users.firstName, lastName: users.lastName, phone: users.phone,
    preview: sql<string>`(select left(body, 90) from chat_messages m where m.thread_id = ${chatThreads.id} order by m.created_at desc limit 1)`,
  }).from(chatThreads).innerJoin(users, eq(users.id, chatThreads.patientUserId))
    .where(like ? or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(users.phone, like), sql`${users.firstName} || ' ' || ${users.lastName} ilike ${like}`) : undefined)
    .orderBy(desc(chatThreads.lastMessageAt)).limit(200);
  return rows.map((r) => ({
    id: r.id, patientUserId: r.patientUserId, patientName: `${r.firstName} ${r.lastName}`, phone: r.phone, preview: r.preview, lastMessageAt: r.lastMessageAt,
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

export async function staffThread(threadId: string, _readerId: string, opts: { markRead?: boolean } = {}) {
  const [t] = await db.select({
    id: chatThreads.id, userId: chatThreads.patientUserId, patientReadAt: chatThreads.patientReadAt,
    firstName: users.firstName, lastName: users.lastName, phone: users.phone, email: users.email,
  }).from(chatThreads).innerJoin(users, eq(users.id, chatThreads.patientUserId)).where(eq(chatThreads.id, threadId)).limit(1);
  if (!t) throw new HttpError(404, "Conversation not found");
  if (opts.markRead !== false) await staffMarkRead(threadId, t.userId);
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.createdAt)).limit(500);
  const visits = (await visitsFor(t.phone, t.email)).slice(0, 8).map(shapeVisit);
  return {
    patient: { userId: t.userId, name: `${t.firstName} ${t.lastName}`, phone: t.phone, email: t.email },
    patientReadAt: t.patientReadAt,   // when the patient last opened the chat: drives "Seen" under our messages
    visits,
    messages: await Promise.all(rows.map(forStaffMsg)),
  };
}

/** The front desk opened the chat: the patient sees "Seen", colleagues' unread dots clear. */
export async function staffMarkRead(threadId: string, patientUserId?: string) {
  const at = new Date();
  await db.update(chatThreads).set({ staffReadAt: at }).where(eq(chatThreads.id, threadId));
  if (!rt.enabled()) return;
  let pid = patientUserId;
  if (!pid) { const [t] = await db.select({ u: chatThreads.patientUserId }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1); pid = t?.u; }
  if (pid) rt.toPatient(pid, "read", { by: "lisa", at });
  rt.toStaff("read", { threadId, by: "staff", at });
  rt.toStaff("unread", { count: await staffUnreadCount() });
}

export async function staffSend(threadId: string, staffUserId: string, body: unknown, file?: AttachmentInput) {
  const [t] = await db.select({ id: chatThreads.id, patientUserId: chatThreads.patientUserId }).from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
  if (!t) throw new HttpError(404, "Conversation not found");
  return append(t, "staff", staffUserId, body, file);
}

/** Front desk starts a conversation with a patient who has an account. */
export async function staffStart(staffUserId: string, patientUserId: string, body: unknown, file?: AttachmentInput) {
  const [p] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, patientUserId), eq(users.role, "patient"), eq(users.isActive, true))).limit(1);
  if (!p) throw new HttpError(404, "Patient not found");
  const t = await threadFor(p.id);
  await append(t, "staff", staffUserId, body, file);
  return { threadId: t.id };
}

/** Patients with an account, for "New chat". */
export async function findPatients(q: string) {
  const term = clean(q);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = await db.select({ id: users.id, fn: users.firstName, ln: users.lastName, phone: users.phone }).from(users)
    .where(and(eq(users.role, "patient"), eq(users.isActive, true),
      or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(users.phone, like), sql`${users.firstName} || ' ' || ${users.lastName} ilike ${like}`)))
    .orderBy(asc(users.firstName)).limit(20);
  return rows.map((r) => ({ id: r.id, name: `${r.fn} ${r.ln}`, phone: r.phone }));
}

setStaffUnreadCounter(() => staffUnreadCount());
