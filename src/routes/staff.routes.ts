import { Router } from "express";
import { getStaffDashboard, getAllPatients, getPatientById, uploadDocument, requestEmergencyAccess, registerPatient, updatePatient } from "../controllers/staff.controller";
import { checkIn, getQueue, pickUp, releaseVisit, completeVisit, markLeft, getVisitDetail, startTriage, cancelTriage, recordTriage } from "../controllers/visit.controller";
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

// Check-in and department queue (role rules are enforced inside the controller)
staffRoutes.post("/visits",              authenticate, authorize(...staffRoles), checkIn);
staffRoutes.get("/queue",                authenticate, authorize(...staffRoles), getQueue);
staffRoutes.post("/visits/:id/pickup",   authenticate, authorize(...staffRoles), pickUp);
staffRoutes.post("/visits/:id/release",  authenticate, authorize(...staffRoles), releaseVisit);
staffRoutes.post("/visits/:id/complete", authenticate, authorize(...staffRoles), completeVisit);
staffRoutes.post("/visits/:id/left",     authenticate, authorize(...staffRoles), markLeft);

// Triage
staffRoutes.get("/visits/:id",                  authenticate, authorize(...staffRoles), getVisitDetail);
staffRoutes.post("/visits/:id/triage/start",    authenticate, authorize(...staffRoles), startTriage);
staffRoutes.post("/visits/:id/triage/cancel",   authenticate, authorize(...staffRoles), cancelTriage);
staffRoutes.post("/visits/:id/triage",          authenticate, authorize(...staffRoles), recordTriage);
