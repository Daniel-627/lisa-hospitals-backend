import { z } from "zod";

// ── Time (Kenya is UTC+3 all year, no DST) ───────────────────────────────────
export const eatNowIso = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString();
export const todayEAT = () => eatNowIso().slice(0, 10);
export const nowSlotEAT = () => eatNowIso().replace("T", " ").slice(0, 16); // "YYYY-MM-DD HH:MM"

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// ── Primitives ───────────────────────────────────────────────────────────────
export const uuid = z.string().uuid();
export const isUuid = (v: unknown): v is string => uuid.safeParse(v).success;

export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine(isRealDate, "Invalid date");

export const timeStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24h)");

// ── Phone (Kenya) ────────────────────────────────────────────────────────────
/** Accepts 0712345678, 712345678, +254712345678, 254 712 345 678. Returns +254XXXXXXXXX or null. */
export const normalizeKenyanPhone = (raw: string): string | null => {
  const digits = raw.replace(/[\s\-()]/g, "").replace(/^\+?254/, "").replace(/^0/, "");
  return /^[17]\d{8}$/.test(digits) ? `+254${digits}` : null;
};

// ── Patient profile (shared by patient controller + sync) ────────────────────
export const patientProfileUpdateSchema = z
  .object({
    dateOfBirth: dateStr.refine((d) => d <= todayEAT(), "Date of birth cannot be in the future").optional(),
    gender: z.enum(["male", "female", "other"]).optional(),
    bloodGroup: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).optional(),
    nationalId: z.string().min(5).max(20).optional(),
    address: z.string().max(500).optional(),
    nextOfKinName: z.string().max(200).optional(),
    nextOfKinPhone: z.string().max(20).optional(),
    nextOfKinRelation: z.string().max(50).optional(),
    insuranceScheme: z.enum(["cash", "mpesa", "sha", "maki", "aon", "mtiba", "pesapal"]).optional(),
    insuranceNumber: z.string().max(100).optional(),
    allergies: z.string().max(2000).optional(),
  })
  .strict();
