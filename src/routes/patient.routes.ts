import { Router } from "express";
import { getMyProfile, updateMyProfile, getMyDocuments, getMyVisits, enrollMe } from "../controllers/patient.controller";
import { authenticate } from "../middleware/clerk.middleware";

export const patientRoutes = Router();

// Any signed-in user (including staff) can manage THEIR OWN patient record here.
patientRoutes.get("/me",           authenticate, getMyProfile);
patientRoutes.patch("/me",         authenticate, updateMyProfile);
patientRoutes.get("/me/documents", authenticate, getMyDocuments);
patientRoutes.get("/me/visits",    authenticate, getMyVisits);
patientRoutes.post("/me/enroll",   authenticate, enrollMe);
