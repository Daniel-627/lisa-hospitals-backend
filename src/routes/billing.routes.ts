import { Router } from "express";
import { createInvoice, getInvoiceById, getPatientInvoices, recordPayment, getMyInvoices } from "../controllers/billing.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";

export const billingRoutes = Router();

const staffRoles = ["admin", "billing_officer", "receptionist"] as const;

billingRoutes.get("/mine",           authenticate, authorize("patient"), getMyInvoices);
billingRoutes.post("/",              authenticate, authorize(...staffRoles), createInvoice);
billingRoutes.get("/:id",            authenticate, authorize(...staffRoles, "patient"), getInvoiceById);
billingRoutes.get("/patient/:id",    authenticate, authorize(...staffRoles), getPatientInvoices);
billingRoutes.post("/:id/payment",   authenticate, authorize(...staffRoles), recordPayment);