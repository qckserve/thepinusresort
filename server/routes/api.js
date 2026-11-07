import { Router, json } from 'express';
import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { ready, col, nowIso, createEnquiry, listEnquiries, countByStatus, updateEnquiry, confirmActivity, LEAD_STATUSES, getSettings } from '../lib/db.js';
import { validateEnquiry } from '../lib/validate.js';
import { sendLeadEmails, sendActivityConfirmation, sendConfirmation, sendPreCheckout, sendReviewRequest, sendStaffLink, mailEnabled, adminRecipients } from '../lib/mail.js';
import * as auth from '../lib/auth.js';
import { requireStaff, ROLES } from '../lib/auth.js';
import * as inv from '../lib/inventory.js';
import * as res from '../lib/reservations.js';
import { runJobs } from '../lib/scheduler.js';
import { isIsoDate, today, daysBetween } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { site } from '../lib/site.js';

export const api = Router();
api.use(json({ limit: '50kb' }));
api.use((req, r, next) => {
  r.set('Cache-Control', 'no-store');
  next();
});

// Small in-memory limiter: N requests per window per IP (per server instance).
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, r, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    const h = hits.get(req.ip) || { n: 0, reset: now + windowMs };
    if (h.reset < now) Object.assign(h, { n: 0, reset: now + windowMs });
    h.n += 1;
    hits.set(req.ip, h);
    if (h.n > max) return r.status(429).json({ error: 'Too many requests. Please call or WhatsApp us instead.' });
    next();
  };
}
// Wrap handlers so thrown errors (sync or async) reach the error handler.
const h = (fn) => (req, r, next) => Promise.resolve().then(() => fn(req, r)).then((out) => out !== undefined && !r.headersSent && r.json(out)).catch(next);
// Background work that must finish even on serverless (Vercel keeps the function alive for it).
const later = (p) => waitUntil(p.catch((e) => console.error('[background]', e)));

api.get('/health', (req, r) => r.json({ ok: true }));

// Every other route needs the database.
api.use((req, r, next) => { ready().then(() => next(), next); });

/* ================= Scheduled jobs (Vercel Cron or any external cron) ================= */
api.get('/cron', h(async (req) => {
  const secret = process.env.CRON_SECRET;
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) throw new AppError('UNAUTHORIZED', 'Not allowed');
  return (await runJobs()) || { busy: true };
}));

/* ================= Public ================= */
api.post('/enquiries', limiter(6, 10 * 60 * 1000), h(async (req, r) => {
  // Honeypot: real people never fill the hidden "website" field.
  if (req.body?.website) return r.status(201).json({ ok: true, ref: 'PIN-00000' });
  const { ok, errors, data } = validateEnquiry(req.body);
  if (!ok) return r.status(422).json({ error: 'Please check the highlighted fields.', fields: errors });
  const { id, ref } = await createEnquiry(data);
  later(sendLeadEmails({ ...data, id, ref }));
  r.status(201).json({ ok: true, ref });
}));

api.get('/availability', limiter(60, 60 * 1000), h((req) => {
  const { checkIn, checkOut } = req.query;
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn || checkIn < today() || daysBetween(checkIn, checkOut) > 30) {
    throw new AppError('VALIDATION_ERROR', 'Choose valid dates');
  }
  const n = (v, d, max) => Math.min(max, Math.max(0, Number.parseInt(v, 10) || d));
  return inv.publicAvailability({ checkIn, checkOut, rooms: Math.max(1, n(req.query.rooms, 1, 20)), adults: Math.max(1, n(req.query.adults, 2, 40)), children: n(req.query.children, 0, 20) });
}));

api.get('/review', limiter(30, 60 * 1000), h(async (req) => {
  const row = await res.reviewByToken(req.query.t);
  if (!row) throw new AppError('NOT_FOUND', 'This review link is not valid');
  return { name: row.guest_name.split(' ')[0], checkIn: row.check_in, checkOut: row.check_out, rated: row.rating ?? null };
}));

api.post('/reviews', limiter(10, 10 * 60 * 1000), h(async (req) => {
  const out = await res.saveReview(req.body?.token, req.body?.rating, req.body?.comment);
  const url = (await getSettings()).review_url || '';
  return { ok: true, rating: out.rating, shareUrl: out.rating >= 4 && url ? url : null };
}));

/* ================= Staff ================= */
const staff = Router();
api.use('/admin', staff);

// First admin request on a fresh instance: make sure the owner account exists (from ADMIN_PASSWORD).
let ownerReady = null;
staff.use((req, r, next) => {
  ownerReady ??= auth.bootstrapOwner().catch((e) => { ownerReady = null; throw e; });
  ownerReady.then(() => next(), next);
});

// Sign-in pages call these without a session. State-changing ones still need the admin header.
const needHeader = (req, r, next) => (req.get('x-pinus-admin') === '1' ? next() : r.status(403).json({ error: 'Missing request header.' }));
const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

staff.get('/status', h(async () => ({ hasStaff: await auth.hasStaff(), mailEnabled })));

// Per IP (a whole office shares one); the per-account lockout is the main brute-force guard.
const LOGIN_LIMIT = Number(process.env.LOGIN_LIMIT || 30);
staff.post('/login', needHeader, limiter(LOGIN_LIMIT, 15 * 60 * 1000), h(async (req, r) => {
  const out = await auth.login(req.body?.email, req.body?.password, { remember: !!req.body?.remember, ...meta(req) });
  auth.setCookie(r, out.token, out.expires, out.remember);
  return { user: out.user };
}));

staff.post('/logout', needHeader, h(async (req, r) => {
  await auth.logout(auth.readCookie(req), { everywhere: !!req.body?.everywhere });
  auth.clearCookie(r);
  return { ok: true };
}));

// Forgot password: same answer whether or not the email has an account.
staff.post('/forgot', needHeader, limiter(5, 15 * 60 * 1000), h(async (req) => {
  if (!mailEnabled) return { ok: true, mailEnabled: false };
  const started = await auth.startPasswordReset(req.body?.email);
  if (started) later(sendStaffLink({ user: started.user, token: started.token, kind: 'reset' }));
  return { ok: true, mailEnabled: true };
}));

// Reset / invite links: check, then set the password and sign straight in.
staff.get('/link', limiter(30, 15 * 60 * 1000), h(async (req) => {
  const l = await auth.checkLink(req.query.t);
  if (!l) throw new AppError('NOT_FOUND', 'This link has expired or was already used. Ask for a new one.');
  return l;
}));
staff.post('/link', needHeader, limiter(10, 15 * 60 * 1000), h(async (req, r) => {
  const { email } = await auth.completePasswordLink(req.body?.token, req.body?.password);
  const out = await auth.login(email, req.body.password, { remember: false, ...meta(req) });
  auth.setCookie(r, out.token, out.expires, false);
  return { user: out.user };
}));

const desk = requireStaff('frontdesk');
const manager = requireStaff('manager');
const owner = requireStaff('owner');
const num = (v) => Number(v);

staff.get('/me', desk, h(async (req) => ({ user: req.staff, mailEnabled, notify: await adminRecipients(), site: { name: site.name, url: site.url } })));
staff.get('/me/sessions', desk, h(async (req) => ({ items: await auth.listSessions(req.staff.id, req.sessionToken) })));
staff.post('/me/password', desk, h(async (req) => { await auth.changeOwnPassword(req.staff.id, req.body?.current, req.body?.next, req.sessionToken); return { ok: true }; }));

staff.get('/dashboard', desk, h(async () => {
  const t = today();
  const tomorrow = new Date(Date.parse(`${t}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const [counts, arrivals, departures, leads, experiences] = await Promise.all([
    res.dashboardCounts(), res.listReservations({ view: 'arrivals' }), res.listReservations({ view: 'departures' }), listEnquiries({ status: 'new', limit: 8 }),
    col('enquiries').find({ kind: 'activity', status: 'booked', 'confirmed.date': { $in: [t, tomorrow] } }).sort({ 'confirmed.date': 1, 'confirmed.time': 1 }).toArray(),
  ]);
  return { counts, arrivals, departures, leads, experiences: experiences.map(({ _id, ...x }) => ({ id: _id, ...x })), today: t };
}));

/* ---- Leads ---- */
staff.get('/enquiries', desk, h(async (req) => {
  const [items, counts] = await Promise.all([listEnquiries({ status: req.query.status, kind: req.query.kind, q: req.query.q }), countByStatus(req.query.kind)]);
  return { items, counts, statuses: LEAD_STATUSES };
}));
staff.patch('/enquiries/:id', desk, h(async (req) => {
  const row = await updateEnquiry(num(req.params.id), req.body || {});
  if (!row) throw new AppError('NOT_FOUND', 'Lead not found');
  return { item: row };
}));
staff.post('/enquiries/:id/confirm-activity', desk, h(async (req) => {
  const item = await confirmActivity(num(req.params.id), req.staff.id, req.body || {});
  if (req.body?.sendEmail !== false) await sendActivityConfirmation({ ...item, id: item.id });
  return { item };
}));
staff.get('/enquiries.csv', desk, h(async (req, r) => {
  const items = await listEnquiries({ status: req.query.status, limit: 1000 });
  r.set('Content-Type', 'text/csv; charset=utf-8');
  r.send(res.toCsv(items, [['ref', 'Ref'], ['created_at', 'Received'], ['status', 'Status'], ['kind', 'Type'], ['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'],
    ['check_in', 'Check in'], ['check_out', 'Check out'], ['adults', 'Adults'], ['children', 'Children'], ['rooms', 'Rooms'], ['room_type', 'Room'], ['activity_name', 'Experience'], ['slot', 'Time'], ['message', 'Message'], ['notes', 'Notes'], ['reservation_ref', 'Booking']]));
}));

/* ---- Bookings ---- */
staff.get('/reservations', desk, h(async (req) => {
  const [items, counts] = await Promise.all([res.listReservations({ view: req.query.view, q: req.query.q }), res.dashboardCounts()]);
  return { items, counts };
}));
staff.get('/reservations.csv', desk, h(async (req, r) => {
  const items = await res.listReservations({ view: req.query.view || 'all' });
  r.set('Content-Type', 'text/csv; charset=utf-8');
  r.send(res.toCsv(items.map((x) => ({ ...x, amount: x.amount_minor == null ? '' : x.amount_minor / 100, advance: x.advance_minor == null ? '' : x.advance_minor / 100 })),
    [['reference', 'Reference'], ['status', 'Status'], ['source', 'Source'], ['source_detail', 'Source detail'], ['guest_name', 'Guest'], ['guest_phone', 'Phone'], ['guest_email', 'Email'],
      ['check_in', 'Check in'], ['check_out', 'Check out'], ['rooms', 'Rooms'], ['room_name', 'Room type'], ['rate_plan_name', 'Rate plan'], ['adults', 'Adults'], ['children', 'Children'],
      ['amount', 'Amount INR'], ['advance', 'Advance INR'], ['notes', 'Notes'], ['created_at', 'Created']]));
}));
staff.get('/reservations/:id', desk, h(async (req) => {
  const row = await res.getReservation(num(req.params.id));
  if (!row) throw new AppError('NOT_FOUND', 'Booking not found');
  return { item: row };
}));
staff.post('/quote', desk, h(async (req) => {
  const b = req.body || {};
  if (!isIsoDate(b.checkIn) || !isIsoDate(b.checkOut) || b.checkOut <= b.checkIn) throw new AppError('VALIDATION_ERROR', 'Choose valid dates');
  const q = await inv.checkStay({ roomTypeId: num(b.roomTypeId), ratePlanId: b.ratePlanId ? num(b.ratePlanId) : null, checkIn: b.checkIn, checkOut: b.checkOut,
    rooms: num(b.rooms || 1), adults: num(b.adults || 2), children: num(b.children || 0) });
  return { ok: q.ok, reasons: q.reasons, nights: q.nights, amount: q.amountMinor == null ? null : q.amountMinor / 100 };
}));
const markSent = (id, field) => col('reservations').updateOne({ _id: id }, { $set: { [field]: nowIso() } });
staff.post('/reservations', desk, h(async (req) => {
  const item = await res.createReservation(req.staff.id, req.body || {});
  if (req.body?.sendEmail !== false) {
    await sendConfirmation(item.id);
    await markSent(item.id, 'confirm_sent_at');
  }
  return { item: await res.getReservation(item.id) };
}));
staff.post('/reservations/:id/status', desk, h(async (req) => {
  const item = await res.changeStatus(req.staff.id, num(req.params.id), req.body?.status, req.body?.remark);
  // Checking a guest out sends the review request straight away (within email hours).
  if (item.status === 'CHECKED_OUT') later(runJobs());
  return { item };
}));
staff.patch('/reservations/:id', desk, h(async (req) => ({ item: await res.updateDetails(req.staff.id, num(req.params.id), req.body || {}) })));
staff.post('/reservations/:id/email', desk, h(async (req) => {
  const id = num(req.params.id);
  if (!(await col('reservations').findOne({ _id: id }, { projection: { _id: 1 } }))) throw new AppError('NOT_FOUND', 'Booking not found');
  const map = { confirm: [sendConfirmation, 'confirm_sent_at'], precheckout: [sendPreCheckout, 'precheckout_sent_at'], review: [sendReviewRequest, 'review_sent_at'] };
  const pick = map[req.body?.kind];
  if (!pick) throw new AppError('VALIDATION_ERROR', 'Unknown email');
  await pick[0](id);
  await markSent(id, pick[1]);
  return { item: await res.getReservation(id) };
}));

/* ---- Inventory + rates ---- */
staff.get('/setup', desk, h(() => inv.getSetup()));
staff.post('/room-types', manager, h(async (req) => ({ id: await inv.createRoomType(req.staff.id, req.body || {}), setup: await inv.getSetup() })));
staff.put('/room-types/:id', manager, h(async (req) => ({ id: await inv.updateRoomType(req.staff.id, num(req.params.id), req.body || {}), setup: await inv.getSetup() })));
staff.post('/rate-plans', manager, h(async (req) => ({ id: await inv.saveRatePlan(req.staff.id, null, req.body || {}), setup: await inv.getSetup() })));
staff.put('/rate-plans/:id', manager, h(async (req) => ({ id: await inv.saveRatePlan(req.staff.id, num(req.params.id), req.body || {}), setup: await inv.getSetup() })));
staff.put('/settings', manager, h(async (req) => { await inv.updateSettings(req.staff.id, req.body || {}); return inv.getSetup(); }));
staff.post('/reset-availability', manager, h(async (req) => ({ changed: await inv.resetAvailability(req.staff.id, req.body?.roomTypeId ? num(req.body.roomTypeId) : null) })));
staff.get('/calendar', desk, h((req) => inv.getCalendar(req.query.from || today(), num(req.query.days || 14))));
staff.post('/bulk', manager, h((req) => inv.bulkUpdate(req.staff.id, req.body || {})));

/* ---- Reviews, emails, activity ---- */
staff.get('/reviews', desk, h(async () => {
  const items = await res.listReviews();
  const avg = items.length ? items.reduce((s, x) => s + x.rating, 0) / items.length : null;
  return { items, average: avg, reviewUrl: (await getSettings()).review_url || '' };
}));
staff.get('/emails', manager, h(async () => {
  const items = await col('email_log').find().sort({ _id: -1 }).limit(300).toArray();
  const [resRefs, leadRefs] = await Promise.all([
    col('reservations').find({ _id: { $in: items.map((x) => x.reservation_id).filter(Boolean) } }, { projection: { reference: 1 } }).toArray(),
    col('enquiries').find({ _id: { $in: items.map((x) => x.enquiry_id).filter(Boolean) } }, { projection: { ref: 1 } }).toArray(),
  ]);
  const R = new Map(resRefs.map((x) => [x._id, x.reference]));
  const L = new Map(leadRefs.map((x) => [x._id, x.ref]));
  return { items: items.map(({ _id, ...x }) => ({ id: String(_id), ...x, reference: R.get(x.reservation_id) ?? null, lead_ref: L.get(x.enquiry_id) ?? null })), mailEnabled };
}));
staff.get('/audit', manager, h(async () => {
  const [items, people] = await Promise.all([col('audit_log').find().sort({ _id: -1 }).limit(300).toArray(), col('staff').find({}, { projection: { name: 1 } }).toArray()]);
  const S = new Map(people.map((p) => [p._id, p.name]));
  return { items: items.map(({ _id, ...a }) => ({ id: String(_id), ...a, staff_name: S.get(a.staff_id) ?? null })) };
}));
staff.post('/jobs/run', owner, h(async () => (await runJobs({ force: true })) || { busy: true }));

/* ---- Staff accounts ---- */
staff.get('/staff', owner, h(async () => ({ items: await auth.listStaff(), roles: ROLES, mailEnabled })));
// Invites are emailed. Without email set up, the owner gets the link to pass on (e.g. WhatsApp).
staff.post('/staff', owner, h(async (req) => {
  const { user, inviteToken } = await auth.createStaff(req.staff.id, req.body || {});
  let link = null;
  if (inviteToken) {
    const sent = await sendStaffLink({ user, token: inviteToken, kind: 'invite' });
    if (sent.status !== 'sent') link = sent.link;
  }
  return { items: await auth.listStaff(), link };
}));
staff.post('/staff/:id/link', owner, h(async (req) => {
  const { user, token } = await auth.reinvite(req.staff.id, num(req.params.id));
  const sent = await sendStaffLink({ user, token, kind: user.invited ? 'invite' : 'reset' });
  return { emailed: sent.status === 'sent', link: sent.status === 'sent' ? null : sent.link };
}));
staff.patch('/staff/:id', owner, h(async (req) => { await auth.updateStaff(req.staff.id, num(req.params.id), req.body || {}); return { items: await auth.listStaff() }; }));

/* ---- Errors ---- */
api.use((req, r) => r.status(404).json({ error: 'Not found' }));
api.use((err, req, r, next) => {
  // Database problems: staff screens get the exact fix, guests a friendly line.
  if (err instanceof AppError && (err.code === 'DB_UNREACHABLE' || err.code === 'NOT_CONFIGURED')) {
    const forStaff = req.originalUrl.startsWith('/api/admin');
    return r.status(503).json({ error: forStaff ? err.message : 'The booking system is briefly unavailable. Please call or WhatsApp us.', code: err.code, ...(forStaff ? err.details || {} : {}) });
  }
  if (err instanceof AppError) return r.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
  if (err.type === 'entity.parse.failed') return r.status(400).json({ error: 'Invalid request.' });
  if (err.name === 'MongoServerSelectionError' || err.name === 'MongoNetworkError') {
    console.error('[db]', err.message);
    return r.status(503).json({ error: 'The booking system is briefly unavailable. Please call or WhatsApp us.' });
  }
  console.error(err);
  r.status(500).json({ error: 'Something went wrong. Please call or WhatsApp us.' });
});
