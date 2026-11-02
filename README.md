# Lisa Hospitals: API (backend)

REST + WebSocket API for **Lisa Hospitals, Kisumu**. It powers the public website, online appointment booking, the reception desk, the doctors' calendars, patient/front-desk chat and the admin tools.

> **Mode: booking-only.** The hospital runs its own clinical system, so the clinical modules in this codebase (patient records, triage, consultations, orders, admissions, billing, Paystack, offline sync) are **switched off** and answer `404`. Their tables and code are untouched. Set `CLINICAL_ENABLED=true` to bring them back.

Companion repo: `lisa-hospitals-web` (Next.js). See its README for the front end.

---

## Contents
1. [What it does](#1-what-it-does)
2. [Tech stack](#2-tech-stack)
3. [Project layout](#3-project-layout)
4. [Quick start](#4-quick-start-local)
5. [Environment variables](#5-environment-variables)
6. [Database](#6-database)
7. [Deploying to Render](#7-deploying-to-render)
8. [How booking works](#8-how-booking-works)
9. [Reception workflow](#9-reception-workflow)
10. [Chat (Lisa)](#10-chat-lisa)
11. [Roles and access](#11-roles-and-access)
12. [API reference](#12-api-reference)
13. [Security notes](#13-security-notes)
14. [Test data](#14-test-data)
15. [Operations and troubleshooting](#15-operations-and-troubleshooting)
16. [Known limits](#16-known-limits)

---

## 1. What it does
- **Public booking, no sign-up.** Pick a department, a service (optional) and a doctor (or "first available"), choose a real free time, confirm with an SMS code. Cancel or reschedule with a private link or reference + phone.
- **Real availability.** Slots come from each doctor's weekly hours (all 7 days), minus leave and part-day blocks, minus hospital closed days, minus anything already booked, minus a walk-in hold, minus a notice period. Two people can never hold the same doctor and time (enforced by the database).
- **Reception desk.** To-do list of bookings that need a phone call, confirmation calls for tomorrow and today, check-in, no-show handling, moving and creating bookings, waiting list, printable day list, CSV export.
- **Doctor calendar.** Doctors set their own weekly hours, block whole days or only some hours, and ask reception to change a booking. Reception executes. Doctors see names and times only.
- **Services and closed days.** Admin defines visit types (with their own length and doctors) and hospital-wide closed days.
- **Chat.** Signed-in patients chat with "Lisa" (the front desk). Live over WebSocket, typing, seen receipts, online status, photo/PDF attachments. Staff see which colleague replied; patients never do.
- **Patient visit log.** Signed-in patients see upcoming bookings and history.
- **Admin.** Users and roles, doctor profiles, news, contact enquiries, audit log, attendance report.
- **Kiswahili.** Booking texts go out in the language the patient used.

## 2. Tech stack
| Area | Choice |
|---|---|
| Runtime | Node 20+, TypeScript, Express 4 |
| Database | PostgreSQL on **Neon**, via **Drizzle ORM** |
| Auth | **Clerk** (session tokens verified server-side; roles live in our `users` table) |
| Realtime | **Socket.IO** (WebSocket, falls back to polling) |
| SMS | **Africa's Talking** (optional) |
| Files | **Cloudinary** (private "authenticated" uploads for chat; public for doctor photos and news) |
| Hosting | **Render** (web service) |

## 3. Project layout
```
src/
  index.ts                 App + HTTP server, route mounting, Socket.IO start-up
  realtime.ts              Socket.IO server: auth, rooms, typing, presence, publish helpers
  db/
    schema.ts              Every table (Drizzle)
    client.ts, index.ts
  routes/                  One file per area (booking, chat, admin, upload, ...)
  controllers/             Request handling + validation (zod)
  services/
    booking.service.ts     Slot engine, bookings, calls, time off, services, waitlist, reports
    chat.service.ts        Threads, messages, attachments, inbox, visit log
  middleware/
    clerk.middleware.ts    authenticate / authorize / token verification
    features.ts            clinicalOnly gate
  utils/                   sms, cloudinary, rateLimit, validation, audit, errors, response
4-booking-schema.sql       All booking + chat tables, idempotent (safe to run repeatedly)
5-seed-booking-test-data.sql / 6-remove-booking-test-data.sql   Test data and cleanup
BOOKING-SETUP.md, BOOKING-TEST-PLAN.md, CLOUDINARY-SETUP.md
```

## 4. Quick start (local)
```bash
npm install
# create .env from section 5 (there is no .env.example yet)
npm run db:push           # or paste 4-booking-schema.sql into the Neon SQL editor
npm run dev               # http://localhost:8080  (health: /health)
```
Scripts: `dev` (ts-node-dev), `build` (tsc to `dist/`), `start` (`node dist/index.js`), `db:push`, `db:generate`, `db:studio`.

Without SMS keys everything still works: no OTP is sent, online bookings arrive **pending** with an "unverified" flag and reception phones the patient. In development the SMS text is printed to the console.

## 5. Environment variables
| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string |
| `CLERK_SECRET_KEY` | yes | Verify Clerk session tokens |
| `CLERK_WEBHOOK_SECRET` | yes | Verify the Clerk webhook (`POST /api/webhook/clerk`) |
| `CLERK_AUTHORIZED_PARTIES` | recommended | Comma-separated site origins allowed to present tokens |
| `FRONTEND_URL` | yes | Comma-separated site origins, **no trailing slash**. Used for CORS **and** for Socket.IO |
| `PORT` | no | Defaults to 8080 (Render sets it) |
| `OTP_PEPPER` | yes (booking) | Long random string used when hashing OTP codes. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it secret and don't change it casually |
| `BOOKING_PUBLIC_URL` | recommended | Public site URL used in SMS "manage" links (defaults to the first `FRONTEND_URL`) |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | optional | Africa's Talking. `AT_USERNAME=sandbox` for the sandbox. Sender id is optional |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for uploads | Doctor photos, news covers, chat attachments. See `CLOUDINARY-SETUP.md` |
| `CLINICAL_ENABLED` | no | Leave unset. `true` turns the clinical modules back on |
| `PAYSTACK_*`, `R2_*` | clinical mode only | Online payments and private file storage for the clinical modules |

Never commit real values. Keep `OTP_PEPPER`, API keys and the Clerk secrets only in Render's environment.

## 6. Database
- Run `4-booking-schema.sql` in the Neon SQL editor, **or** `npm run db:push`. The SQL file is the single source for the booking and chat tables and is **idempotent**: it can be run on every deploy.
- Tables added for booking: `bookings`, `booking_calls`, `booking_otps`, `booking_settings`, `booking_services`, `booking_service_doctors`, `booking_holidays`, `booking_waitlist`, `doctor_time_off`; plus `doctor_availability.slot_minutes` and `.walkin_slots`.
- Tables added for chat: `chat_threads` (one per patient), `chat_messages` (with attachment columns).
- **Hard guarantee:** a partial unique index `bookings_live_slot_uq (doctor_id, slot_date, slot_time) WHERE status IN ('pending','confirmed')`, and (where the Neon plan allows `btree_gist`) an exclusion constraint that also blocks overlapping longer visits. Bookings also take a short advisory lock per department and day.
- All times are **Kenya time (UTC+3)**. Dates are plain `date`/`time` values, not timestamps in UTC.

## 7. Deploying to Render
1. New **Web Service** from the repo. Build: `npm install && npm run build`. Start: `npm start`.
2. Add the environment variables from section 5.
3. Clerk dashboard → Webhooks → endpoint `https://<your-render-url>/api/webhook/clerk` (events: user created/updated/deleted) → copy the signing secret into `CLERK_WEBHOOK_SECRET`.
4. Run `4-booking-schema.sql` on Neon **before** the first deploy of a new version.
5. WebSockets need no extra Render setting.
6. Health check path: `/health`.

## 8. How booking works
**A slot is offered only if all of these are true:** it falls inside a doctor's weekly hours, on the slot grid (`slot_minutes`), the service length fits before the block ends, the doctor isn't on leave or blocked at that time, the hospital isn't closed that day, nobody holds an overlapping live booking, it isn't one of the last N walk-in slots (hidden online, visible to staff), and it is later than the notice period (default 60 min) and within the horizon (default 60 days).

**Statuses:** `pending` → `confirmed` → `completed`, or `cancelled` / `no_show`. A verified phone (OTP) means `confirmed` straight away. An unverified phone, or a number with 2+ no-shows in 6 months, becomes `pending` with a flag. Nobody is ever blocked.

**Guest access:** a booking is reached with its reference (`LH-XXXXXX`) plus either the private manage-link token or the phone used to book. Manage endpoints are tightly rate limited.

**Limits (editable in Admin → Booking settings):** notice period, horizon, cancel cut-off (default 4 h), live bookings per phone (default 3). Patients can move a booking twice. Reception can always cancel and move.

**Calendar controls:** weekly template per doctor, whole-day or part-day blocks (by the doctor or admin), hospital closed days, services with their own durations, walk-in holds.

## 9. Reception workflow
The Bookings page opens with a **To-do** panel:
- **Call now (red):** doctor asked for a change, doctor away, unverified phone, repeat no-show.
- **Tomorrow's confirmation calls:** everyone nobody has spoken to. "Spoke: coming" clears it, "No answer" counts the attempt.
- **Today: not yet confirmed:** the second call on the morning of the visit.
- **Check in:** pressed by reception when the patient arrives. That is "attended".
- **Awaiting outcome:** 30 minutes past the start and never checked in. Mark **No-show**, which sends a "we missed you" text with a rebook link.
- No reminder SMS is sent by design. Reception phones instead.
- Admin → Booking settings shows attendance and miss rate per doctor for the last 90 days.

## 10. Chat (Lisa)
- **Patients** (role `patient`) have one conversation. They see only "Lisa". The API for patients never returns staff identities.
- **Front desk** (`receptionist`, `admin`) share one inbox. Each message is labelled with the colleague's name and role. They can start a chat with any patient who has an account and use quick replies.
- **Realtime:** Socket.IO. Rooms: `user:<id>` and `staff`. Events: `message`, `read`, `typing`, `presence`, `presence:list`, `lisa:online`, `unread`. Sending and loading stay on REST (single validated code path); the socket only pushes. Pages poll when the socket is down.
- **Auth:** the socket handshake presents a fresh Clerk token on every (re)connect. Doctors and other roles are refused.
- **Attachments:** images and PDFs up to 8 MB, uploaded straight from the browser to Cloudinary with a server signature as **private** files, accepted only from the `lisa/private/chat/` folder of our account, delivered with signed links.
- Presence is held in memory (correct for a single instance).

## 11. Roles and access
| Role | Can do |
|---|---|
| `patient` | Chat with Lisa, see own visit log |
| `receptionist` ("Receptionist / Secretary") | Bookings desk, calls, check-in, waiting list, chat inbox |
| `doctor` | Own calendar and hours, see own bookings (names and times), request changes. No chat |
| `admin` | Everything above plus users, services, closed days, settings, reports, export, news, enquiries, audit |
| other clinical roles | No booking access; clinical areas only when `CLINICAL_ENABLED=true` |

## 12. API reference
All responses use `{ success, data?, error? }`. Staff routes need `Authorization: Bearer <Clerk token>`.

**Public booking** `/api/booking`
`GET /config`, `/doctors`, `/availability`, `/slots`, `/services`, `/closed-days` · `POST /otp`, `/bookings`, `/waitlist`, `/manage/lookup`, `/manage/cancel`, `/manage/reschedule`

**Staff booking** `/api/booking/staff` (reception, admin, doctor where noted)
`GET /bookings`, `/worklist`, `/slots`, `/waitlist`, `/services`, `/time-off`, `/settings`, `/reports/no-shows`, `/export/bookings` (admin), `/my/calendar` (doctor), `/bookings/:id/calls`
`POST /bookings`, `/bookings/:id/reschedule`, `/bookings/:id/check-in`, `/bookings/:id/calls`, `/bookings/:id/request-change` (doctor), `/request-day-off` (doctor), `/closed-days`, `/services`, `/time-off`, `/waitlist/:id/call|book|remove`, `/my/time-off` (doctor)
`PATCH /bookings/:id/status` · `PUT /my/hours` (doctor), `/services/:id`, `/settings` · `DELETE /closed-days/:id`, `/services/:id`, `/time-off/:id`, `/my/time-off/:id`

**Chat** `/api/chat`
Patient: `GET /mine`, `/mine/unread`, `/visits` · `POST /mine`, `/mine/read`
Front desk: `GET /threads`, `/threads/unread`, `/threads/:id`, `/patients?q=` · `POST /threads` (start), `/threads/:id` (reply), `/threads/:id/seen`

**Uploads** `POST /api/uploads/sign` (purpose: `chat_file`, `doctor_photo`, `news_cover`)
**Admin** `/api/admin`: `stats`, `users`, `users/:id`, `doctors/:id`, `doctors/:id/availability`, `enquiries`, `news`, `audit`
**Public content** `/api/departments`, `/api/doctors`, `/api/news`, `POST /api/contact`
**Auth** `/api/auth/me`, `POST /api/auth/complete-profile` · **Webhook** `POST /api/webhook/clerk`

## 13. Security notes
- Roles are read from our database, never from the browser. Token verification happens on every request and on every socket (re)connect.
- Input is validated with zod. SQL goes through Drizzle (parameterised).
- OTP codes are stored hashed with `OTP_PEPPER`. Manage tokens are stored hashed.
- Rate limits: OTP, booking, waitlist, manage, chat send, upload signing. The limiter is in memory per instance.
- CSV export neutralises spreadsheet formula injection.
- `helmet` is enabled. CORS only allows origins in `FRONTEND_URL`.
- Staff actions are written to the audit log.
- Chat files are private and delivered with signed links. Doctors never see patient chat.
- Data protection: this stores names and phone numbers. Register with Kenya's ODPC as a data controller and keep `/privacy` on the website accurate.

## 14. Test data
`5-seed-booking-test-data.sql` (run after `4-booking-schema.sql` and `1-seed-test-data.sql`) adds hours for every test doctor, services, closed days, about 30 bookings around today, call notes, a waiting-list entry and two chats. `6-remove-booking-test-data.sql` removes it. Use a Neon **branch** for testing. Walkthrough: `BOOKING-TEST-PLAN.md`.

## 15. Operations and troubleshooting
| Symptom | Likely cause |
|---|---|
| "Something went wrong" on `/book`, log says `relation "booking_settings" does not exist` | `4-booking-schema.sql` not run on this database |
| Chat shows "Reconnecting…" forever | `FRONTEND_URL` doesn't list the site origin, or `NEXT_PUBLIC_API_URL` on Vercel points elsewhere |
| 401 on staff screens | Wrong `CLERK_SECRET_KEY`, or token from another Clerk app. The log line starts `Clerk token rejected` |
| New bookings stay pending | No SMS keys, or the OTP wasn't verified. Expected without SMS |
| Upload says "isn't set up yet" | Cloudinary variables missing |
| First request after idle is slow | Render free plan sleeps. Use a paid instance for a live hospital |
Neon backups: enable point-in-time restore and test a restore once.

## 16. Known limits
- One server instance (presence and rate limits are in memory). Scaling out needs Redis for Socket.IO and the limiter.
- No push or SMS alert for new chat messages (by request). Badges and sounds only while a page is open.
- The public "Talk to Lisa" helper is rule-based, not an AI model.
- Verified with automated tests against an in-memory Postgres, type-checks, lint and builds. A full end-to-end pass on the real Neon/Render/Vercel/SMS/Cloudinary setup is still the first thing to do after deploying.