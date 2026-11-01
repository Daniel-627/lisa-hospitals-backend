import type http from "http";
import { Server, type Socket } from "socket.io";
import { eq } from "drizzle-orm";
import { db, chatThreads, users } from "./db";
import { verifyClerkToken } from "./middleware/clerk.middleware";
import { isUuid } from "./utils/validation";

/**
 * Realtime chat (Socket.IO). REST stays the source of truth for sending and loading; the socket only PUSHES changes
 * (new message, read receipt, typing, who is online, unread counts) so pages update instantly. Pages fall back to
 * polling if the socket is down, so chat keeps working either way.
 *
 * Rooms:  user:<id>  one per person (all their tabs)   ·   staff  the shared front desk (admin + receptionist)
 * Patients never receive staff identities; only the staff room gets names.
 * Presence is kept in memory, which is correct for a single Render instance.
 */
export type SocketUser = { id: string; role: string; name: string };
export type SocketAuth = (token: string) => Promise<SocketUser | null>;

let io: Server | null = null;
const online = { patients: new Map<string, number>(), staff: new Map<string, number>() };
const isFront = (role: string) => role === "admin" || role === "receptionist";

/** Default auth: a Clerk token → our users row. Only patients and the front desk use chat. */
export const clerkSocketAuth: SocketAuth = async (token) => {
  const clerkId = await verifyClerkToken(token);
  if (!clerkId) return null;
  const [u] = await db.select().from(users).where(eq(users.clerkUserId, clerkId)).limit(1);
  if (!u || !u.isActive || !(u.role === "patient" || isFront(u.role))) return null;
  return { id: u.id, role: u.role, name: `${u.firstName} ${u.lastName}`.trim() };
};

const bump = (m: Map<string, number>, id: string, d: 1 | -1) => {
  const n = (m.get(id) ?? 0) + d;
  if (n <= 0) { m.delete(id); return 0; }
  m.set(id, n); return n;
};

export function initRealtime(server: http.Server, origins: string[], auth: SocketAuth = clerkSocketAuth) {
  io = new Server(server, {
    cors: { origin: origins, credentials: true },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 10_000,        // events are tiny; files never go through the socket
    pingInterval: 20_000, pingTimeout: 20_000,
  });

  // Each (re)connect presents a fresh short-lived Clerk token.
  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
      const user = await auth(token);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch { next(new Error("unauthorized")); }
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user as SocketUser;
    socket.join(`user:${user.id}`);

    if (user.role === "patient") {
      socket.join("patients");
      if (bump(online.patients, user.id, 1) === 1) io!.to("staff").emit("presence", { userId: user.id, online: true });
      socket.emit("lisa:online", { online: online.staff.size > 0 });
    } else {
      socket.join("staff");
      if (bump(online.staff, user.id, 1) === 1) io!.to("patients").emit("lisa:online", { online: true });
      socket.emit("presence:list", { userIds: [...online.patients.keys()] });
      staffUnread().then((n) => socket.emit("unread", { count: n })).catch(() => {});
    }

    // Typing: throttled, and the patient only ever learns that "Lisa" is typing.
    let last = 0;
    socket.on("typing", async (p: { threadId?: string } | undefined) => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      try {
        if (user.role === "patient") {
          const [t] = await db.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.patientUserId, user.id)).limit(1);
          if (t) io!.to("staff").emit("typing", { threadId: t.id, from: "patient", name: user.name });
        } else if (p?.threadId && isUuid(p.threadId)) {
          const [t] = await db.select({ u: chatThreads.patientUserId }).from(chatThreads).where(eq(chatThreads.id, p.threadId)).limit(1);
          if (!t) return;
          io!.to(`user:${t.u}`).emit("typing", { from: "lisa" });
          socket.to("staff").emit("typing", { threadId: p.threadId, from: "staff", name: user.name });
        }
      } catch { /* typing is a nicety */ }
    });

    socket.on("disconnect", () => {
      if (user.role === "patient") {
        if (bump(online.patients, user.id, -1) === 0) io!.to("staff").emit("presence", { userId: user.id, online: false });
      } else if (bump(online.staff, user.id, -1) === 0 && online.staff.size === 0) {
        io!.to("patients").emit("lisa:online", { online: false });
      }
    });
  });
  return io;
}

// ── Publishing (called by the chat service; harmless when the socket server isn't running, e.g. in tests) ──
export const rt = {
  toPatient: (userId: string, event: string, payload: unknown) => { io?.to(`user:${userId}`).emit(event, payload); },
  toStaff:   (event: string, payload: unknown) => { io?.to("staff").emit(event, payload); },
  enabled:   () => !!io,
};

// Set by the chat service to avoid a circular import.
let unreadCounter: () => Promise<number> = async () => 0;
export const setStaffUnreadCounter = (fn: () => Promise<number>) => { unreadCounter = fn; };
export const staffUnread = () => unreadCounter();
