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
