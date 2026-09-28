import { Router } from "express";
import { createInvoice, getInvoiceById, getPatientInvoices, recordPayment, getMyInvoices } from "../controllers/billing.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const billingRoutes = Router();

const staffRoles = ["admin", "billing_officer", "receptionist"] as const;

billingRoutes.get("/mine",          authenticate, getMyInvoices);
billingRoutes.post("/",             authenticate, authorize(...staffRoles), createInvoice);
billingRoutes.get("/:id",           authenticate, getInvoiceById);
billingRoutes.get("/patient/:id",   authenticate, authorize(...staffRoles), getPatientInvoices);
billingRoutes.post("/:id/payment",  authenticate, authorize(...staffRoles), recordPayment);