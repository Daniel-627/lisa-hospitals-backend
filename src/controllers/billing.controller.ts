import { Request, Response } from "express";
import { db, invoices, invoiceItems, payments, patients, users, staff } from "../db";
import { eq } from "drizzle-orm";
import { sendSuccess, sendError } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";
import { z } from "zod";

const invoiceSchema = z.object({
  patientId:     z.string().uuid(),
  visitId:       z.string().uuid().optional(),
  notes:         z.string().optional(),
  paymentMethod: z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]).optional(),
  items: z.array(z.object({
    description: z.string().min(1),
    quantity:    z.number().min(1),
    unitPrice:   z.number().min(0),
  })).min(1),
});

const paymentSchema = z.object({
  amount:          z.number().min(1),
  paymentMethod:   z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]),
  referenceNumber: z.string().optional(),
  notes:           z.string().optional(),
});

const generateInvoiceNumber = () =>
  `INV-${Date.now().toString().slice(-8)}`;

export const createInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = invoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.issues[0].message, 422);
    }

    const { patientId, visitId, notes, paymentMethod, items } = parsed.data;

    const totalAmount = items.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice, 0
    );

    // Get staff record if exists
    const staffRecord = await db
      .select()
      .from(staff)
      .where(eq(staff.userId, req.user!.id))
      .limit(1);

    const generatedBy = staffRecord.length > 0 ? staffRecord[0].id : null;

    const [invoice] = await db.insert(invoices).values({
      patientId,
      visitId,
      invoiceNumber: generateInvoiceNumber(),
      totalAmount:   totalAmount.toString(),
      paidAmount:    "0",
      paymentStatus: "pending",
      paymentMethod,
      generatedBy,
      notes,
    }).returning();

    const invoiceItemsData = items.map(item => ({
      invoiceId:   invoice.id,
      description: item.description,
      quantity:    item.quantity,
      unitPrice:   item.unitPrice.toString(),
      totalPrice:  (item.quantity * item.unitPrice).toString(),
    }));

    await db.insert(invoiceItems).values(invoiceItemsData);

    const itemsCreated = await db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoice.id));

    return sendSuccess(res, { ...invoice, items: itemsCreated },
      "Invoice created successfully", 201);
  } catch (err) {
    console.error("createInvoice error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getInvoiceById = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);

    if (!invoice) return sendError(res, "Invoice not found", 404);

    const items = await db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, id));

    const invoicePayments = await db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, id));

    return sendSuccess(res, { ...invoice, items, payments: invoicePayments });
  } catch (err) {
    console.error("getInvoiceById error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getPatientInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const patientInvoices = await db
      .select()
      .from(invoices)
      .where(eq(invoices.patientId, id))
      .orderBy(invoices.createdAt);

    return sendSuccess(res, patientInvoices);
  } catch (err) {
    console.error("getPatientInvoices error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const recordPayment = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, parsed.error.errors[0].message, 422);
    }

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);

    if (!invoice) return sendError(res, "Invoice not found", 404);

    const newPaidAmount = parseFloat(invoice.paidAmount) + parsed.data.amount;
    const totalAmount   = parseFloat(invoice.totalAmount);

    const paymentStatus =
      newPaidAmount >= totalAmount ? "paid"    :
      newPaidAmount > 0            ? "partial" : "pending";

    // Get staff record if exists
    const staffRecord = await db
      .select()
      .from(staff)
      .where(eq(staff.userId, req.user!.id))
      .limit(1);

    const receivedBy = staffRecord.length > 0 ? staffRecord[0].id : null;

    const [payment] = await db.insert(payments).values({
      invoiceId:       id,
      patientId:       invoice.patientId,
      amount:          parsed.data.amount.toString(),
      paymentMethod:   parsed.data.paymentMethod,
      referenceNumber: parsed.data.referenceNumber,
      receivedBy,
      notes:           parsed.data.notes,
    }).returning();

    await db.update(invoices).set({
      paidAmount:    newPaidAmount.toString(),
      paymentStatus,
      paymentMethod: parsed.data.paymentMethod,
    }).where(eq(invoices.id, id));

    return sendSuccess(res, payment, "Payment recorded successfully", 201);
  } catch (err) {
    console.error("recordPayment error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};

export const getMyInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, req.user!.id))
      .limit(1);

    if (!patient) return sendError(res, "Patient profile not found", 404);

    const myInvoices = await db
      .select()
      .from(invoices)
      .where(eq(invoices.patientId, patient.id))
      .orderBy(invoices.createdAt);

    return sendSuccess(res, myInvoices);
  } catch (err) {
    console.error("getMyInvoices error:", err);
    return sendError(res, "Something went wrong", 500);
  }
};