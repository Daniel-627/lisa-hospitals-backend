# Booking-only mode: setup

The clinical modules (patients, visits, triage, consultations, orders, admissions, billing, Paystack, offline sync) are
**switched off**. Tables and data are untouched. Only the booking system, doctors, departments, news, contact form and
admin tools run.

## 1. Database (Neon)
Run `npm run db:push`, or paste `4-booking-schema.sql` into the Neon SQL editor (safe to repeat). It adds:
`bookings`, `doctor_time_off`, `booking_settings`, `booking_otps`, and `doctor_availability.slot_minutes`.

## 2. Render (backend) environment
| Variable | Value |
|---|---|
| `CLINICAL_ENABLED` | leave unset (off). `true` brings the clinical modules back |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | Africa's Talking SMS. Without them: no SMS, no phone check, online bookings arrive as **pending** for reception to confirm |
| `BOOKING_PUBLIC_URL` | e.g. `https://www.lisahospitals.co.ke` (used in the SMS manage link; defaults to first `FRONTEND_URL`) |
| `OTP_PEPPER` | any long random string |

## 3. Vercel (web) environment
`NEXT_PUBLIC_CLINICAL_ENABLED` unset (off). Everything else as before.

## 4. First-time data
1. Admin → Users → open each doctor → **Weekly schedule**: add working hours and the appointment length (10–60 min).
2. Admin → **Booking settings**: notice period, how far ahead, cancel cut-off, bookings per phone.
3. Admin → Booking settings → **Time off** for leave and holidays.

## How it behaves
- A slot exists only inside a doctor's working hours, outside leave, not already held, and past the notice period.
- Two people can never hold the same doctor and time: enforced by the database, not just the code.
- "First available doctor" is assigned automatically.
- Patients cancel or change online up to the cut-off (default 4 h); they can move an appointment twice. Reception can always do both.
- Reception: confirm, move (any doctor in the department), cancel, mark attended/no-show, book for callers.
- Doctors see their own schedule: names and times only. Nurses and other roles have no access.
- Every staff action is in the audit log.
