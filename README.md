# The Pinus Resort website

New website for [thepinusresort.com](https://thepinusresort.com): a fast multi-page site built with **Vite** and a **Node.js (Express)** backend that stores booking enquiries, emails the resort, and gives staff an admin panel.

## Run it locally

```bash
npm install
cp .env.example .env   # then set ADMIN_PASSWORD and SESSION_SECRET
npm run dev            # site on http://localhost:5173, API on :8787
```

Admin panel: http://localhost:5173/admin/. On first start an owner account is created from `ADMIN_EMAIL` + `ADMIN_PASSWORD` in `.env`; add other staff inside the admin.

## Production

```bash
npm run build          # outputs dist/
npm start              # serves dist/ + /api from one Node process on $PORT
```

Needs Node 22.13 or newer (Node 24 recommended). Any Node host works (Hostinger Node.js app, a VPS with pm2, Render, Railway). Set the variables from `.env.example` in the host's panel. The SQLite file lives in `data/pinus.db` by default; point `DB_FILE` somewhere persistent if the host wipes the app folder on deploy.

Old WordPress links keep working: `/about`, `/accomodation` (old misspelling) and other paths without a trailing slash redirect with a 301.

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
| `server/` | Express app: `routes/api.js` (enquiries + admin), `lib/db.js` (SQLite), `lib/mail.js` (SMTP), `lib/auth.js` |

## Admin and inventory (`/admin/`)

Ported from `~/Downloads/hotelinventorysystem` (the hotelier extranet part), rewritten for one property on SQLite:

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

The timed emails run inside the server every 10 minutes, only between 9 am and 9 pm India time, and each is claimed in the database before sending, so a restart or a second server process never sends twice. Guests who rate 4 or 5 stars are invited to post on Google (set the link in Rooms and rates).

Set `SMTP_*` in `.env` to send real email. For local testing, `MAIL_PREVIEW_DIR=/some/folder` writes every email as an `.html` file instead.

## API

Public: `POST /api/enquiries`, `GET /api/availability?checkIn&checkOut&rooms&adults&children` (no prices), `GET /api/review?t=`, `POST /api/reviews`.

Staff (Bearer token from `POST /api/admin/login`): `dashboard`, `enquiries`, `reservations` (+ `/:id/status`, `/:id/email`, `.csv`), `quote`, `calendar`, `bulk`, `setup`, `room-types`, `rate-plans`, `settings`, `reset-availability`, `reviews`, `emails`, `audit`, `staff`, `jobs/run`, all under `/api/admin/`.

## Content notes

- Rates are shown as "on request" until the resort confirms prices.
- Room facilities listed are only what is visible in the resort's own photos. Add more (Wi-Fi, heating, meals plan, check-in time) once confirmed.
- Pahalgam area photos are from Wikimedia Commons under CC BY-SA, credited on `/photo-credits/`. Resort photos are the owner's.
