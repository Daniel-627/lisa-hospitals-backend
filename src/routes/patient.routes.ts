import { Router } from "express";
import { getMyProfile, updateMyProfile, getMyDocuments, getMyVisits } from "../controllers/patient.controller";
import { authenticate, authorize } from "../middleware/auth.middleware";

export const patientRoutes = Router();

patientRoutes.get("/me",           authenticate, authorize("patient"), getMyProfile);
patientRoutes.patch("/me",         authenticate, authorize("patient"), updateMyProfile);
patientRoutes.get("/me/documents", authenticate, authorize("patient"), getMyDocuments);
patientRoutes.get("/me/visits",    authenticate, authorize("patient"), getMyVisits);