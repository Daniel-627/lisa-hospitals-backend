import { Response } from "express";
import { sendError } from "./response";

/** Error whose message is safe to show to the client. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const isUniqueViolation = (err: any) =>
  err?.code === "23505" || err?.cause?.code === "23505";

/** Central catch-block helper: safe messages for HttpError, generic 500 otherwise. */
export const handleError = (res: Response, err: unknown, label: string) => {
  if (err instanceof HttpError) return sendError(res, err.message, err.status);
  if (isUniqueViolation(err)) return sendError(res, "A record with these details already exists", 409);
  console.error(`${label} error:`, err);
  return sendError(res, "Something went wrong", 500);
};
