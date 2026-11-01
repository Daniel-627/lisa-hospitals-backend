import { Response } from "express";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendError, sendSuccess } from "../utils/response";
import { handleError } from "../utils/errors";
import { isUuid } from "../utils/validation";
import { db, users } from "../db";
import { eq } from "drizzle-orm";
import * as chat from "../services/chat.service";

const me = (req: ClerkRequest) => req.clerkUser!.dbUserId;

// ── Patient ──
export const mineMessages = async (req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, await chat.patientMessages(me(req), typeof req.query.after === "string" ? req.query.after : undefined)); }
  catch (e) { handleError(res, e, "chat.mine"); }
};
export const mineSend = async (req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, await chat.patientSend(me(req), req.body?.body, req.body?.attachment), undefined, 201); }
  catch (e) { handleError(res, e, "chat.mineSend"); }
};
export const mineRead = async (req: ClerkRequest, res: Response) => {
  try { await chat.patientMarkRead(me(req)); sendSuccess(res, null); } catch (e) { handleError(res, e, "chat.mineRead"); }
};
export const mineUnread = async (req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, { unread: await chat.patientUnread(me(req)) }); } catch (e) { handleError(res, e, "chat.mineUnread"); }
};
/** The patient's visit history (their bookings, matched on their account phone/email). */
export const myVisits = async (req: ClerkRequest, res: Response) => {
  try {
    const [u] = await db.select({ phone: users.phone, email: users.email }).from(users).where(eq(users.id, me(req))).limit(1);
    if (!u) return sendError(res, "User not found", 404);
    sendSuccess(res, (await chat.visitsFor(u.phone, u.email)).map(chat.shapeVisit));
  } catch (e) { handleError(res, e, "chat.visits"); }
};

// ── Staff ──
export const staffList = async (req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, await chat.staffThreads(typeof req.query.q === "string" ? req.query.q : undefined)); }
  catch (e) { handleError(res, e, "chat.staffList"); }
};
export const staffUnread = async (_req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, { unread: await chat.staffUnreadCount() }); } catch (e) { handleError(res, e, "chat.staffUnread"); }
};
export const staffOpen = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return sendError(res, "Conversation not found", 404);
    sendSuccess(res, await chat.staffThread(req.params.id, me(req), { markRead: req.query.peek !== "1" }));
  } catch (e) { handleError(res, e, "chat.staffOpen"); }
};
export const staffReply = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return sendError(res, "Conversation not found", 404);
    await chat.staffSend(req.params.id, me(req), req.body?.body, req.body?.attachment);
    sendSuccess(res, null, undefined, 201);
  } catch (e) { handleError(res, e, "chat.staffReply"); }
};

export const staffFindPatients = async (req: ClerkRequest, res: Response) => {
  try { sendSuccess(res, await chat.findPatients(typeof req.query.q === "string" ? req.query.q : "")); } catch (e) { handleError(res, e, "chat.find"); }
};
export const staffStartChat = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isUuid(req.body?.patientUserId)) return sendError(res, "Choose a patient", 422);
    sendSuccess(res, await chat.staffStart(me(req), req.body.patientUserId, req.body?.body, req.body?.attachment), undefined, 201);
  } catch (e) { handleError(res, e, "chat.start"); }
};
export const staffSeen = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return sendError(res, "Conversation not found", 404);
    await chat.staffMarkRead(req.params.id); sendSuccess(res, null);
  } catch (e) { handleError(res, e, "chat.seen"); }
};
