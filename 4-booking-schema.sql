-- Booking system tables. Safe to run more than once. (npm run db:push does the same thing; use this if you prefer SQL.)
DO $$ BEGIN CREATE TYPE booking_status AS ENUM ('pending','confirmed','completed','cancelled','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE doctor_availability ADD COLUMN IF NOT EXISTS slot_minutes integer NOT NULL DEFAULT 20;

CREATE TABLE IF NOT EXISTS doctor_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason varchar(200),
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_settings (
  id integer PRIMARY KEY DEFAULT 1,
  lead_minutes integer NOT NULL DEFAULT 60,
  horizon_days integer NOT NULL DEFAULT 60,
  cutoff_hours integer NOT NULL DEFAULT 4,
  max_active_per_phone integer NOT NULL DEFAULT 3,
  updated_at timestamp NOT NULL DEFAULT now()
);
INSERT INTO booking_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference varchar(12) NOT NULL UNIQUE,
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  slot_date date NOT NULL,
  slot_time time NOT NULL,
  duration_min integer NOT NULL DEFAULT 20,
  status booking_status NOT NULL DEFAULT 'pending',
  guest_name varchar(150) NOT NULL,
  guest_phone varchar(20) NOT NULL,
  guest_email varchar(255),
  phone_verified boolean NOT NULL DEFAULT false,
  reason varchar(300),
  source varchar(20) NOT NULL DEFAULT 'online',
  manage_token_hash varchar(64) NOT NULL,
  created_by uuid REFERENCES users(id),
  rescheduled_from_id uuid,
  reschedule_count integer NOT NULL DEFAULT 0,
  cancelled_at timestamp,
  cancelled_by varchar(20),
  cancel_reason varchar(200),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Reception workflow columns (added after the first release; safe to repeat)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS flag varchar(20);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS flag_reason varchar(300);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS flag_suggestion varchar(300);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reconfirmed_at timestamp;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at timestamp;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS call_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_call_at timestamp;

-- A doctor can never hold two live bookings in the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_live_slot_uq ON bookings (doctor_id, slot_date, slot_time) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings (slot_date);
CREATE INDEX IF NOT EXISTS bookings_phone_idx ON bookings (guest_phone);

CREATE TABLE IF NOT EXISTS booking_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(20) NOT NULL,
  code_hash varchar(64) NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  outcome varchar(20) NOT NULL,
  note varchar(300),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_calls_booking_idx ON booking_calls (booking_id);
CREATE INDEX IF NOT EXISTS bookings_flag_idx ON bookings (flag) WHERE flag IS NOT NULL;

-- ── Round 2: services, doctor calendar (part-day leave), walk-in holds, holidays, waiting list, language ──
ALTER TABLE doctor_availability ADD COLUMN IF NOT EXISTS walkin_slots integer NOT NULL DEFAULT 0;
ALTER TABLE doctor_time_off ADD COLUMN IF NOT EXISTS start_time time;
ALTER TABLE doctor_time_off ADD COLUMN IF NOT EXISTS end_time time;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_id uuid;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lang varchar(2) NOT NULL DEFAULT 'en';

CREATE TABLE IF NOT EXISTS booking_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id),
  name varchar(120) NOT NULL,
  name_sw varchar(120),
  duration_min integer NOT NULL DEFAULT 20,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking_service_doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_service_doctors_uq ON booking_service_doctors (service_id, doctor_id);

CREATE TABLE IF NOT EXISTS booking_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id),
  doctor_id uuid REFERENCES doctors(id),
  service_id uuid,
  from_date date NOT NULL,
  to_date date,
  guest_name varchar(150) NOT NULL,
  guest_phone varchar(20) NOT NULL,
  phone_verified boolean NOT NULL DEFAULT false,
  note varchar(200),
  lang varchar(2) NOT NULL DEFAULT 'en',
  status varchar(12) NOT NULL DEFAULT 'waiting',
  call_attempts integer NOT NULL DEFAULT 0,
  last_call_at timestamp,
  booking_id uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_waitlist_status_idx ON booking_waitlist (status);

-- Extra safety net (optional): the database itself refuses overlapping live bookings for one doctor,
-- even for visits longer than one slot. If your Neon plan can't create the extension, this just prints a notice.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
      doctor_id WITH =,
      tsrange(slot_date + slot_time, slot_date + slot_time + make_interval(mins => duration_min)) WITH &&
    ) WHERE (status IN ('pending','confirmed'));
  END IF;
EXCEPTION WHEN others THEN RAISE NOTICE 'Overlap constraint skipped: %', SQLERRM;
END $$;
