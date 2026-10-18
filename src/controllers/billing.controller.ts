import { Response } from "express";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, invoices, invoiceItems, payments, patients, users, insuranceClaims, doctors, visits, priceItems } from "../db";
import { sendSuccess, sendError } from "../utils/response";
import { ClerkRequest } from "../middleware/clerk.middleware";
import { HttpError, handleError } from "../utils/errors";
import { getPatientByUserId, getStaffByUserId, hasRole, isStaff, nextNumber } from "../utils/access";
import { fromCents, toCents } from "../utils/money";
import { isUuid, todayEAT, uuid } from "../utils/validation";
import { audit } from "../utils/audit";
import { listOnlinePayments } from "./paystack.controller";
import { idFirstName, idLastName } from "../utils/patientIdentity";

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

    await audit(req, "invoice.created", "invoices", result.id, null, { patientId, invoiceNumber: result.invoiceNumber, total: result.totalAmount });
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

    const mine = await getPatientByUserId(req.clerkUser!.dbUserId);
    const owns = !!mine && invoice.patientId === mine.id;
    if (!owns && !hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Invoice not found", 404);

    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id));
    const invoicePayments = await db.select().from(payments).where(eq(payments.invoiceId, id)).orderBy(payments.paidAt);

    const [patient] = await db
      .select({ id: patients.id, patientNumber: patients.patientNumber, firstName: idFirstName, lastName: idLastName, insuranceScheme: patients.insuranceScheme, insuranceNumber: patients.insuranceNumber })
      .from(patients).leftJoin(users, eq(patients.userId, users.id)).where(eq(patients.id, invoice.patientId)).limit(1);
    // Insurance claims are back-office detail: only the billing desk sees them.
    const claims = owns && !hasRole(req, ...CASHIER_ROLES) ? [] : await db.select().from(insuranceClaims).where(eq(insuranceClaims.invoiceId, id)).orderBy(desc(insuranceClaims.submittedAt));
    const online = hasRole(req, ...CASHIER_ROLES) ? await listOnlinePayments(id) : [];
    return sendSuccess(res, { ...invoice, items, payments: invoicePayments, patient, claims, online });
  } catch (err) {
    return handleError(res, err, "getInvoiceById");
  }
};

export const getPatientInvoices = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
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

/**
 * Applies one payment to an invoice inside a transaction: locks the invoice row (concurrent payments are
 * serialised), checks the balance, inserts the payment and updates paid amount / status.
 */
export async function applyPayment(
  tx: any,
  p: { invoiceId: string; amountCents: number; paymentMethod: z.infer<typeof methodEnum> | "paystack"; referenceNumber?: string; notes?: string; receivedBy: string | null; capToOutstanding?: boolean },
) {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");
  if (!invoice) throw new HttpError(404, "Invoice not found");
  if (invoice.paymentStatus === "waived") throw new HttpError(409, "This invoice has been waived");

  const totalCents = toCents(invoice.totalAmount);
  const paidCents = toCents(invoice.paidAmount);
  const outstanding = totalCents - paidCents;
  if (outstanding <= 0) throw new HttpError(409, "This invoice is already fully paid");

  let amountCents = p.amountCents;
  if (amountCents > outstanding) {
    if (!p.capToOutstanding) throw new HttpError(422, `Payment exceeds the outstanding balance of KES ${fromCents(outstanding)}`);
    amountCents = outstanding;
  }

  if (p.referenceNumber) {
    const [dup] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.referenceNumber, p.referenceNumber), eq(payments.paymentMethod, p.paymentMethod)))
      .limit(1);
    if (dup) throw new HttpError(409, "A payment with this reference number was already recorded");
  }

  const newPaid = paidCents + amountCents;
  const [created] = await tx.insert(payments).values({
    invoiceId: p.invoiceId,
    patientId: invoice.patientId,
    amount: fromCents(amountCents),
    paymentMethod: p.paymentMethod, referenceNumber: p.referenceNumber, notes: p.notes,
    receivedBy: p.receivedBy,
  }).returning();

  await tx.update(invoices).set({
    paidAmount: fromCents(newPaid),
    paymentStatus: newPaid >= totalCents ? "paid" : "partial",
    paymentMethod: p.paymentMethod,
    updatedAt: new Date(),
  }).where(eq(invoices.id, p.invoiceId));

  return created;
}

export const recordPayment = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);

    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);

    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const { paymentMethod, referenceNumber, notes } = parsed.data;

    const staffRecord = await getStaffByUserId(req.clerkUser!.dbUserId);
    const payment = await db.transaction((tx) => applyPayment(tx, {
      invoiceId: id, amountCents: toCents(parsed.data.amount), paymentMethod, referenceNumber, notes, receivedBy: staffRecord?.id ?? null,
    }));

    await audit(req, "payment.recorded", "payments", payment.id, null, { invoiceId: id, amount: payment.amount, method: paymentMethod });
    return sendSuccess(res, payment, "Payment recorded successfully", 201);
  } catch (err) {
    return handleError(res, err, "recordPayment");
  }
};

// ── Billing desk: list, summary, suggestions ─────────────────────────────────
const STATUSES = ["pending", "partial", "paid", "waived"] as const;

export const listInvoices = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);

    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const status = String(req.query.status ?? "");
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const conds = [];
    if (status === "unpaid") conds.push(sql`${invoices.paymentStatus} in ('pending', 'partial')`);
    else if ((STATUSES as readonly string[]).includes(status)) conds.push(eq(invoices.paymentStatus, status as any));
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      conds.push(or(
        ilike(invoices.invoiceNumber, like), ilike(patients.patientNumber, like),
        ilike(sql`concat(${idFirstName}, ' ', ${idLastName})`, like),
      ));
    }

    const rows = await db
      .select({
        id: invoices.id, invoiceNumber: invoices.invoiceNumber, totalAmount: invoices.totalAmount, paidAmount: invoices.paidAmount,
        paymentStatus: invoices.paymentStatus, createdAt: invoices.createdAt, visitId: invoices.visitId,
        patientId: patients.id, patientNumber: patients.patientNumber, firstName: idFirstName, lastName: idLastName,
      })
      .from(invoices)
      .innerJoin(patients, eq(invoices.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(invoices.createdAt))
      .limit(limit).offset(offset);

    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listInvoices");
  }
};

export const getBillingSummary = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    // "Today" is the Nairobi day: payments.paid_at is stored in UTC, so shift by +3h before comparing.
    const today = todayEAT();
    const [owed] = await db.select({
      outstanding: sql<string>`coalesce(sum(${invoices.totalAmount} - ${invoices.paidAmount}), 0)`,
      openInvoices: sql<number>`count(*)`,
    }).from(invoices).where(sql`${invoices.paymentStatus} in ('pending', 'partial')`);

    const [collected] = await db.select({
      total: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      count: sql<number>`count(*)`,
    }).from(payments).where(sql`(${payments.paidAt} + interval '3 hours')::date = ${today}::date`);

    const [claims] = await db.select({ pending: sql<number>`count(*)`, amount: sql<string>`coalesce(sum(${insuranceClaims.claimAmount}), 0)` })
      .from(insuranceClaims).where(sql`${insuranceClaims.status} in ('submitted', 'approved')`);

    return sendSuccess(res, {
      outstanding: owed.outstanding, openInvoices: Number(owed.openInvoices),
      collectedToday: collected.total, paymentsToday: Number(collected.count),
      claimsOpen: Number(claims.pending), claimsOpenAmount: claims.amount,
    });
  } catch (err) {
    return handleError(res, err, "getBillingSummary");
  }
};

// Starting points for a new invoice. No price list exists, so only prices already stored are suggested (the doctor's fee).
export const suggestCharges = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const visitId = req.query.visitId;
    if (!isUuid(visitId)) return sendError(res, "Visit not found", 404);

    const [visit] = await db.select({ id: visits.id, patientId: visits.patientId, visitNumber: visits.visitNumber, assignedDoctorId: visits.assignedDoctorId })
      .from(visits).where(eq(visits.id, visitId)).limit(1);
    if (!visit) return sendError(res, "Visit not found", 404);

    const items: { description: string; quantity: number; unitPrice: string | null }[] = [];
    if (visit.assignedDoctorId) {
      const [doc] = await db.select({ fee: doctors.consultationFee, speciality: doctors.speciality }).from(doctors).where(eq(doctors.id, visit.assignedDoctorId)).limit(1);
      if (doc?.fee) items.push({ description: `Consultation fee (${doc.speciality})`, quantity: 1, unitPrice: doc.fee });
    }
    return sendSuccess(res, { visitId: visit.id, patientId: visit.patientId, visitNumber: visit.visitNumber, items });
  } catch (err) {
    return handleError(res, err, "suggestCharges");
  }
};

// ── Price list ───────────────────────────────────────────────────────────────
const PRICE_CATEGORIES = ["consultation", "lab", "radiology", "pharmacy", "ward", "procedure", "other"] as const;

export const listPrices = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const all = req.query.all === "true" && hasRole(req, "admin", "billing_officer"); // managers also see switched-off items
    const conds = [];
    if (!all) conds.push(eq(priceItems.isActive, true));
    if (q) conds.push(ilike(priceItems.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`));
    if ((PRICE_CATEGORIES as readonly string[]).includes(category)) conds.push(eq(priceItems.category, category));
    const rows = await db.select().from(priceItems).where(conds.length ? and(...conds) : undefined)
      .orderBy(priceItems.category, priceItems.name).limit(500);
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listPrices");
  }
};

const priceSchema = z.object({
  category:  z.enum(PRICE_CATEGORIES),
  name:      z.string().trim().min(1).max(300),
  unitPrice: money,
}).strict();

export const createPrice = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, "admin", "billing_officer")) return sendError(res, "Access denied", 403);
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const [row] = await db.insert(priceItems).values({ category: d.category, name: d.name, unitPrice: fromCents(toCents(d.unitPrice)) })
      .onConflictDoNothing().returning();
    if (!row) return sendError(res, "That item is already in the price list", 409);
    await audit(req, "price.created", "price_items", row.id, null, { name: row.name, unitPrice: row.unitPrice });
    return sendSuccess(res, row, "Added to the price list", 201);
  } catch (err) {
    return handleError(res, err, "createPrice");
  }
};

const priceUpdateSchema = z.object({
  unitPrice: money.optional(),
  isActive:  z.boolean().optional(),
}).strict().refine((v) => v.unitPrice !== undefined || v.isActive !== undefined, "Nothing to change");

export const updatePrice = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, "admin", "billing_officer")) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Price not found", 404);
    const parsed = priceUpdateSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const patch: Record<string, unknown> = {};
    if (parsed.data.unitPrice !== undefined) patch.unitPrice = fromCents(toCents(parsed.data.unitPrice));
    if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
    const [before] = await db.select().from(priceItems).where(eq(priceItems.id, id)).limit(1);
    if (!before) return sendError(res, "Price not found", 404);
    const [row] = await db.update(priceItems).set(patch).where(eq(priceItems.id, id)).returning();
    await audit(req, "price.updated", "price_items", id, { unitPrice: before.unitPrice, isActive: before.isActive }, { unitPrice: row.unitPrice, isActive: row.isActive });
    return sendSuccess(res, row);
  } catch (err) {
    return handleError(res, err, "updatePrice");
  }
};

// ── Change an unpaid invoice ─────────────────────────────────────────────────
const addItemsSchema = z.object({
  items: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    quantity:    z.number().int().min(1).max(10_000),
    unitPrice:   money,
  })).min(1).max(100),
}).strict();

// Charges keep arriving while a patient is in the ward: add lines to an open invoice.
export const addInvoiceItems = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);
    const parsed = addItemsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const lines = parsed.data.items.map((i) => {
      const unit = toCents(i.unitPrice);
      return { description: i.description, quantity: i.quantity, unit, total: unit * i.quantity };
    });
    const addCents = lines.reduce((sum, l) => sum + l.total, 0);
    if (addCents <= 0) return sendError(res, "The added charges must total more than 0", 422);

    const updated = await db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.paymentStatus === "waived") throw new HttpError(409, "This invoice has been waived");

      const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(invoiceItems).where(eq(invoiceItems.invoiceId, id));
      if (Number(n) + lines.length > 200) throw new HttpError(422, "This invoice has too many lines. Raise a new invoice instead.");

      await tx.insert(invoiceItems).values(lines.map((l) => ({
        invoiceId: id, description: l.description, quantity: l.quantity, unitPrice: fromCents(l.unit), totalPrice: fromCents(l.total),
      })));

      const newTotal = toCents(invoice.totalAmount) + addCents;
      const paid = toCents(invoice.paidAmount);
      // A fully paid invoice that gets new charges is owing again.
      const status = paid <= 0 ? "pending" : paid >= newTotal ? "paid" : "partial";
      const [row] = await tx.update(invoices).set({ totalAmount: fromCents(newTotal), paymentStatus: status, updatedAt: new Date() })
        .where(eq(invoices.id, id)).returning();
      return { row, before: invoice.totalAmount };
    });

    await audit(req, "invoice.items_added", "invoices", id, { total: updated.before }, { total: updated.row.totalAmount, added: lines.length });
    return sendSuccess(res, updated.row, "Charges added");
  } catch (err) {
    return handleError(res, err, "addInvoiceItems");
  }
};

const waiveSchema = z.object({ reason: z.string().trim().min(5, "Give a reason (at least a few words)").max(500) }).strict();

// Writes off whatever is still owed (charity, hardship, error). Already-received payments are kept.
export const waiveInvoice = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, "billing_officer", "admin")) return sendError(res, "Only the billing officer or an admin can waive an invoice", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);
    const parsed = waiveSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);

    const result = await db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.paymentStatus === "waived") throw new HttpError(409, "This invoice has already been waived");
      const owed = toCents(invoice.totalAmount) - toCents(invoice.paidAmount);
      if (owed <= 0) throw new HttpError(409, "Nothing is owed on this invoice");

      const note = `Waived KES ${fromCents(owed)}: ${parsed.data.reason}`;
      await tx.update(invoices).set({ paymentStatus: "waived", notes: invoice.notes ? `${invoice.notes}\n${note}` : note, updatedAt: new Date() }).where(eq(invoices.id, id));
      // Open claims on a waived invoice no longer make sense.
      await tx.update(insuranceClaims).set({ status: "rejected", resolvedAt: new Date(), notes: "Invoice waived" })
        .where(and(eq(insuranceClaims.invoiceId, id), sql`${insuranceClaims.status} in ('submitted', 'approved')`));
      return { owed: fromCents(owed) };
    });

    await audit(req, "invoice.waived", "invoices", id, null, { amount: result.owed, reason: parsed.data.reason });
    return sendSuccess(res, result, "Invoice waived");
  } catch (err) {
    return handleError(res, err, "waiveInvoice");
  }
};

// ── Insurance claims ─────────────────────────────────────────────────────────
const SCHEMES = ["sha", "maki", "aon", "mtiba"] as const;
const claimSchema = z.object({
  scheme: z.enum(SCHEMES),
  claimNumber: z.string().trim().max(100).optional(),
  claimAmount: money.refine((v) => v > 0, "Claim amount must be greater than 0"),
  notes: z.string().max(1000).optional(),
}).strict();

export const createClaim = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Invoice not found", 404);
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const claimCents = toCents(d.claimAmount);

    const claim = await db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
      if (!invoice) throw new HttpError(404, "Invoice not found");
      if (invoice.paymentStatus === "waived") throw new HttpError(409, "This invoice has been waived");
      const outstanding = toCents(invoice.totalAmount) - toCents(invoice.paidAmount);
      if (outstanding <= 0) throw new HttpError(409, "This invoice is already fully paid");

      // Claims still waiting on the insurer count against the balance, so the same money isn't claimed twice.
      const [{ open }] = await tx.select({ open: sql<string>`coalesce(sum(${insuranceClaims.claimAmount}), 0)` }).from(insuranceClaims)
        .where(and(eq(insuranceClaims.invoiceId, id), sql`${insuranceClaims.status} in ('submitted', 'approved')`));
      const available = outstanding - toCents(open);
      if (claimCents > available) throw new HttpError(422, `The claim exceeds what is left to claim on this invoice (KES ${fromCents(Math.max(available, 0))})`);

      const [row] = await tx.insert(insuranceClaims).values({
        invoiceId: id, patientId: invoice.patientId, scheme: d.scheme, claimNumber: d.claimNumber || null,
        claimAmount: fromCents(claimCents), notes: d.notes,
      }).returning();
      return row;
    });

    await audit(req, "claim.submitted", "insurance_claims", claim.id, null, { invoiceId: id, scheme: d.scheme, amount: claim.claimAmount });
    return sendSuccess(res, claim, "Claim recorded", 201);
  } catch (err) {
    return handleError(res, err, "createClaim");
  }
};

export const listClaims = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const status = String(req.query.status ?? "open");
    const where = status === "open" ? sql`${insuranceClaims.status} in ('submitted', 'approved')`
      : ["submitted", "approved", "rejected", "paid"].includes(status) ? eq(insuranceClaims.status, status) : undefined;

    const rows = await db
      .select({
        id: insuranceClaims.id, invoiceId: insuranceClaims.invoiceId, invoiceNumber: invoices.invoiceNumber, scheme: insuranceClaims.scheme,
        claimNumber: insuranceClaims.claimNumber, claimAmount: insuranceClaims.claimAmount, approvedAmount: insuranceClaims.approvedAmount,
        status: insuranceClaims.status, submittedAt: insuranceClaims.submittedAt, resolvedAt: insuranceClaims.resolvedAt, notes: insuranceClaims.notes,
        patientNumber: patients.patientNumber, firstName: idFirstName, lastName: idLastName,
      })
      .from(insuranceClaims)
      .innerJoin(invoices, eq(insuranceClaims.invoiceId, invoices.id))
      .innerJoin(patients, eq(insuranceClaims.patientId, patients.id))
      .leftJoin(users, eq(patients.userId, users.id))
      .where(where)
      .orderBy(desc(insuranceClaims.submittedAt)).limit(200);
    return sendSuccess(res, rows);
  } catch (err) {
    return handleError(res, err, "listClaims");
  }
};

const resolveClaimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved"), approvedAmount: money.refine((v) => v > 0, "Approved amount must be greater than 0"), notes: z.string().max(1000).optional() }).strict(),
  z.object({ status: z.literal("rejected"), notes: z.string().trim().min(3, "Say why it was rejected").max(1000) }).strict(),
  // "paid": the insurer has paid. Records a payment on the invoice for the amount received.
  z.object({ status: z.literal("paid"), amountReceived: money.refine((v) => v > 0, "Amount received must be greater than 0"), referenceNumber: z.string().trim().max(100).optional(), notes: z.string().max(1000).optional() }).strict(),
]);

export const resolveClaim = async (req: ClerkRequest, res: Response) => {
  try {
    if (!hasRole(req, ...CASHIER_ROLES)) return sendError(res, "Access denied", 403);
    const { id } = req.params;
    if (!isUuid(id)) return sendError(res, "Claim not found", 404);
    const parsed = resolveClaimSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, parsed.error.issues[0].message, 422);
    const d = parsed.data;
    const staffRecord = await getStaffByUserId(req.clerkUser!.dbUserId);

    const claim = await db.transaction(async (tx) => {
      const [c] = await tx.select().from(insuranceClaims).where(eq(insuranceClaims.id, id)).for("update");
      if (!c) throw new HttpError(404, "Claim not found");
      if (c.status === "rejected" || c.status === "paid") throw new HttpError(409, `This claim is already ${c.status}`);

      if (d.status === "approved") {
        if (toCents(d.approvedAmount) > toCents(c.claimAmount)) throw new HttpError(422, "The approved amount can't be more than the amount claimed");
        const [row] = await tx.update(insuranceClaims).set({ status: "approved", approvedAmount: fromCents(toCents(d.approvedAmount)), notes: d.notes ?? c.notes }).where(eq(insuranceClaims.id, id)).returning();
        return row;
      }
      if (d.status === "rejected") {
        const [row] = await tx.update(insuranceClaims).set({ status: "rejected", resolvedAt: new Date(), notes: d.notes }).where(eq(insuranceClaims.id, id)).returning();
        return row;
      }

      // paid: the money lands on the invoice as a payment from the scheme (capped at what is still owed).
      await applyPayment(tx, {
        invoiceId: c.invoiceId, amountCents: toCents(d.amountReceived), paymentMethod: c.scheme,
        referenceNumber: d.referenceNumber, notes: `Insurance claim ${c.claimNumber ?? c.id}${d.notes ? `: ${d.notes}` : ""}`,
        receivedBy: staffRecord?.id ?? null, capToOutstanding: true,
      });
      const [row] = await tx.update(insuranceClaims).set({ status: "paid", resolvedAt: new Date(), approvedAmount: c.approvedAmount ?? fromCents(toCents(d.amountReceived)), notes: d.notes ?? c.notes }).where(eq(insuranceClaims.id, id)).returning();
      return row;
    });

    await audit(req, `claim.${d.status}`, "insurance_claims", id, null, { invoiceId: claim.invoiceId, scheme: claim.scheme });
    return sendSuccess(res, claim, `Claim ${d.status}`);
  } catch (err) {
    return handleError(res, err, "resolveClaim");
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
