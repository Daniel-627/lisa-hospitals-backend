import { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";
import { db, users } from "../db";
import { eq } from "drizzle-orm";
import { sendError } from "../utils/response";

export type UserRole =
  | "patient" | "doctor" | "nurse" | "receptionist"
  | "lab_technician" | "radiographer" | "pharmacist"
  | "billing_officer" | "admin";

export type ClerkRequest = Request & {
  /** Set by authenticateClerk and authenticate. */
  clerkId?: string;
  /** Set by authenticate only (requires a row in our users table). */
  clerkUser?: {
    clerkId:   string;
    dbUserId:  string;
    role:      UserRole;
    email:     string;
    firstName: string;
    lastName:  string;
  };
};

/** Verifies the bearer token and returns the Clerk user id, or null. */
/** Verifies the bearer token and returns the Clerk user id, or null. */
async function verifyBearer(req: Request): Promise<string | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  try {
    // Depending on the @clerk/backend version, verifyToken either returns the payload directly
    // (and throws on failure) or returns { data, errors }. Accept both.
    const result: any = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES?.split(",").map((s) => s.trim()),
    });
    const payload = result?.sub ? result : result?.data;
    if (!payload?.sub) {
      const e = result?.errors?.[0];
      console.warn("Clerk token rejected:", e?.reason ?? e?.code ?? "no payload", "-", e?.message ?? "");
      return null;
    }
    return payload.sub as string;
  } catch (err: any) {
    console.warn("Clerk token rejected:", err?.reason ?? err?.name ?? "error", "-", err?.message ?? "");
    return null;
  }
}

/**
 * Token check only — does NOT require a DB user.
 * Use for POST /auth/complete-profile, which must work before the user exists in our DB.
 */
export const authenticateClerk = async (req: ClerkRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const clerkId = await verifyBearer(req);
    if (!clerkId) { sendError(res, "Invalid or missing token", 401); return; }
    req.clerkId = clerkId;
    next();
  } catch (err) {
    console.error("authenticateClerk error:", err);
    sendError(res, "Invalid or expired token", 401);
  }
};

export const authenticate = async (req: ClerkRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const clerkId = await verifyBearer(req);
    if (!clerkId) { sendError(res, "Invalid or missing token", 401); return; }

    const [user] = await db.select().from(users).where(eq(users.clerkUserId, clerkId)).limit(1);

    if (!user) { sendError(res, "User not found — please complete registration", 404); return; }
    if (!user.isActive) { sendError(res, "Account is deactivated", 403); return; }

    req.clerkId = clerkId;
    req.clerkUser = {
      clerkId,
      dbUserId:  user.id,
      role:      user.role as UserRole,
      email:     user.email,
      firstName: user.firstName,
      lastName:  user.lastName,
    };
    next();
  } catch (err) {
    console.error("authenticate error:", err);
    sendError(res, "Invalid or expired token", 401);
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: ClerkRequest, res: Response, next: NextFunction): void => {
    if (!req.clerkUser || !roles.includes(req.clerkUser.role)) {
      sendError(res, "Access denied", 403);
      return;
    }
    next();
  };
};

/** Any non-patient role. */
export const requireStaff = authorize(
  "doctor", "nurse", "receptionist", "lab_technician",
  "radiographer", "pharmacist", "billing_officer", "admin"
);
