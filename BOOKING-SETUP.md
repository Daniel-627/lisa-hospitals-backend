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

## Newest additions (run `4-booking-schema.sql` again: it now contains everything)
- **Doctor's own calendar** (My calendar in the staff menu): the doctor sets weekly hours for all 7 days, optionally holds the last slots of a block for walk-ins, and clicks any day to block the whole day, a leave period, or just some hours. Blocked time disappears from online booking at once; existing bookings inside it turn red for reception to rearrange. Nothing is bookable until the doctor saves hours.
- **Services** (Admin → Services): types of visit with their own length and doctors. Departments with no services book by doctor as before.
- **Closed days** (Admin → Booking settings): close the whole hospital's online booking for holidays. Existing bookings that day are flagged.
- **Walk-in hold**: the last N slots of a block are kept for reception only (set on the doctor's calendar or on the doctor's admin page).
- **Waiting list**: patients leave their number when no time suits; reception sees who can be offered a time that has opened.
- **Print day list** button on Bookings; **Export CSV** under Admin → Booking settings.
- **Kiswahili** toggle on the public booking pages; SMS go out in the language the patient used.

## Update note
If you already ran `4-booking-schema.sql` once, run the new version again (safe to repeat). It adds the reception-workflow columns and the `booking_calls` table.

## Reception workflow (the "To do" panel on the Bookings page)
- **Call now (red):** a doctor asked to change a booking, a doctor is on leave, the phone wasn't verified, or the number has 2+ earlier no-shows. Reception calls, then moves or cancels it (or taps "Doctor can attend").
- **Tomorrow's confirmation calls:** every booking for tomorrow nobody has spoken to. "Spoke: coming" removes it; "No answer" keeps it and counts the attempt.
- **Today: not yet confirmed:** the same people again on the morning of the appointment.
- **Check in:** reception taps Check in when the patient arrives (today only). That is "attended". Checked-in patients can't be marked no-show.
- **Awaiting outcome:** start time plus 30 minutes passed and never checked in. Reception marks No-show, which sends the "we missed you" text with a rebook link.
- **Doctors** get "I can't keep this one" on each booking and "I can't work this day". The reason is internal; the patient only hears that reception will call.
- **Repeat no-shows:** 2 or more in 6 months means new bookings from that number are held as pending until reception calls. Nobody is blocked.
- No reminder SMS is sent; reception phones instead. Number links dial on phones; on a PC they use Phone Link or similar, and there is a Copy button.
- Admin → Booking settings shows attendance and miss rate per doctor for the last 90 days.

## How it behaves
- A slot exists only inside a doctor's working hours, outside leave, not already held, and past the notice period.
- Two people can never hold the same doctor and time: enforced by the database, not just the code.
- "First available doctor" is assigned automatically.
- Patients cancel or change online up to the cut-off (default 4 h); they can move an appointment twice. Reception can always do both.
- Reception: confirm, move (any doctor in the department), cancel, mark attended/no-show, book for callers.
- Doctors see their own schedule: names and times only. Nurses and other roles have no access.
- Every staff action is in the audit log.
