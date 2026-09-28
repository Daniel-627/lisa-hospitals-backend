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
  clerkUser?: {
    clerkId:  string;
    dbUserId: string;
    role:     UserRole;
    email:    string;
    firstName:string;
    lastName: string;
  };
};

export const authenticate = async (
  req: ClerkRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      sendError(res, "No token provided", 401);
      return;
    }

    const { data: payload, errors } = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });

    if (errors || !payload) {
      sendError(res, "Invalid token", 401);
      return;
    }

    const clerkId = (payload as any).sub;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkId))
      .limit(1);

    if (!user) {
      sendError(res, "User not found — please complete registration", 404);
      return;
    }

    if (!user.isActive) {
      sendError(res, "Account is deactivated", 403);
      return;
    }

    req.clerkUser = {
      clerkId,
      dbUserId:  user.id,
      role:      user.role as UserRole,
      email:     user.email,
      firstName: user.firstName,
      lastName:  user.lastName,
    };

    next();
  } catch {
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