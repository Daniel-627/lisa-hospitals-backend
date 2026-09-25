import { Router } from "express";
import {
  createAppointment, getMyAppointments, getAppointmentById,
  cancelAppointment, getAllAppointments, updateAppointmentStatus,
} from "../controllers/appointment.controller";
import { authenticate, authorize } from "../middleware/auth.middleware";
import { authenticateClerk } from "../middleware/clerk.middleware";

export const appointmentRoutes = Router();

// Patient routes — use Clerk auth
appointmentRoutes.post("/",              authenticateClerk, createAppointment);
appointmentRoutes.get("/mine",           authenticateClerk, getMyAppointments);
appointmentRoutes.get("/:id",            authenticateClerk, getAppointmentById);
appointmentRoutes.patch("/:id/cancel",   authenticateClerk, cancelAppointment);

// Staff routes — use custom JWT
appointmentRoutes.get("/",               authenticate, authorize("admin", "receptionist", "doctor", "nurse"), getAllAppointments);
appointmentRoutes.patch("/:id/status",   authenticate, authorize("admin", "receptionist", "doctor", "nurse"), updateAppointmentStatus);