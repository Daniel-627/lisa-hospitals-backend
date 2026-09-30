import { Request, Response } from "express";
import { Webhook } from "svix";
import { db, users, patients } from "../db";
import { eq } from "drizzle-orm";

const generatePatientNumber = () =>
  `PT-${Date.now().toString().slice(-6)}`;

export const clerkWebhook = async (req: Request, res: Response) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  const svix_id        = req.headers["svix-id"] as string;
  const svix_timestamp = req.headers["svix-timestamp"] as string;
  const svix_signature = req.headers["svix-signature"] as string;

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return res.status(400).json({ error: "Missing svix headers" });
  }

  let payload: any;
  try {
    const wh   = new Webhook(WEBHOOK_SECRET);
    const body = req.body instanceof Buffer
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);

    payload = wh.verify(body, {
      "svix-id":        svix_id,
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
      const email     = data.email_addresses?.[0]?.email_address;
      const phone     = data.phone_numbers?.[0]?.phone_number || "";
      const firstName = data.first_name || "Patient";
      const lastName  = data.last_name  || "";
      const clerkId   = data.id;

      if (!email) return res.status(400).json({ error: "No email found" });

      const existing = await db
        .select()
        .from(users)
        .where(eq(users.clerkUserId, clerkId))
        .limit(1);

      if (existing.length > 0) {
        return res.status(200).json({ message: "User already exists" });
      }

      const existingEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingEmail.length > 0) {
        await db.update(users)
          .set({ clerkUserId: clerkId })
          .where(eq(users.email, email));
        return res.status(200).json({ message: "Updated clerk ID" });
      }

      const [newUser] = await db.insert(users).values({
        email,
        phone:        phone || `clerk-${clerkId.slice(-6)}`,
        passwordHash: `clerk-${clerkId}`,
        firstName,
        lastName,
        role:         "patient",
        isActive:     true,
        isVerified:   true,
        clerkUserId:  clerkId,
      }).returning();

      await db.insert(patients).values({
        userId:        newUser.id,
        patientNumber: generatePatientNumber(),
        dateOfBirth:   "2000-01-01",
        gender:        "other",
      });

      console.log(`New patient created via webhook: ${email}`);
      return res.status(200).json({ message: "Patient created" });
    } catch (err) {
      console.error("Webhook user.created error:", err);
      return res.status(500).json({ error: "Failed to create patient" });
    }
  }

  if (type === "user.updated") {
    try {
      const firstName = data.first_name;
      const lastName  = data.last_name;
      const clerkId   = data.id;

      await db.update(users)
        .set({ firstName, lastName })
        .where(eq(users.clerkUserId, clerkId));

      return res.status(200).json({ message: "User updated" });
    } catch (err) {
      console.error("Webhook user.updated error:", err);
      return res.status(500).json({ error: "Failed to update user" });
    }
  }

  return res.status(200).json({ message: "Webhook received" });
};