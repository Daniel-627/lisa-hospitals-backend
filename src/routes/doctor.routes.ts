import { Router } from "express";
import { getAllDoctors, getDoctorById, getDoctorAvailability } from "../controllers/doctor.controller.js";

export const doctorRoutes = Router();

doctorRoutes.get("/",                 getAllDoctors);
doctorRoutes.get("/:id",              getDoctorById);
doctorRoutes.get("/:id/availability", getDoctorAvailability);