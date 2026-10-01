import { Response } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, invoices, invoiceItems, payments, patients } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { HttpError, handleError } from "../utils/errors";
import { getPatientByUserId, getStaffByUserId, hasRole, isStaff, nextNumber } from "../utils/access";
import { fromCents, toCents } from "../utils/money";
import { isUuid, uuid } from "../utils/validation";

const CASHIER_ROLES = ["billing_officer", "receptionist", "admin"] as const;
const methodEnum = z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]);

const money = z.number().finite().min(0).max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "Amounts can have at most 2 decimal places");

const invoiceSchema = z.object({
  patientId:     uuid,
  visitId:       uuid.optional(),
  notes:         z.string().max(2000).optional(),
  paymentMethod: methodEnum.optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    quantity:    z.number().int().min(1).max(10_000),
    unitPrice:   money,
  })).min(1).max(100),
});

const paymentSchema = z.object({
  amount:          money.refine((v) => v > 0, "Amount must be greater than 0"),
  paymentMethod:   methodEnum,
  referenceNumber: z.string().trim().max(100).optional(),
  notes:           z.string().max(1000).optional(),
});

export const createInvoice = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);

    const parsed = invoiceSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const { patientId, visitId, notes, paymentMethod, items } = parsed.data;

    const lines = items.map((i) => {
      const unit = toCents(i.unitPrice);
      return { ...i, unit, total: unit * i.quantity };
    });
    const totalCents = lines.reduce((s, l) => s + l.total, 0);
    if (totalCents <= 0) return sendError(res, "Invoice total must be greater than 0", 422);

    const staffRecord = await getStaffByUserId(req.clerkUser!.dbUserId);

    const result = await db.transaction(async (tx) => {
      const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
      if (!patient) throw new HttpError(404, "Patient not found");

      const [invoice] = await tx.insert(invoices).values({
        patientId, visitId,
        invoiceNumber: await nextNumber("INV", "invoice_number_seq", 9, tx),
        totalAmount: fromCents(totalCents),
        paidAmount: "0.00",
        paymentStatus: "pending",
        paymentMethod,
        generatedBy: staffRecord?.id ?? null,
        notes,
      }).returning();

      const created = await tx.insert(invoiceItems).values(lines.map((l) => ({
        invoiceId: invoice.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: fromCents(l.unit),
        totalPrice: fromCents(l.total),
      }))).returning();

      return { ...invoice, items: created };
    });

    return sendSuccess(res, result, "Invoice created successfully", 201);
  } catch (err) {
    return handleError(res, err, "createInvoice");
  }
};

export const getInvoiceById = async (req: ClerkRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);

    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!invoice) return sendError(res, "Invoice not found", 404);

    if (!isStaff(req)) {
      const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
      if (!patient || invoice.patientId !== patient.id) return sendError(res, "Invoice not found", 404);
    }

    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id));
    const invoicePayments = await db.select().from(payments).where(eq(payments.invoiceId, id));
    return sendSuccess(res, { ...invoice, items, payments: invoicePayments });
  } catch (err) {
    return handleError(res, err, "getInvoiceById");
  }
};

export const getPatientInvoices = async (req: ClerkRequest, res: Response) => {
  try {
    if (!isStaff(req)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Patient not found", 404);

    const list = await db.select().from(invoices)
      .where(eq(invoices.patientId, id))
      .orderBy(desc(invoices.createdAt));
    return sendSuccess(res, list);
  } catch (err) {
    return handleError(res, err, "getPatientInvoices");
  }
};

export const recordPayment = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);

    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);

    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const { paymentMethod, referenceNumber, notes } = parsed.data;
    const amountCents = toCents(parsed.data.amount);

    const staffRecord = await getStaffByUserId(req.clerkUser!.dbUserId);

    const payment = await db.transaction(async (tx) => {
      // Row lock: concurrent payments on the same invoice are serialised.
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.paymentStatus === "waived") throw new HttpError(409, "This invoice has been waived");

      const totalCents = toCents(invoice.totalAmount);
      const paidCents = toCents(invoice.paidAmount);
      const outstanding = totalCents - paidCents;

      if (outstanding <= 0) throw new HttpError(409, "This invoice is already fully paid");
      if (amountCents > outstanding) {
        throw new HttpError(422, `Payment exceeds the outstanding balance of KES ${fromCents(outstanding)}`);
      }

      if (referenceNumber) {
        const [dup] = await tx.select({ id: payments.id }).from(payments)
          .where(and(eq(payments.referenceNumber, referenceNumber), eq(payments.paymentMethod, paymentMethod)))
          .limit(1);
        if (dup) throw new HttpError(409, "A payment with this reference number was already recorded");
      }

      const newPaid = paidCents + amountCents;
      const [created] = await tx.insert(payments).values({
        invoiceId: id,
        patientId: invoice.patientId,
        amount: fromCents(amountCents),
        paymentMethod, referenceNumber, notes,
        receivedBy: staffRecord?.id ?? null,
      }).returning();

      await tx.update(invoices).set({
        paidAmount: fromCents(newPaid),
        paymentStatus: newPaid >= totalCents ? "paid" : "partial",
        paymentMethod,
        updatedAt: new Date(),
      }).where(eq(invoices.id, id));

      return created;
    });

    return sendSuccess(res, payment, "Payment recorded successfully", 201);
  } catch (err) {
    return handleError(res, err, "recordPayment");
  }
};

export const getMyInvoices = async (req: ClerkRequest, res: Response) => {
  try {
    const patient = await getPatientByUserId(req.clerkUser!.dbUserId);
    if (!patient) return sendError(res, "Patient profile not found", 404);

    const mine = await db.select().from(invoices)
      .where(eq(invoices.patientId, patient.id))
      .orderBy(desc(invoices.createdAt));
    return sendSuccess(res, mine);
  } catch (err) {
    return handleError(res, err, "getMyInvoices");
  }
};
