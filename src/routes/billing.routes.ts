import { Router } from "express";
import {
  createInvoice, getInvoiceById, getPatientInvoices, recordPayment, getMyInvoices,
  listInvoices, getBillingSummary, suggestCharges, addInvoiceItems, waiveInvoice, createClaim, listClaims, resolveClaim,
} from "../controllers/billing.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const billingRoutes = Router();

const staffRoles = ["admin", "billing_officer", "receptionist"] as const;

// Fixed paths first: they must not be read as an invoice id.
billingRoutes.get("/mine",          authenticate, getMyInvoices);
billingRoutes.get("/summary",       authenticate, authorize(...staffRoles), getBillingSummary);
billingRoutes.get("/suggest",       authenticate, authorize(...staffRoles), suggestCharges);
billingRoutes.get("/claims",        authenticate, authorize(...staffRoles), listClaims);
billingRoutes.post("/claims/:id/resolve", authenticate, authorize(...staffRoles), resolveClaim);
billingRoutes.get("/patient/:id",   authenticate, authorize(...staffRoles), getPatientInvoices);

billingRoutes.get("/",              authenticate, authorize(...staffRoles), listInvoices);
billingRoutes.post("/",             authenticate, authorize(...staffRoles), createInvoice);
billingRoutes.get("/:id",           authenticate, getInvoiceById);
billingRoutes.post("/:id/payment",  authenticate, authorize(...staffRoles), recordPayment);
billingRoutes.post("/:id/items",    authenticate, authorize(...staffRoles), addInvoiceItems);
billingRoutes.post("/:id/waive",    authenticate, authorize("admin", "billing_officer"), waiveInvoice);
billingRoutes.post("/:id/claims",   authenticate, authorize(...staffRoles), createClaim);
