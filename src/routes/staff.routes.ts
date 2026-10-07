import { Router } from "express";
import { getStaffDashboard, getAllPatients, getPatientById, uploadDocument, requestEmergencyAccess, registerPatient, updatePatient } from "../controllers/staff.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const staffRoutes = Router();

const staffRoles = [
  "admin", "doctor", "nurse", "receptionist",
  "lab_technician", "radiographer", "pharmacist", "billing_officer"
] as const;

staffRoutes.get("/dashboard",                      authenticate, authorize(...staffRoles), getStaffDashboard);
staffRoutes.get("/patients",                       authenticate, authorize(...staffRoles), getAllPatients);
staffRoutes.post("/patients",                      authenticate, authorize(...staffRoles), registerPatient);
staffRoutes.get("/patients/:id",                   authenticate, authorize(...staffRoles), getPatientById);
staffRoutes.patch("/patients/:id",                 authenticate, authorize(...staffRoles), updatePatient);
staffRoutes.post("/patients/:id/emergency-access", authenticate, authorize(...staffRoles), requestEmergencyAccess);
staffRoutes.post("/documents",                     authenticate, authorize(...staffRoles), uploadDocument);
