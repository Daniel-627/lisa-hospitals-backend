import { Router } from "express";
import { getMyProfile, updateMyProfile, getMyDocuments, getMyVisits } from "../controllers/patient.controller";
import { authenticateClerk } from "../middleware/clerk.middleware";

export const patientRoutes = Router();

patientRoutes.get("/me",           authenticateClerk, getMyProfile);
patientRoutes.patch("/me",         authenticateClerk, updateMyProfile);
patientRoutes.get("/me/documents", authenticateClerk, getMyDocuments);
patientRoutes.get("/me/visits",    authenticateClerk, getMyVisits);