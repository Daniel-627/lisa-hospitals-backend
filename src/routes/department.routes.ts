import { Router } from "express";
import { getAllDepartments, getDepartmentBySlug, getDepartmentDoctors } from "../controllers/department.controller";

export const departmentRoutes = Router();

// Public — no auth needed
departmentRoutes.get("/",              getAllDepartments);
departmentRoutes.get("/:slug",         getDepartmentBySlug);
departmentRoutes.get("/:slug/doctors", getDepartmentDoctors);