import { Router } from "express";
import { getMyProfile, updateMyProfile, getMyDocuments, getMyVisits } from "../controllers/patient.controller";
import { authenticate } from "../middleware/clerk.middleware";

export const patientRoutes = Router();

patientRoutes.get("/me",           authenticate, getMyProfile);
patientRoutes.patch("/me",         authenticate, updateMyProfile);
patientRoutes.get("/me/documents", authenticate, getMyDocuments);
patientRoutes.get("/me/visits",    authenticate, getMyVisits);