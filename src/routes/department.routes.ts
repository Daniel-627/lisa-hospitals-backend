import { Router } from "express";
import { getAllDepartments, getDepartmentBySlug, getDepartmentDoctors } from "../controllers/department.controller.js";

export const departmentRoutes = Router();

departmentRoutes.get("/",              getAllDepartments);
departmentRoutes.get("/:slug",         getDepartmentBySlug);
departmentRoutes.get("/:slug/doctors", getDepartmentDoctors);