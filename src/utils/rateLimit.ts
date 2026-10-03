import { NextFunction, Request, Response } from "express";
import { sendError } from "./response";

/**
 * Tiny in-memory limiter (per IP). Fine for a single Render instance; swap for Redis if you ever scale out.
 * Requires app.set("trust proxy", 1) so req.ip is the real visitor, not Render's proxy.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    hits.forEach((b, k) => { if (b.resetAt <= now) hits.delete(k); });
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return sendError(res, "Too many requests. Please try again later.", 429);
    }
    bucket.count++;
    next();
  };
}
