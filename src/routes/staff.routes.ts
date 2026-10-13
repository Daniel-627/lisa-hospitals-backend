import { Router } from "express";
import { getStaffDashboard, getAllPatients, getPatientById, uploadDocument, requestEmergencyAccess, registerPatient, updatePatient } from "../controllers/staff.controller";
import { getConsultation, saveConsultation } from "../controllers/consultation.controller";
import { placeOrders, cancelOrder, releaseOrder, myOrders, labWorklist, labCollect, labSubmitResult, radiologyWorklist, radiologySubmitResult, pharmacyWorklist, dispense } from "../controllers/orders.controller";
import { requestAccess, listAccessRequests, decideAccessRequest, shareRecord, revokeShare } from "../controllers/access.controller";
import { checkIn, getQueue, pickUp, releaseVisit, completeVisit, markLeft, getVisitDetail, startTriage, cancelTriage, recordTriage } from "../controllers/visit.controller";
import { admitPatient, listAdmissions, getAdmission, updateAdmissionBed, dischargePatient } from "../controllers/admission.controller";
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

// Doctor consultation (doctors of the patient's department only; enforced in the controller)
staffRoutes.get("/visits/:id/consultation", authenticate, authorize(...staffRoles), getConsultation);
staffRoutes.put("/visits/:id/consultation", authenticate, authorize(...staffRoles), saveConsultation);

// Access to a patient's clinical record is controlled by the treating doctor
staffRoutes.post("/patients/:id/access-request",  authenticate, authorize(...staffRoles), requestAccess);
staffRoutes.get("/access-requests",               authenticate, authorize(...staffRoles), listAccessRequests);
staffRoutes.post("/access-requests/:id/decide",   authenticate, authorize(...staffRoles), decideAccessRequest);
staffRoutes.post("/patients/:id/share",           authenticate, authorize(...staffRoles), shareRecord);
staffRoutes.post("/shares/:id/revoke",            authenticate, authorize(...staffRoles), revokeShare);

// Admissions and discharge (role rules are enforced inside the controller)
staffRoutes.post("/admissions",               authenticate, authorize(...staffRoles), admitPatient);
staffRoutes.get("/admissions",                authenticate, authorize(...staffRoles), listAdmissions);
staffRoutes.get("/admissions/:id",            authenticate, authorize(...staffRoles), getAdmission);
staffRoutes.patch("/admissions/:id/bed",      authenticate, authorize(...staffRoles), updateAdmissionBed);
staffRoutes.post("/admissions/:id/discharge", authenticate, authorize(...staffRoles), dischargePatient);
// Orders, results and dispensing (role rules are enforced inside the controller)
staffRoutes.post("/visits/:id/orders",                  authenticate, authorize(...staffRoles), placeOrders);
staffRoutes.post("/orders/:kind/:id/cancel",            authenticate, authorize(...staffRoles), cancelOrder);
staffRoutes.post("/orders/:kind/:id/release",           authenticate, authorize(...staffRoles), releaseOrder);
staffRoutes.get("/my-orders",                           authenticate, authorize(...staffRoles), myOrders);
staffRoutes.get("/lab/worklist",                        authenticate, authorize(...staffRoles), labWorklist);
staffRoutes.post("/lab/orders/:id/collect",             authenticate, authorize(...staffRoles), labCollect);
staffRoutes.post("/lab/orders/:id/result",              authenticate, authorize(...staffRoles), labSubmitResult);
staffRoutes.get("/radiology/worklist",                  authenticate, authorize(...staffRoles), radiologyWorklist);
staffRoutes.post("/radiology/orders/:id/result",        authenticate, authorize(...staffRoles), radiologySubmitResult);
staffRoutes.get("/pharmacy/worklist",                   authenticate, authorize(...staffRoles), pharmacyWorklist);
staffRoutes.post("/pharmacy/prescriptions/:id/dispense", authenticate, authorize(...staffRoles), dispense);
