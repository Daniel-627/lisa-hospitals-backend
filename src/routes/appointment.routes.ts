import { Router } from "express";
import {
  createAppointment, getMyAppointments, getAppointmentById,
  cancelAppointment, getAllAppointments, updateAppointmentStatus,
} from "../controllers/appointment.controller";
import { authenticate, authorize } from "../middleware/clerk.middleware";

export const appointmentRoutes = Router();

const staffRoles = ["admin", "receptionist", "doctor", "nurse"] as const;

// Own-appointment routes are open to any signed-in user with a patient profile (staff can be patients too).
appointmentRoutes.post("/",            authenticate, createAppointment);
appointmentRoutes.get("/mine",         authenticate, getMyAppointments);
// "/all" MUST be declared before "/:id", otherwise "/:id" swallows it.
appointmentRoutes.get("/all",          authenticate, authorize(...staffRoles), getAllAppointments);
appointmentRoutes.get("/:id",          authenticate, getAppointmentById);      // access checked in the handler
appointmentRoutes.patch("/:id/cancel", authenticate, cancelAppointment);
appointmentRoutes.patch("/:id/status", authenticate, authorize(...staffRoles), updateAppointmentStatus);
