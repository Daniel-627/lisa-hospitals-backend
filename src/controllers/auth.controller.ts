import { Response } from "express";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { db, users, patients } from "../db";
import { eq } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";

export const getMe = async (req: ClerkRequest, res: Response) => {
  try {
    const [user] = await db
      .select({
        id:        users.id,
        email:     users.email,
        phone:     users.phone,
        role:      users.role,
        firstName: users.firstName,
        lastName:  users.lastName,
        isActive:  users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, req.clerkUser!.dbUserId))
      .limit(1);

    if (!user) return sendError(res, "User not found", 404);
    return sendSuccess(res, user);
  } catch (err) {
    console.error("getMe error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const updateRole = async (req: ClerkRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const { role }   = req.body;

    const validRoles = [
      "patient", "doctor", "nurse", "receptionist",
      "lab_technician", "radiographer", "pharmacist",
      "billing_officer", "admin",
    ];

    if (!validRoles.includes(role)) {
      return sendError(res, "Invalid role", 422);
    }

    const [updated] = await db
      .update(users)
      .set({ role })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) return sendError(res, "User not found", 404);
    return sendSuccess(res, updated, "Role updated successfully");
  } catch (err) {
    console.error("updateRole error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};