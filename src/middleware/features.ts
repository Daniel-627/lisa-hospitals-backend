import { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/response";

/**
 * The clinical modules (patient records, visits, triage, consultations, orders, admissions, billing, offline sync)
 * are switched OFF unless CLINICAL_ENABLED=true. The hospital runs its own clinical system for now; this API is
 * booking-only until the full system is ready for DHA certification. Data and tables are untouched.
 */
export const clinicalEnabled = () => process.env.CLINICAL_ENABLED === "true";

export const clinicalOnly = (_req: Request, res: Response, next: NextFunction) => {
  if (clinicalEnabled()) return next();
  return sendError(res, "This feature is not enabled", 404);
};
