import crypto from "crypto";
import { Request, Response } from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, invoices, patients, users, onlinePayments } from "../db";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { sendSuccess, sendError } from "../utils/response";
import { HttpError, handleError } from "../utils/errors";
import { getPatientByUserId, hasRole } from "../utils/access";
import { audit } from "../utils/audit";
import { fromCents, toCents } from "../utils/money";
import { isUuid } from "../utils/validation";
import { initializeTransaction, paystackConfigured, validSignature, verifyTransaction } from "../utils/paystack";
import { applyPayment } from "./billing.controller";

const CASHIER_ROLES = ["billing_officer", "receptionist", "admin"] as const;

const frontendOrigin = () => (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");
const callbackUrl = () => process.env.PAYSTACK_CALLBACK_URL || `${frontendOrigin()}/pay/callback`;

export type SettleResult = { status: "success" | "pending" | "failed" | "review" | "unknown"; invoiceNumber?: string; amount?: string };

/**
 * Turns a confirmed Paystack payment into a normal payment on the invoice. Safe to call any number of times
 * (webhook, return page, retries): the online_payments row is locked and only settles once.
 * Money is never silently lost: anything that can't be applied in full is parked as "review" for the billing desk.
 */
export async function settleOnlinePayment(reference: string): Promise<SettleResult> {
  const [rec] = await db.select().from(onlinePayments).where(eq(onlinePayments.reference, reference)).limit(1);
  if (!rec) return { status: "unknown" };
  const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, rec.invoiceId)).limit(1);
  const out = (status: SettleResult["status"]): SettleResult => ({ status, invoiceNumber: inv?.invoiceNumber, amount: rec.amount });

  if (rec.status === "success") return out("success");
  if (rec.status === "review") return out("review");
  if (rec.status === "failed") return out("failed");

  // Ask Paystack directly: we never trust the webhook body or the browser for the amount or the outcome.
  const tx = await verifyTransaction(reference);

  if (tx.status === "failed" || tx.status === "abandoned" || tx.status === "reversed") {
    await db.update(onlinePayments).set({ status: tx.status === "abandoned" ? "abandoned" : "failed", channel: tx.channel ?? null, notes: tx.gateway_response ?? null })
      .where(eq(onlinePayments.id, rec.id));
    return out("failed");
  }
  if (tx.status !== "success") return out("pending"); // ongoing / pending / queued

  const expectedCents = toCents(rec.amount);
  if (tx.currency !== "KES" || tx.amount !== expectedCents) {
    await db.update(onlinePayments).set({ status: "review", channel: tx.channel ?? null, settledAt: new Date(), notes: `Paystack reported ${tx.currency} ${tx.amount / 100} but ${fromCents(expectedCents)} was expected. Check the Paystack dashboard.` })
      .where(eq(onlinePayments.id, rec.id));
    console.error("Paystack amount mismatch for", reference);
    return out("review");
  }

  try {
    const status = await db.transaction(async (tx2) => {
      const [locked] = await tx2.select().from(onlinePayments).where(eq(onlinePayments.id, rec.id)).for("update");
      if (locked.status === "success" || locked.status === "review") return locked.status as "success" | "review";

      const payment = await applyPayment(tx2, {
        invoiceId: rec.invoiceId, amountCents: expectedCents, paymentMethod: "paystack", referenceNumber: reference,
        notes: `Paystack ${tx.channel ?? "online"} payment`, receivedBy: null, capToOutstanding: true,
      });
      // If the invoice was partly paid some other way meanwhile, only the balance is applied: flag the excess for a refund.
      const appliedCents = toCents(payment.amount);
      const full = appliedCents === expectedCents;
      await tx2.update(onlinePayments).set({
        status: full ? "success" : "review", channel: tx.channel ?? null, paymentId: payment.id, settledAt: new Date(),
        notes: full ? null : `Received KES ${fromCents(expectedCents)} but only KES ${fromCents(appliedCents)} was still owed. Refund the difference on Paystack.`,
      }).where(eq(onlinePayments.id, rec.id));
      return full ? "success" : "review";
    });
    return out(status);
  } catch (err) {
    if (err instanceof HttpError) {
      // e.g. the invoice was paid in cash or waived while the customer was on the Paystack page.
      await db.update(onlinePayments).set({ status: "review", channel: tx.channel ?? null, settledAt: new Date(), notes: `Payment received but not applied: ${err.message}. Refund it on Paystack or fix the invoice.` })
        .where(eq(onlinePayments.id, rec.id));
      console.error("Paystack payment needs review:", reference, err.message);
      return out("review");
    }
    throw err;
  }
}

// ── Start a payment ──────────────────────────────────────────────────────────
const initSchema = z.object({ amount: z.number().finite().positive().max(150_000, "M-Pesa allows at most KES 150,000 per payment").optional() }).strict();

export const initPayment = async (req: ClerkRequest, res: Response) => {
  try {
    if (!paystackConfigured()) return sendError(res, "Online payments aren't set up yet.", 503);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);
    const parsed = initSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!invoice) return sendError(res, "Invoice not found", 404);

    // The patient who owns the invoice, or the billing desk acting for them.
    const mine = await getPatientByUserId(req.clerkUser!.dbUserId);
    const owns = !!mine && invoice.patientId === mine.id;
    if (!owns && !hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Invoice not found", 404);

    if (invoice.paymentStatus === "waived") return sendError(res, "This invoice has been waived", 409);
    const outstanding = toCents(invoice.totalAmount) - toCents(invoice.paidAmount);
    if (outstanding <= 0) return sendError(res, "This invoice is already fully paid", 409);

    const amountCents = parsed.data.amount === undefined ? Math.min(outstanding, 15_000_000) : toCents(parsed.data.amount);
    if (Math.abs(amountCents - parsed.data.amount! * 100) > 1e-6 && parsed.data.amount !== undefined) return sendError(res, "Amounts can have at most 2 decimal places", 422);
    if (amountCents <= 0) return sendError(res, "Enter an amount greater than 0", 422);
    if (amountCents > outstanding) return sendError(res, `That is more than the outstanding balance of KES ${fromCents(outstanding)}`, 422);

    // Paystack needs an email. Walk-ins often have none, so fall back to the hospital's address.
    const [p] = await db.select({ email: users.email, pEmail: patients.email, number: patients.patientNumber })
      .from(patients).leftJoin(users, eq(patients.userId, users.id)).where(eq(patients.id, invoice.patientId)).limit(1);
    const email = p?.email || p?.pEmail || process.env.PAYSTACK_FALLBACK_EMAIL || "lisahospitals2023@gmail.com";

    const reference = `${invoice.invoiceNumber}-${crypto.randomBytes(5).toString("hex")}`;
    const init = await initializeTransaction({
      email, amountCents, reference, callbackUrl: callbackUrl(),
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, patientNumber: p?.number },
    });

    await db.insert(onlinePayments).values({
      invoiceId: invoice.id, patientId: invoice.patientId, reference, amount: fromCents(amountCents), initiatedBy: req.clerkUser!.dbUserId,
    });
    await audit(req, "online_payment.started", "online_payments", null, null, { invoiceId: invoice.id, reference, amount: fromCents(amountCents) });
    return sendSuccess(res, { authorizationUrl: init.authorization_url, reference, amount: fromCents(amountCents) }, "Payment started", 201);
  } catch (err) {
    return handleError(res, err, "initPayment");
  }
};

// ── Return page: "did my payment go through?" ────────────────────────────────
// Public on purpose (the payer may not be signed in, e.g. a payment link opened on their own phone). It returns no personal
// data, and settlement is verified with Paystack, so knowing a reference lets nobody mark anything paid.
export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const reference = typeof req.query.reference === "string" ? req.query.reference.slice(0, 100) : "";
    if (!reference) return sendError(res, "Missing payment reference", 422);
    const r = await settleOnlinePayment(reference);
    if (r.status === "unknown") return sendError(res, "Payment not found", 404);
    return sendSuccess(res, r);
  } catch (err) {
    console.error("verifyPayment error:", err);
    return sendError(res, "We couldn't check the payment right now. Please try again in a moment.", 502);
  }
};

// ── Webhook ──────────────────────────────────────────────────────────────────
// Mounted with the RAW body parser (src/index.ts), because the signature is computed over the exact bytes Paystack sent.
export const paystackWebhook = async (req: Request, res: Response) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(500).json({ error: "Paystack is not configured" });
    const raw: Buffer | string = req.body instanceof Buffer ? req.body : JSON.stringify(req.body);
    if (!validSignature(raw, req.headers["x-paystack-signature"] as string | undefined)) return res.status(401).json({ error: "Invalid signature" });

    const event = JSON.parse(raw.toString());
    if (event?.event === "charge.success" && typeof event.data?.reference === "string") {
      await settleOnlinePayment(event.data.reference);
    }
    return res.sendStatus(200);
  } catch (err) {
    // 500 makes Paystack retry later, which is what we want if Paystack's verify call or the database hiccuped.
    console.error("paystackWebhook error:", err);
    return res.sendStatus(500);
  }
};

// ── For the billing desk ─────────────────────────────────────────────────────
export const listOnlinePayments = async (invoiceId: string) =>
  db.select({
    id: onlinePayments.id, reference: onlinePayments.reference, amount: onlinePayments.amount, status: onlinePayments.status,
    channel: onlinePayments.channel, notes: onlinePayments.notes, createdAt: onlinePayments.createdAt, settledAt: onlinePayments.settledAt,
  }).from(onlinePayments).where(eq(onlinePayments.invoiceId, invoiceId)).orderBy(desc(onlinePayments.createdAt)).limit(20);
