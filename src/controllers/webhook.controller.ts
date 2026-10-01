import { Request, Response } from "express";
import { Webhook } from "svix";
import { eq } from "drizzle-orm";
import { db, users, patients } from "../db";
import { nextNumber } from "../utils/access";
import { isUniqueViolation } from "../utils/errors";

/**
 * Mount with the RAW body parser, before express.json() (see webhook.routes.ts).
 */
export const clerkWebhook = async (req: Request, res: Response) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) return res.status(500).json({ error: "Webhook secret not configured" });

  const svix_id = req.headers["svix-id"] as string;
  const svix_timestamp = req.headers["svix-timestamp"] as string;
  const svix_signature = req.headers["svix-signature"] as string;
  if (!svix_id || !svix_timestamp || !svix_signature) {
    return res.status(400).json({ error: "Missing svix headers" });
  }

  // Preferred: raw Buffer (see webhook.routes.ts). Fallback re-serialises a parsed body, which can
  // break signature checks if key order/whitespace differ — so mount this route before express.json().
  let rawBody: string;
  if (req.body instanceof Buffer) {
    rawBody = req.body.toString("utf8");
  } else {
    console.warn("Clerk webhook: body already parsed; mount the webhook router before express.json()");
    rawBody = JSON.stringify(req.body);
  }

  let payload: any;
  try {
    payload = new Webhook(WEBHOOK_SECRET).verify(rawBody, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    });
  } catch (err) {
    console.error("Webhook verification failed:", err);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const { type, data } = payload;

  if (type === "user.created") {
    try {
      const clerkId: string = data.id;
      const primary = data.email_addresses?.find((e: any) => e.id === data.primary_email_address_id)
        ?? data.email_addresses?.[0];
      const email: string | undefined = primary?.email_address;
      const emailVerified = primary?.verification?.status === "verified";
      const firstName = data.first_name || "Patient";
      const lastName = data.last_name || "";

      if (!email) return res.status(400).json({ error: "No email found" });

      const [existing] = await db.select().from(users).where(eq(users.clerkUserId, clerkId)).limit(1);
      if (existing) return res.status(200).json({ message: "User already exists" });

      const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (byEmail) {
        // Only link when Clerk has verified the email AND the row isn't already linked to another Clerk user.
        // Otherwise anyone could sign up with a victim's email address and take over their record.
        if (emailVerified && !byEmail.clerkUserId) {
          await db.update(users).set({ clerkUserId: clerkId }).where(eq(users.id, byEmail.id));
          return res.status(200).json({ message: "Linked clerk ID" });
        }
        console.warn(`Webhook: refused to link ${clerkId} to existing user (unverified email or already linked)`);
        return res.status(200).json({ message: "Skipped: email belongs to an existing account" });
      }

      // Use the Clerk phone only if it's free; otherwise fall back to a placeholder (users.phone is unique, varchar(20)).
      let phone = data.phone_numbers?.[0]?.phone_number as string | undefined;
      if (phone) {
        const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
        if (taken) phone = undefined;
      }

      await db.transaction(async (tx) => {
        const [newUser] = await tx.insert(users).values({
          email,
          phone: phone || `clerk-${clerkId.slice(-12)}`,
          passwordHash: `clerk-${clerkId}`,
          firstName, lastName,
          role: "patient", isActive: true, isVerified: emailVerified, clerkUserId: clerkId,
        }).returning();

        await tx.insert(patients).values({
          userId: newUser.id,
          patientNumber: await nextNumber("PT", "patient_number_seq", 7, tx),
          dateOfBirth: "2000-01-01",
          gender: "other",
        });
      });

      return res.status(200).json({ message: "Patient created" });
    } catch (err) {
      // A concurrent /complete-profile call may have created the row first — that's fine.
      if (isUniqueViolation(err)) return res.status(200).json({ message: "User already exists" });
      console.error("Webhook user.created error:", err);
      return res.status(500).json({ error: "Failed to create patient" });
    }
  }

  if (type === "user.updated") {
    try {
      const update: Record<string, string> = {};
      if (data.first_name) update.firstName = data.first_name;
      if (data.last_name != null) update.lastName = data.last_name;
      if (Object.keys(update).length) {
        await db.update(users).set(update).where(eq(users.clerkUserId, data.id));
      }
      return res.status(200).json({ message: "User updated" });
    } catch (err) {
      console.error("Webhook user.updated error:", err);
      return res.status(500).json({ error: "Failed to update user" });
    }
  }

  if (type === "user.deleted") {
    try {
      // Deactivate instead of deleting: medical records must be retained.
      await db.update(users).set({ isActive: false }).where(eq(users.clerkUserId, data.id));
      return res.status(200).json({ message: "User deactivated" });
    } catch (err) {
      console.error("Webhook user.deleted error:", err);
      return res.status(500).json({ error: "Failed to deactivate user" });
    }
  }

  return res.status(200).json({ message: "Webhook received" });
};
