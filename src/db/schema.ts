import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  date,
  time,
  decimal,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── ENUMS ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", [
  "patient",
  "doctor",
  "nurse",
  "receptionist",
  "lab_technician",
  "radiographer",
  "pharmacist",
  "billing_officer",
  "admin",
]);

export const genderEnum = pgEnum("gender", ["male", "female", "other"]);

export const bloodGroupEnum = pgEnum("blood_group", [
  "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "mpesa",
  "sha",
  "maki",
  "aon",
  "mtiba",
  "pesapal",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "paid",
  "partial",
  "waived",
]);

export const documentTypeEnum = pgEnum("document_type", [
  "lab_result",
  "radiology_report",
  "prescription",
  "discharge_summary",
  "referral_letter",
  "medical_certificate",
  "vaccination_record",
  "antenatal_card",
  "invoice",
  "insurance_claim",
  "admission_letter",
]);

export const urgencyEnum = pgEnum("urgency_level", [
  "1_critical",
  "2_emergent",
  "3_urgent",
  "4_semi_urgent",
  "5_non_urgent",
]);

export const admissionStatusEnum = pgEnum("admission_status", [
  "admitted",
  "discharged",
  "transferred",
]);

export const departmentSlugEnum = pgEnum("department_slug", [
  "outpatient_inpatient",
  "accident_emergency",
  "specialist_clinics",
  "laboratory",
  "pharmacy",
  "radiology",
  "physiotherapy",
  "dental",
  "maternity",
  "eye_care",
  "mother_child_health",
  "critical_care_icu",
]);

export const syncActionEnum = pgEnum("sync_action", [
  "CREATE_APPOINTMENT",
  "CANCEL_APPOINTMENT",
  "UPDATE_TRIAGE",
  "CREATE_CONSULTATION",
  "CREATE_LAB_ORDER",
  "UPDATE_PATIENT_PROFILE",
  "CREATE_VISIT",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "pending",
  "synced",
  "failed",
  "conflict",
]);

// ── CORE TABLES ───────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:            uuid("id").primaryKey().defaultRandom(),
  email:         varchar("email", { length: 255 }).notNull().unique(),
  phone:         varchar("phone", { length: 20 }).notNull().unique(),
  passwordHash:  varchar("password_hash", { length: 255 }).notNull(),
  role:          userRoleEnum("role").notNull().default("patient"),
  firstName:     varchar("first_name", { length: 100 }).notNull(),
  lastName:      varchar("last_name", { length: 100 }).notNull(),
  isActive:      boolean("is_active").notNull().default(true),
  isVerified:    boolean("is_verified").notNull().default(false),
  refreshToken:  text("refresh_token"),
  clerkUserId:   varchar("clerk_user_id", { length: 100 }).unique(),
  tempPassword:  boolean("temp_password").notNull().default(false),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
  updatedAt:     timestamp("updated_at").notNull().defaultNow(),
});

export const departments = pgTable("departments", {
  id:          uuid("id").primaryKey().defaultRandom(),
  name:        varchar("name", { length: 100 }).notNull(),
  slug:        departmentSlugEnum("slug").notNull().unique(),
  description: text("description"),
  isOpen24hrs: boolean("is_open_24hrs").notNull().default(false),
  floor:       varchar("floor", { length: 50 }),
  phone:       varchar("phone", { length: 20 }),
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export const patients = pgTable("patients", {
  id:                uuid("id").primaryKey().defaultRandom(),
  userId:            uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  patientNumber:     varchar("patient_number", { length: 20 }).notNull().unique(),
  dateOfBirth:       date("date_of_birth").notNull(),
  gender:            genderEnum("gender").notNull(),
  bloodGroup:        bloodGroupEnum("blood_group"),
  nationalId:        varchar("national_id", { length: 20 }).unique(),
  address:           text("address"),
  nextOfKinName:     varchar("next_of_kin_name", { length: 200 }),
  nextOfKinPhone:    varchar("next_of_kin_phone", { length: 20 }),
  nextOfKinRelation: varchar("next_of_kin_relation", { length: 50 }),
  insuranceScheme:   paymentMethodEnum("insurance_scheme"),
  insuranceNumber:   varchar("insurance_number", { length: 100 }),
  allergies:         text("allergies"),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
});

export const staff = pgTable("staff", {
  id:               uuid("id").primaryKey().defaultRandom(),
  userId:           uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  departmentId:     uuid("department_id").references(() => departments.id),
  staffNumber:      varchar("staff_number", { length: 20 }).notNull().unique(),
  qualification:    varchar("qualification", { length: 200 }),
  employedAt:       date("employed_at").notNull(),
  isOnDuty:         boolean("is_on_duty").notNull().default(false),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
});

export const doctors = pgTable("doctors", {
  id:                uuid("id").primaryKey().defaultRandom(),
  staffId:           uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
  departmentId:      uuid("department_id").notNull().references(() => departments.id),
  speciality:        varchar("speciality", { length: 200 }).notNull(),
  bio:               text("bio"),
  photoUrl:          varchar("photo_url", { length: 500 }),
  consultationFee:   decimal("consultation_fee", { precision: 10, scale: 2 }),
  isAvailable:       boolean("is_available").notNull().default(true),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
});

export const doctorAvailability = pgTable("doctor_availability", {
  id:          uuid("id").primaryKey().defaultRandom(),
  doctorId:    uuid("doctor_id").notNull().references(() => doctors.id, { onDelete: "cascade" }),
  dayOfWeek:   integer("day_of_week").notNull(), // 0=Sun, 1=Mon ... 6=Sat
  startTime:   time("start_time").notNull(),
  endTime:     time("end_time").notNull(),
  maxSlots:    integer("max_slots").notNull().default(20),
  isActive:    boolean("is_active").notNull().default(true),
});

// ── CLINICAL TABLES ───────────────────────────────────────────────────────────

export const appointments = pgTable("appointments", {
  id:            uuid("id").primaryKey().defaultRandom(),
  patientId:     uuid("patient_id").notNull().references(() => patients.id),
  doctorId:      uuid("doctor_id").references(() => doctors.id),
  departmentId:  uuid("department_id").notNull().references(() => departments.id),
  appointmentDate: date("appointment_date").notNull(),
  appointmentTime: time("appointment_time").notNull(),
  status:        appointmentStatusEnum("status").notNull().default("pending"),
  reason:        text("reason"),
  notes:         text("notes"),
  bookedOnline:  boolean("booked_online").notNull().default(false),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
  updatedAt:     timestamp("updated_at").notNull().defaultNow(),
});

export const visits = pgTable("visits", {
  id:            uuid("id").primaryKey().defaultRandom(),
  patientId:     uuid("patient_id").notNull().references(() => patients.id),
  appointmentId: uuid("appointment_id").references(() => appointments.id),
  departmentId:  uuid("department_id").notNull().references(() => departments.id),
  arrivedAt:     timestamp("arrived_at").notNull().defaultNow(),
  departedAt:    timestamp("departed_at"),
  visitNumber:   varchar("visit_number", { length: 20 }).notNull().unique(),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
});

export const triageRecords = pgTable("triage_records", {
  id:              uuid("id").primaryKey().defaultRandom(),
  visitId:         uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
  nurseId:         uuid("nurse_id").references(() => staff.id),
  temperature:     decimal("temperature", { precision: 4, scale: 1 }),
  bloodPressure:   varchar("blood_pressure", { length: 20 }),
  pulseRate:       integer("pulse_rate"),
  weight:          decimal("weight", { precision: 5, scale: 2 }),
  height:          decimal("height", { precision: 5, scale: 2 }),
  oxygenSaturation:decimal("oxygen_saturation", { precision: 4, scale: 1 }),
  urgencyLevel:    urgencyEnum("urgency_level").notNull().default("5_non_urgent"),
  chiefComplaint:  text("chief_complaint"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

export const consultations = pgTable("consultations", {
  id:             uuid("id").primaryKey().defaultRandom(),
  visitId:        uuid("visit_id").notNull().references(() => visits.id),
  doctorId:       uuid("doctor_id").notNull().references(() => doctors.id),
  patientId:      uuid("patient_id").notNull().references(() => patients.id),
  diagnosis:      text("diagnosis"),
  icdCode:        varchar("icd_code", { length: 20 }),
  clinicalNotes:  text("clinical_notes"),
  treatmentPlan:  text("treatment_plan"),
  followUpDate:   date("follow_up_date"),
  referredTo:     uuid("referred_to").references(() => departments.id),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
});

export const prescriptions = pgTable("prescriptions", {
  id:             uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  patientId:      uuid("patient_id").notNull().references(() => patients.id),
  drugName:       varchar("drug_name", { length: 200 }).notNull(),
  dosage:         varchar("dosage", { length: 100 }).notNull(),
  frequency:      varchar("frequency", { length: 100 }).notNull(),
  duration:       varchar("duration", { length: 100 }).notNull(),
  instructions:   text("instructions"),
  isDispensed:    boolean("is_dispensed").notNull().default(false),
  dispensedAt:    timestamp("dispensed_at"),
  dispensedBy:    uuid("dispensed_by").references(() => staff.id),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const labOrders = pgTable("lab_orders", {
  id:             uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  patientId:      uuid("patient_id").notNull().references(() => patients.id),
  orderedBy:      uuid("ordered_by").notNull().references(() => doctors.id),
  testName:       varchar("test_name", { length: 200 }).notNull(),
  testCode:       varchar("test_code", { length: 50 }),
  urgency:        urgencyEnum("urgency").notNull().default("5_non_urgent"),
  instructions:   text("instructions"),
  status:         varchar("status", { length: 50 }).notNull().default("pending"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const labResults = pgTable("lab_results", {
  id:           uuid("id").primaryKey().defaultRandom(),
  labOrderId:   uuid("lab_order_id").notNull().references(() => labOrders.id),
  patientId:    uuid("patient_id").notNull().references(() => patients.id),
  processedBy:  uuid("processed_by").references(() => staff.id),
  result:       text("result"),
  unit:         varchar("unit", { length: 50 }),
  referenceRange: varchar("reference_range", { length: 100 }),
  isAbnormal:   boolean("is_abnormal").notNull().default(false),
  fileUrl:      varchar("file_url", { length: 500 }),
  notes:        text("notes"),
  processedAt:  timestamp("processed_at").notNull().defaultNow(),
});

export const radiologyOrders = pgTable("radiology_orders", {
  id:             uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  patientId:      uuid("patient_id").notNull().references(() => patients.id),
  orderedBy:      uuid("ordered_by").notNull().references(() => doctors.id),
  modality:       varchar("modality", { length: 100 }).notNull(), // X-Ray, Ultrasound, CT
  bodyPart:       varchar("body_part", { length: 100 }),
  clinicalInfo:   text("clinical_info"),
  status:         varchar("status", { length: 50 }).notNull().default("pending"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
});

export const radiologyResults = pgTable("radiology_results", {
  id:               uuid("id").primaryKey().defaultRandom(),
  radiologyOrderId: uuid("radiology_order_id").notNull().references(() => radiologyOrders.id),
  patientId:        uuid("patient_id").notNull().references(() => patients.id),
  processedBy:      uuid("processed_by").references(() => staff.id),
  findings:         text("findings"),
  impression:       text("impression"),
  imageUrl:         varchar("image_url", { length: 500 }),
  reportUrl:        varchar("report_url", { length: 500 }),
  processedAt:      timestamp("processed_at").notNull().defaultNow(),
});

export const admissions = pgTable("admissions", {
  id:              uuid("id").primaryKey().defaultRandom(),
  patientId:       uuid("patient_id").notNull().references(() => patients.id),
  visitId:         uuid("visit_id").notNull().references(() => visits.id),
  departmentId:    uuid("department_id").notNull().references(() => departments.id),
  admittedBy:      uuid("admitted_by").notNull().references(() => doctors.id),
  ward:            varchar("ward", { length: 100 }),
  bedNumber:       varchar("bed_number", { length: 20 }),
  admissionStatus: admissionStatusEnum("admission_status").notNull().default("admitted"),
  admittedAt:      timestamp("admitted_at").notNull().defaultNow(),
  dischargedAt:    timestamp("discharged_at"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

export const dischargeSummaries = pgTable("discharge_summaries", {
  id:                uuid("id").primaryKey().defaultRandom(),
  admissionId:       uuid("admission_id").notNull().references(() => admissions.id),
  patientId:         uuid("patient_id").notNull().references(() => patients.id),
  dischargedBy:      uuid("discharged_by").notNull().references(() => doctors.id),
  finalDiagnosis:    text("final_diagnosis"),
  treatmentGiven:    text("treatment_given"),
  conditionOnDischarge: varchar("condition_on_discharge", { length: 100 }),
  followUpInstructions: text("follow_up_instructions"),
  followUpDate:      date("follow_up_date"),
  fileUrl:           varchar("file_url", { length: 500 }),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
});

// ── ADMIN & BILLING TABLES ────────────────────────────────────────────────────

export const invoices = pgTable("invoices", {
  id:             uuid("id").primaryKey().defaultRandom(),
  patientId:      uuid("patient_id").notNull().references(() => patients.id),
  visitId:        uuid("visit_id").references(() => visits.id),
  invoiceNumber:  varchar("invoice_number", { length: 20 }).notNull().unique(),
  totalAmount:    decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  paidAmount:     decimal("paid_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  paymentStatus:  paymentStatusEnum("payment_status").notNull().default("pending"),
  paymentMethod:  paymentMethodEnum("payment_method"),
  generatedBy:    uuid("generated_by").references(() => staff.id),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
});

export const invoiceItems = pgTable("invoice_items", {
  id:          uuid("id").primaryKey().defaultRandom(),
  invoiceId:   uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  description: varchar("description", { length: 300 }).notNull(),
  quantity:    integer("quantity").notNull().default(1),
  unitPrice:   decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalPrice:  decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export const payments = pgTable("payments", {
  id:              uuid("id").primaryKey().defaultRandom(),
  invoiceId:       uuid("invoice_id").notNull().references(() => invoices.id),
  patientId:       uuid("patient_id").notNull().references(() => patients.id),
  amount:          decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod:   paymentMethodEnum("payment_method").notNull(),
  referenceNumber: varchar("reference_number", { length: 100 }),
  receivedBy:      uuid("received_by").references(() => staff.id),
  notes:           text("notes"),
  paidAt:          timestamp("paid_at").notNull().defaultNow(),
});

export const insuranceClaims = pgTable("insurance_claims", {
  id:            uuid("id").primaryKey().defaultRandom(),
  invoiceId:     uuid("invoice_id").notNull().references(() => invoices.id),
  patientId:     uuid("patient_id").notNull().references(() => patients.id),
  scheme:        paymentMethodEnum("scheme").notNull(),
  claimNumber:   varchar("claim_number", { length: 100 }),
  claimAmount:   decimal("claim_amount", { precision: 10, scale: 2 }).notNull(),
  approvedAmount:decimal("approved_amount", { precision: 10, scale: 2 }),
  status:        varchar("status", { length: 50 }).notNull().default("submitted"),
  submittedAt:   timestamp("submitted_at").notNull().defaultNow(),
  resolvedAt:    timestamp("resolved_at"),
  notes:         text("notes"),
});

export const documents = pgTable("documents", {
  id:           uuid("id").primaryKey().defaultRandom(),
  patientId:    uuid("patient_id").notNull().references(() => patients.id),
  uploadedBy:   uuid("uploaded_by").references(() => staff.id),
  documentType: documentTypeEnum("document_type").notNull(),
  title:        varchar("title", { length: 200 }).notNull(),
  fileUrl:      varchar("file_url", { length: 500 }).notNull(),
  fileSize:     integer("file_size"),
  mimeType:     varchar("mime_type", { length: 100 }),
  isVisible:    boolean("is_visible").notNull().default(true),
  relatedId:    uuid("related_id"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
});

export const newsPosts = pgTable("news_posts", {
  id:          uuid("id").primaryKey().defaultRandom(),
  authorId:    uuid("author_id").references(() => staff.id),
  title:       varchar("title", { length: 300 }).notNull(),
  slug:        varchar("slug", { length: 300 }).notNull().unique(),
  excerpt:     text("excerpt"),
  body:        text("body").notNull(),
  coverImage:  varchar("cover_image", { length: 500 }),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id:         uuid("id").primaryKey().defaultRandom(),
  userId:     uuid("user_id").references(() => users.id),
  action:     varchar("action", { length: 100 }).notNull(),
  table:      varchar("table", { length: 100 }).notNull(),
  recordId:   uuid("record_id"),
  oldValues:  text("old_values"),
  newValues:  text("new_values"),
  ipAddress:  varchar("ip_address", { length: 45 }),
  userAgent:  text("user_agent"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
});

// ── RELATIONS ─────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one }) => ({
  patient: one(patients, { fields: [users.id], references: [patients.userId] }),
  staff:   one(staff,    { fields: [users.id], references: [staff.userId] }),
}));

export const patientsRelations = relations(patients, ({ one, many }) => ({
  user:          one(users,        { fields: [patients.userId],   references: [users.id] }),
  appointments:  many(appointments),
  visits:        many(visits),
  documents:     many(documents),
  invoices:      many(invoices),
  consultations: many(consultations),
}));

export const staffRelations = relations(staff, ({ one, many }) => ({
  user:       one(users,       { fields: [staff.userId],       references: [users.id] }),
  department: one(departments, { fields: [staff.departmentId], references: [departments.id] }),
  doctor:     one(doctors,     { fields: [staff.id],           references: [doctors.staffId] }),
}));

export const doctorsRelations = relations(doctors, ({ one, many }) => ({
  staff:         one(staff,       { fields: [doctors.staffId],       references: [staff.id] }),
  department:    one(departments, { fields: [doctors.departmentId],  references: [departments.id] }),
  appointments:  many(appointments),
  consultations: many(consultations),
  availability:  many(doctorAvailability),
}));

export const departmentsRelations = relations(departments, ({ many }) => ({
  doctors:      many(doctors),
  staff:        many(staff),
  appointments: many(appointments),
  visits:       many(visits),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  patient:    one(patients,    { fields: [appointments.patientId],    references: [patients.id] }),
  doctor:     one(doctors,     { fields: [appointments.doctorId],     references: [doctors.id] }),
  department: one(departments, { fields: [appointments.departmentId], references: [departments.id] }),
}));

export const visitsRelations = relations(visits, ({ one, many }) => ({
  patient:     one(patients,     { fields: [visits.patientId],     references: [patients.id] }),
  appointment: one(appointments, { fields: [visits.appointmentId], references: [appointments.id] }),
  department:  one(departments,  { fields: [visits.departmentId],  references: [departments.id] }),
  triage:      one(triageRecords),
  consultations: many(consultations),
  admissions:  many(admissions),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  patient:  one(patients, { fields: [invoices.patientId], references: [patients.id] }),
  visit:    one(visits,   { fields: [invoices.visitId],   references: [visits.id] }),
  items:    many(invoiceItems),
  payments: many(payments),
}));



export const syncQueue = pgTable("sync_queue", {
  id:          uuid("id").primaryKey().defaultRandom(),
  userId:      uuid("user_id").notNull().references(() => users.id),
  deviceId:    varchar("device_id", { length: 100 }).notNull(),
  action:      syncActionEnum("action").notNull(),
  payload:     text("payload").notNull(),
  status:      syncStatusEnum("status").notNull().default("pending"),
  errorMessage:varchar("error_message", { length: 500 }),
  createdOfflineAt: timestamp("created_offline_at").notNull(),
  syncedAt:    timestamp("synced_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});