import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { sendError } from "../utils/response";

export type UserRole =
  | "patient" | "doctor" | "nurse" | "receptionist"
  | "lab_technician" | "radiographer" | "pharmacist"
  | "billing_officer" | "admin";

export type AuthRequest = Request & {
  user?: { id: string; role: UserRole; email: string };
};

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) { sendError(res, "No token provided", 401); return; }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string; role: UserRole; email: string;
    };
    req.user = decoded;
    next();
  } catch {
    sendError(res, "Invalid or expired token", 401);
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      sendError(res, "Access denied", 403);
      return;
    }
    next();
  };
};