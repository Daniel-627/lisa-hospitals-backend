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

export const completeProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const { phone, firstName, lastName } = req.body;

    if (!phone) return sendError(res, "Phone number is required", 422);

    const clerkId = req.clerkUser!.clerkId;

    // Check if user exists
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkId))
      .limit(1);

    if (existing) {
      // Update existing user
      await db.update(users)
        .set({ phone, firstName, lastName, updatedAt: new Date() })
        .where(eq(users.clerkUserId, clerkId));

      return sendSuccess(res, null, "Profile updated");
    }

    // Create new user
    const [newUser] = await db.insert(users).values({
      email:        req.clerkUser!.email,
      phone,
      firstName,
      lastName,
      passwordHash: `clerk-${clerkId}`,
      role:         "patient",
      isActive:     true,
      isVerified:   true,
      clerkUserId:  clerkId,
    }).returning();

    // Create patient profile
    await db.insert(patients).values({
      userId:        newUser.id,
      patientNumber: `PT-${Date.now().toString().slice(-6)}`,
      dateOfBirth:   "2000-01-01",
      gender:        "other",
    });

    return sendSuccess(res, null, "Profile created", 201);
  } catch (err) {
    console.error("completeProfile error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};