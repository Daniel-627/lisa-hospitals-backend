import { Response } from "express";
import { createClerkClient } from "@clerk/backend";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { db, users, patients } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { handleError, isUniqueViolation } from "../utils/errors";
import { nextNumber, hasRole } from "../utils/access";
import { normalizeKenyanPhone, uuid } from "../utils/validation";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const getMe = async (req: ClerkRequest, res: Response) => {
  try {
    const [user] = await db
      .select({
        id: users.id, email: users.email, phone: users.phone, role: users.role,
        firstName: users.firstName, lastName: users.lastName,
        isActive: users.isActive, createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, req.clerkUser!.dbUserId))
      .limit(1);

    if (!user) return sendError(res, "User not found", 404);
    return sendSuccess(res, user);
  } catch (err) {
    return handleError(res, err, "getMe");
  }
};

const roleSchema = z.object({
  role: z.enum([
    "patient", "doctor", "nurse", "receptionist", "lab_technician",
    "radiographer", "pharmacist", "billing_officer", "admin",
  ]),
});

export const updateRole = async (req: ClerkRequest, res: Response) => {
  try {
    // Defence in depth — the route should also use authorize("admin").
    if (!hasRole(req, "admin")) return sendError(res, "Access denied", 403);

    const userId = req.params.userId;
    if (!uuid.safeParse(userId).success) return sendError(res, "Invalid user id", 422);

    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid role", 422);

    if (userId === req.clerkUser!.dbUserId) {
      return sendError(res, "You cannot change your own role", 400);
    }

    const [updated] = await db
      .update(users)
      .set({ role: parsed.data.role })
      .where(eq(users.id, userId))
      .returning({ id: users.id, role: users.role, email: users.email });

    if (!updated) return sendError(res, "User not found", 404);
    return sendSuccess(res, updated, "Role updated successfully");
  } catch (err) {
    return handleError(res, err, "updateRole");
  }
};

const completeProfileSchema = z.object({
  phone:     z.string().min(1, "Phone number is required"),
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName:  z.string().trim().min(1, "Last name is required").max(100),
});

/**
 * Route MUST use authenticateClerk (not authenticate): the user may not be in our DB yet.
 * The email comes from Clerk's API, never from the request body.
 */
export const completeProfile = async (req: ClerkRequest, res: Response) => {
  try {
    const parsed = completeProfileSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const phone = normalizeKenyanPhone(parsed.data.phone);
    if (!phone) return sendError(res, "Enter a valid Kenyan phone number (e.g. 0712 345 678)", 422);

    const clerkId = req.clerkId!;
    const { firstName, lastName } = parsed.data;

    const [existing] = await db.select().from(users).where(eq(users.clerkUserId, clerkId)).limit(1);
    if (existing) {
      await db.update(users).set({ phone, firstName, lastName }).where(eq(users.id, existing.id));
      return sendSuccess(res, null, "Profile updated");
    }

    // Fetch the verified primary email from Clerk.
    const cu = await clerk.users.getUser(clerkId);
    const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId);
    if (!primary || primary.verification?.status !== "verified") {
      return sendError(res, "Please verify your email address first", 422);
    }
    const email = primary.emailAddress;

    await db.transaction(async (tx) => {
      // A staff account pre-created by an admin with this (verified) email: link it, don't duplicate.
      const [byEmail] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (byEmail) {
        if (byEmail.clerkUserId && byEmail.clerkUserId !== clerkId) {
          throw Object.assign(new Error("email linked"), { status: 409 });
        }
        await tx.update(users).set({ clerkUserId: clerkId, phone, firstName, lastName }).where(eq(users.id, byEmail.id));
        return;
      }

      const [newUser] = await tx.insert(users).values({
        email, phone, firstName, lastName,
        passwordHash: `clerk-${clerkId}`,
        role: "patient", isActive: true, isVerified: true, clerkUserId: clerkId,
      }).returning();

      await tx.insert(patients).values({
        userId: newUser.id,
        patientNumber: await nextNumber("PT", "patient_number_seq", 7, tx),
        dateOfBirth: "2000-01-01", // placeholder until the patient completes their profile
        gender: "other",
      });
    });

    return sendSuccess(res, null, "Profile created", 201);
  } catch (err: any) {
    if (err?.status === 409) return sendError(res, "This email is already linked to another account", 409);
    if (isUniqueViolation(err)) return sendError(res, "That phone number is already registered", 409);
    return handleError(res, err, "completeProfile");
  }
};
