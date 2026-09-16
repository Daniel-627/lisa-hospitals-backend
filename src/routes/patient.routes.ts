import { Router } from "express";
import { getMyProfile, updateMyProfile, getMyDocuments, getMyVisits } from "../controllers/patient.controller.js";
import { authenticate, authorize } from "../middleware/auth.middleware.js";

export const patientRoutes = Router();

patientRoutes.get("/me",           authenticate, authorize("patient"), getMyProfile);
patientRoutes.patch("/me",         authenticate, authorize("patient"), updateMyProfile);
patientRoutes.get("/me/documents", authenticate, authorize("patient"), getMyDocuments);
patientRoutes.get("/me/visits",    authenticate, authorize("patient"), getMyVisits);