# The Pinus Resort website

New website for [thepinusresort.com](https://thepinusresort.com): a fast multi-page site built with **Vite** and a **Node.js (Express)** backend that stores booking enquiries, emails the resort, and gives staff an admin panel.

## Run it locally

```bash
npm install
cp .env.example .env   # set ADMIN_PASSWORD and SESSION_SECRET; leave MONGODB_URI empty
npm run dev            # local MongoDB on :27027, site on :5173, API on :8787
npm test               # end-to-end API tests against a throwaway MongoDB
```

`npm run dev` starts a local one-node MongoDB replica set (data in `data/mongo/`, ignored by git). The first run downloads the MongoDB binary once. Admin panel: http://localhost:5173/admin/. On the first admin request an owner account is created from `ADMIN_EMAIL` + `ADMIN_PASSWORD`; add other staff inside the admin.

## Deploy on Vercel

1. Import `qckserve/thepinusresort` in Vercel. `vercel.json` sets everything: Vite builds the site into `dist/`, `/api/*` runs `api/index.js` (the Express app as one function), old WordPress URLs redirect, and a daily cron calls `/api/cron` at 10:00 India time.
2. In MongoDB Atlas: **Network Access** > allow `0.0.0.0/0` (Vercel has no fixed IPs), and copy the connection string from **Connect > Drivers**.
3. In Vercel > Settings > Environment Variables, add: `MONGODB_URI`, `MONGODB_DB`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`, `PUBLIC_URL`, and the `SMTP_*` / `MAIL_*` values.
4. Deploy, open `/admin/`, sign in, set the room count and rates.

On the Hobby plan Vercel Cron runs once a day, so "check-out tomorrow" emails go at 10:00 and review requests the morning after check-out (or straight away when the desk marks a guest checked out). For more frequent runs, point a free cron service (e.g. cron-job.org) at `https://<site>/api/cron` with header `Authorization: Bearer <CRON_SECRET>`.

## Deploy on a Node host (alternative)

```bash
npm run build && npm start   # serves dist/ + /api from one process on $PORT, jobs every 10 min
```

Needs Node 22.13+ and the same environment variables.

## Where things live

| Path | What |
| --- | --- |
| `site/*/index.html` | One folder per page (home, about, accommodation, deluxe-room, activities, gallery, reservation, contact, photo-credits, admin) |
| `site/_partials/` | Shared head, header, footer and icon set, pulled in with `<!-- include:header nav=about -->` |
| `site/src/styles/main.css` | The whole design system (colours, type, components) |
| `site/src/js/` | `main.js` (menu, sliders, tabs, lightbox), `enquiry.js` (forms), `admin.js` |
| `data/site.json` | Phone, WhatsApp, email, address, map pin. Change them here once; every page and email updates |
| `data/images.json` | Size list for every photo. `<img data-img="room-deluxe-1">` expands to a full responsive `srcset` at build |
| `public/images/` | Photos as WebP at 640/1280/1920/2560 px |
| `server/` | `app.js` (Express app), `index.js` (Node server), `routes/api.js`, `lib/db.js` (MongoDB), `lib/inventory.js`, `lib/reservations.js`, `lib/mail.js`, `lib/auth.js`, `lib/scheduler.js` |
| `api/index.js` | Vercel function entry (exports the Express app) |
| `vercel.json` | Vercel build, rewrites, redirects, headers, cron |
| `scripts/dev-mongo.mjs` | Local MongoDB replica set for development |
| `test/api.test.mjs` | End-to-end API tests (`npm test`) |

## Admin and inventory (`/admin/`)

Ported from `~/Downloads/hotelinventorysystem` (the hotelier extranet part), rewritten for one property on MongoDB:

| Tab | What it does | Who |
| --- | --- | --- |
| Today | New leads, arrivals and departures today, one-tap check in / check out | everyone |
| Leads | Website booking requests and messages. **Confirm booking** blocks the rooms and emails guest + admin | everyone |
| Bookings | Every stay: check in, check out, cancel, no-show, edit phone/email/amount/advance/notes, resend any email, history | everyone |
| Inventory | Calendar of rooms left, sold and price per rate plan per night. Tap a day to edit; **Bulk update** by date range, weekdays, room types and plans: rooms to sell, stop-sell, price, min/max stay, closed to arrival/departure, extra adult/child price | managers edit |
| Rooms and rates | Room types (count, occupancy), rate plans (manual, or derived +/- % or INR from another plan), selling window, check-in/out times, admin emails, Google review link, reset availability | managers |
| Reviews | Ratings and comments guests leave after check-out | everyone |
| Emails | Log of every email (sent, failed, skipped) and a button to run scheduled emails now | managers |
| Activity | Who changed what | managers |
| Staff | Accounts with roles: owner, manager, front desk | owner |

Rules carried over from the inventory system: a booking takes rooms out of every night in the same transaction (no double booking of the last room); cancel, no-show and early check-out give unused nights back exactly once; changing total rooms shifts every future night by the difference; new nights open automatically each day up to the selling window; 5 wrong passwords lock an account for 15 minutes.

Left out for now (one resort, no online payment yet): B2B supplier pulls, channel-manager webhooks, Channex / OTA sync and the paid-checkout hold. The tables keep room for them.

## Guest emails

| When | Guest gets | Admin gets |
| --- | --- | --- |
| Website booking request | "We have your booking request" | New lead alert with WhatsApp link |
| Hotel confirms (or records) a booking | Booking confirmation with dates, room, total, advance, balance, directions | Copy |
| Day before check-out (from 10 am) | Check-out reminder | "Check-out tomorrow" with balance |
| After check-out | Review request linking to `/review/?t=...` | Copy with the link (so it can go on WhatsApp if the guest has no email) |

Timed emails only go out between 9 am and 9 pm India time, and each is claimed in the database before sending, so retries or parallel instances never send twice. Guests who rate 4 or 5 stars are invited to post on Google (set the link in Rooms and rates).

The timed emails run from Vercel Cron (or every 10 minutes on a Node host). Set `SMTP_*` to send real email. For local testing, `MAIL_PREVIEW_DIR=/some/folder` writes every email as an `.html` file instead.

## API

Public: `POST /api/enquiries`, `GET /api/availability?checkIn&checkOut&rooms&adults&children` (no prices), `GET /api/review?t=`, `POST /api/reviews`.

Staff (Bearer token from `POST /api/admin/login`): `dashboard`, `enquiries`, `reservations` (+ `/:id/status`, `/:id/email`, `.csv`), `quote`, `calendar`, `bulk`, `setup`, `room-types`, `rate-plans`, `settings`, `reset-availability`, `reviews`, `emails`, `audit`, `staff`, `jobs/run`, all under `/api/admin/`.

## Content notes

- Rates are shown as "on request" until the resort confirms prices.
- Room facilities listed are only what is visible in the resort's own photos. Add more (Wi-Fi, heating, meals plan, check-in time) once confirmed.
- Pahalgam area photos are from Wikimedia Commons under CC BY-SA, credited on `/photo-credits/`. Resort photos are the owner's.
