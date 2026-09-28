import { Router } from "express";
import {
  createAppointment, getMyAppointments, getAppointmentById,
  cancelAppointment, getAllAppointments, updateAppointmentStatus,
} from "../controllers/appointment.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const appointmentRoutes = Router();

appointmentRoutes.post("/",              authenticate, createAppointment);
appointmentRoutes.get("/mine",           authenticate, getMyAppointments);
appointmentRoutes.get("/:id",            authenticate, getAppointmentById);
appointmentRoutes.patch("/:id/cancel",   authenticate, cancelAppointment);
appointmentRoutes.get("/all",            authenticate, authorize("admin", "receptionist", "doctor", "nurse"), getAllAppointments);
appointmentRoutes.patch("/:id/status",   authenticate, authorize("admin", "receptionist", "doctor", "nurse"), updateAppointmentStatus);