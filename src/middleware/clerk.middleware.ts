import { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";
import { db, users } from "../db";
import { eq } from "drizzle-orm";
import { sendError } from "../utils/response";

export type ClerkRequest = Request & {
  clerkUser?: {
    id: string;
    role: string;
    email: string;
    dbUserId: string;
  };
};

export const authenticateClerk = async (
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

    // Verify with Clerk
    const { data, errors } = await verifyToken(token, {
  secretKey: process.env.CLERK_SECRET_KEY!,
});

const payload = data as any;

if (errors || !payload) {
  sendError(res, "Invalid token", 401);
  return;
}
    // Find user in our DB by clerk_user_id
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, payload.sub))
      .limit(1);

    if (!user) {
      sendError(res, "User not found — please complete registration", 404);
      return;
    }

    req.clerkUser = {
      id:       payload.sub,
      role:     user.role,
      email:    user.email,
      dbUserId: user.id,
    };

    next();
  } catch {
    sendError(res, "Invalid or expired token", 401);
  }
};