import { Router } from "express";
import {
  createAppointment, getMyAppointments, getAppointmentById,
  cancelAppointment, getAllAppointments, updateAppointmentStatus,
} from "../controllers/appointment.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const appointmentRoutes = Router();

const staffRoles = ["admin", "receptionist", "doctor", "nurse"] as const;

appointmentRoutes.post("/",            authenticate, authorize("patient"), createAppointment);
appointmentRoutes.get("/mine",         authenticate, authorize("patient"), getMyAppointments);
// "/all" MUST be declared before "/:id", otherwise "/:id" swallows it (it was unreachable before).
appointmentRoutes.get("/all",          authenticate, authorize(...staffRoles), getAllAppointments);
appointmentRoutes.get("/:id",          authenticate, getAppointmentById);      // ownership checked in the handler
appointmentRoutes.patch("/:id/cancel", authenticate, authorize("patient"), cancelAppointment);
appointmentRoutes.patch("/:id/status", authenticate, authorize(...staffRoles), updateAppointmentStatus);
