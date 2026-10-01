import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";

import { authRoutes }       from "./routes/auth.routes";
import { departmentRoutes } from "./routes/department.routes";
import { doctorRoutes }     from "./routes/doctor.routes";
import { appointmentRoutes }from "./routes/appointment.routes";
import { patientRoutes }    from "./routes/patient.routes";
import { staffRoutes }      from "./routes/staff.routes";
import { billingRoutes }    from "./routes/billing.routes";
import { syncRoutes }       from "./routes/sync.routes";
import { webhookRoutes }    from "./routes/webhook.routes";

const app = express();
const PORT = process.env.PORT || 8080;

// Render sits behind a proxy: needed for correct client IPs (logging / future rate limiting).
app.set("trust proxy", 1);

app.use(helmet());

// FRONTEND_URL may hold several origins, comma-separated (no trailing slashes needed):
//   FRONTEND_URL=https://lisahospitals.vercel.app,https://www.lisahospitals.co.ke
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  credentials: true,
}));

// ── WEBHOOK MUST BE BEFORE express.json() ─────────────────────────────────────
// Clerk endpoint URL: https://<render-url>/api/webhook/clerk
app.use("/api/webhook", express.raw({ type: "application/json" }), webhookRoutes);

// ── REGULAR MIDDLEWARE ────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", hospital: "Lisa Hospitals API", version: "1.0.0" });
});

app.use("/api/auth",         authRoutes);
app.use("/api/departments",  departmentRoutes);
app.use("/api/doctors",      doctorRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/patients",     patientRoutes);
app.use("/api/staff",        staffRoutes);
app.use("/api/billing",      billingRoutes);
app.use("/api/sync",         syncRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// JSON errors instead of Express's default HTML stack trace (bad JSON, oversized body, anything unhandled).
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ success: false, error: "Invalid JSON" });
  if (err?.type === "entity.too.large")   return res.status(413).json({ success: false, error: "Request too large" });
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Something went wrong" });
});

process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

app.listen(PORT, () => {
  console.log(`Lisa Hospitals API running on port ${PORT}`);
});

export default app;
