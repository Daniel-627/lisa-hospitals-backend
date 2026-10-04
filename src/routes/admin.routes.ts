import { Router } from "express";
import { authenticate, authorize } from "../middleware/clerk.middleware";
import * as a from "../controllers/admin.controller";

export const adminRoutes = Router();

// Everything under /api/admin is admin-only.
adminRoutes.use(authenticate, authorize("admin"));

adminRoutes.get("/stats", a.getAdminStats);

adminRoutes.get("/users", a.listUsers);
adminRoutes.get("/users/:id", a.getUserDetail);
adminRoutes.patch("/users/:id", a.updateUser);
adminRoutes.post("/users/:id/staff-profile", a.createStaffProfile);
adminRoutes.patch("/users/:id/staff-profile", a.updateStaffProfile);
adminRoutes.post("/users/:id/doctor-profile", a.createDoctorProfile);

adminRoutes.patch("/doctors/:id", a.updateDoctor);
adminRoutes.put("/doctors/:id/availability", a.setDoctorAvailability);

adminRoutes.get("/enquiries", a.listEnquiries);
adminRoutes.patch("/enquiries/:id", a.setEnquiryRead);
adminRoutes.delete("/enquiries/:id", a.deleteEnquiry);

adminRoutes.get("/news", a.listAllNews);
adminRoutes.post("/news", a.createNews);
adminRoutes.get("/news/:id", a.getNewsAdmin);
adminRoutes.put("/news/:id", a.updateNews);
adminRoutes.delete("/news/:id", a.deleteNews);

adminRoutes.get("/audit", a.listAuditLogs);
