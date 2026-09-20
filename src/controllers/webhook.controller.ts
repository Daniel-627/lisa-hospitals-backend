import { Request, Response } from "express";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { db, users, patients } from "../db";
import { eq } from "drizzle-orm";

const generatePatientNumber = () =>
  `PT-${Date.now().toString().slice(-6)}`;

export const clerkWebhook = async (req: Request, res: Response) => {
  try {
    const evt = await verifyWebhook(req as any, {
      signingSecret: process.env.CLERK_WEBHOOK_SECRET!,
    });

    const { type, data } = evt;

    if (type === "user.created") {
      const email     = (data as any).email_addresses?.[0]?.email_address;
      const phone     = (data as any).phone_numbers?.[0]?.phone_number || "";
      const firstName = (data as any).first_name || "Patient";
      const lastName  = (data as any).last_name  || "";
      const clerkId   = (data as any).id;

      if (!email) {
        return res.status(400).json({ error: "No email found" });
      }

      // Check if user already exists
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing.length > 0) {
        await db.update(users)
          .set({ clerkUserId: clerkId })
          .where(eq(users.email, email));
        return res.status(200).json({ message: "User updated with clerk ID" });
      }

      const [newUser] = await db.insert(users).values({
        email,
        phone:        phone || `clerk-${clerkId}`,
        passwordHash: `clerk-${clerkId}`,
        firstName,
        lastName,
        role:         "patient",
        isVerified:   true,
        clerkUserId:  clerkId,
      }).returning();

      await db.insert(patients).values({
        userId:        newUser.id,
        patientNumber: generatePatientNumber(),
        dateOfBirth:   "2000-01-01",
        gender:        "other",
      });

      console.log(`New patient created: ${email}`);
      return res.status(200).json({ message: "Patient created successfully" });
    }

    if (type === "user.updated") {
      const firstName = (data as any).first_name;
      const lastName  = (data as any).last_name;
      const clerkId   = (data as any).id;

      await db.update(users)
        .set({ firstName, lastName })
        .where(eq(users.clerkUserId, clerkId));

      return res.status(200).json({ message: "User updated" });
    }

    return res.status(200).json({ message: "Webhook received" });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(400).json({ error: "Webhook verification failed" });
  }
};