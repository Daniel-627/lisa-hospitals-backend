import express from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";

import { authRoutes } from "./routes/auth.routes";
import { departmentRoutes } from "./routes/department.routes";
import { doctorRoutes } from "./routes/doctor.routes";
import { appointmentRoutes } from "./routes/appointment.routes";
import { patientRoutes } from "./routes/patient.routes";
import { staffRoutes } from "./routes/staff.routes";
import { billingRoutes } from "./routes/billing.routes";
import { syncRoutes } from "./routes/sync.routes";
import { webhookRoutes } from "./routes/webhook.routes";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());
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
app.use("/api/webhooks",     webhookRoutes);
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`Lisa Hospitals API running on port ${PORT}`);
});

export default app;