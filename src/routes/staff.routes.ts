import { Router } from "express";
import { getStaffDashboard, getAllPatients, getPatientById, uploadDocument } from "../controllers/staff.controller";
import { authenticate, authorize } from "../middleware/auth.middleware";

export const staffRoutes = Router();

const staffRoles = ["admin", "doctor", "nurse", "receptionist", "lab_technician", "radiographer", "pharmacist", "billing_officer"] as const;

staffRoutes.get("/dashboard",    authenticate, authorize(...staffRoles), getStaffDashboard);
staffRoutes.get("/patients",     authenticate, authorize(...staffRoles), getAllPatients);
staffRoutes.get("/patients/:id", authenticate, authorize(...staffRoles), getPatientById);
staffRoutes.post("/documents",   authenticate, authorize(...staffRoles), uploadDocument);