import { Router } from "express";
import { register, login, refresh, logout, me } from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

export const authRoutes = Router();

authRoutes.post("/register", register);
authRoutes.post("/login",    login);
authRoutes.post("/refresh",  refresh);
authRoutes.post("/logout",   logout);
authRoutes.get("/me",        authenticate, me);