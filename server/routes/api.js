import { Router, json } from 'express';
import { createEnquiry, listEnquiries, countByStatus, updateEnquiry, LEAD_STATUSES, all, one, run, getSettings } from '../lib/db.js';
import { validateEnquiry } from '../lib/validate.js';
import { sendLeadEmails, sendConfirmation, sendPreCheckout, sendReviewRequest, mailEnabled, adminRecipients } from '../lib/mail.js';
import { login, requireStaff, listStaff, createStaff, updateStaff, changeOwnPassword, ROLES } from '../lib/auth.js';
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

// Small in-memory limiter: N requests per window per IP.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, r, next) => {
    const now = Date.now();
    const h = hits.get(req.ip) || { n: 0, reset: now + windowMs };
    if (h.reset < now) Object.assign(h, { n: 0, reset: now + windowMs });
    h.n += 1;
    hits.set(req.ip, h);
    if (h.n > max) return r.status(429).json({ error: 'Too many requests. Please call or WhatsApp us instead.' });
    next();
  };
}
// Wrap handlers so thrown AppErrors reach the error handler (sync or async).
const h = (fn) => (req, r, next) => Promise.resolve().then(() => fn(req, r)).then((out) => out !== undefined && !r.headersSent && r.json(out)).catch(next);

api.get('/health', (req, r) => r.json({ ok: true }));

/* ================= Public ================= */

api.post('/enquiries', limiter(6, 10 * 60 * 1000), h((req, r) => {
  // Honeypot: real people never fill the hidden "website" field.
  if (req.body?.website) return r.status(201).json({ ok: true, ref: 'PIN-00000' });
  const { ok, errors, data } = validateEnquiry(req.body);
  if (!ok) return r.status(422).json({ error: 'Please check the highlighted fields.', fields: errors });
  const { id, ref } = createEnquiry(data);
  // Emails go out in the background; the guest should not wait on SMTP.
  sendLeadEmails({ ...data, id, ref }).catch((e) => console.error('[mail]', e));
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

api.get('/review', limiter(30, 60 * 1000), h((req) => {
  const row = res.reviewByToken(req.query.t);
  if (!row) throw new AppError('NOT_FOUND', 'This review link is not valid');
  return { name: row.guest_name.split(' ')[0], checkIn: row.check_in, checkOut: row.check_out, rated: row.rating ?? null };
}));

api.post('/reviews', limiter(10, 10 * 60 * 1000), h((req) => {
  const out = res.saveReview(req.body?.token, req.body?.rating, req.body?.comment);
  const url = getSettings().review_url || '';
  return { ok: true, rating: out.rating, shareUrl: out.rating >= 4 && url ? url : null };
}));

/* ================= Staff ================= */
const staff = Router();
api.use('/admin', staff);

staff.post('/login', limiter(10, 15 * 60 * 1000), h((req) => login(req.body?.email, req.body?.password)));

const desk = requireStaff('frontdesk');
const manager = requireStaff('manager');
const owner = requireStaff('owner');

staff.get('/me', desk, h((req) => ({ user: req.staff, mailEnabled, notify: adminRecipients(), site: { name: site.name, url: site.url } })));
staff.post('/me/password', desk, h((req) => { changeOwnPassword(req.staff.id, req.body?.current, req.body?.next); return { ok: true }; }));

staff.get('/dashboard', desk, h(() => ({
  counts: res.dashboardCounts(),
  arrivals: res.listReservations({ view: 'arrivals' }),
  departures: res.listReservations({ view: 'departures' }),
  leads: listEnquiries({ status: 'new', limit: 8 }),
})));

/* ---- Leads ---- */
staff.get('/enquiries', desk, h((req) => ({ items: listEnquiries({ status: req.query.status, q: req.query.q }), counts: countByStatus(), statuses: LEAD_STATUSES })));
staff.patch('/enquiries/:id', desk, h((req) => {
  const row = updateEnquiry(Number(req.params.id), req.body || {});
  if (!row) throw new AppError('NOT_FOUND', 'Lead not found');
  return { item: row };
}));
staff.get('/enquiries.csv', desk, (req, r) => {
  const items = listEnquiries({ status: req.query.status, limit: 1000 });
  r.set('Content-Type', 'text/csv; charset=utf-8');
  r.send(res.toCsv(items, [['ref', 'Ref'], ['created_at', 'Received'], ['status', 'Status'], ['kind', 'Type'], ['name', 'Name'], ['phone', 'Phone'], ['email', 'Email'],
    ['check_in', 'Check in'], ['check_out', 'Check out'], ['adults', 'Adults'], ['children', 'Children'], ['rooms', 'Rooms'], ['room_type', 'Room'], ['message', 'Message'], ['notes', 'Notes'], ['reservation_ref', 'Booking']]));
});

/* ---- Bookings ---- */
staff.get('/reservations', desk, h((req) => ({ items: res.listReservations({ view: req.query.view, q: req.query.q }), counts: res.dashboardCounts() })));
staff.get('/reservations.csv', desk, (req, r) => {
  const items = res.listReservations({ view: req.query.view || 'all' });
  r.set('Content-Type', 'text/csv; charset=utf-8');
  r.send(res.toCsv(items.map((x) => ({ ...x, amount: x.amount_minor == null ? '' : x.amount_minor / 100, advance: x.advance_minor == null ? '' : x.advance_minor / 100 })),
    [['reference', 'Reference'], ['status', 'Status'], ['source', 'Source'], ['source_detail', 'Source detail'], ['guest_name', 'Guest'], ['guest_phone', 'Phone'], ['guest_email', 'Email'],
      ['check_in', 'Check in'], ['check_out', 'Check out'], ['rooms', 'Rooms'], ['room_name', 'Room type'], ['rate_plan_name', 'Rate plan'], ['adults', 'Adults'], ['children', 'Children'],
      ['amount', 'Amount INR'], ['advance', 'Advance INR'], ['notes', 'Notes'], ['created_at', 'Created']]));
});
staff.get('/reservations/:id', desk, h((req) => {
  const row = res.getReservation(Number(req.params.id));
  if (!row) throw new AppError('NOT_FOUND', 'Booking not found');
  return { item: row };
}));
staff.post('/quote', desk, h((req) => {
  const b = req.body || {};
  if (!isIsoDate(b.checkIn) || !isIsoDate(b.checkOut) || b.checkOut <= b.checkIn) throw new AppError('VALIDATION_ERROR', 'Choose valid dates');
  const q = inv.checkStay({ roomTypeId: Number(b.roomTypeId), ratePlanId: b.ratePlanId ? Number(b.ratePlanId) : null, checkIn: b.checkIn, checkOut: b.checkOut,
    rooms: Number(b.rooms || 1), adults: Number(b.adults || 2), children: Number(b.children || 0) });
  return { ok: q.ok, reasons: q.reasons, nights: q.nights, amount: q.amountMinor == null ? null : q.amountMinor / 100 };
}));
staff.post('/reservations', desk, h(async (req) => {
  const item = res.createReservation(req.staff.id, req.body || {});
  if (req.body?.sendEmail !== false) await sendConfirmation(item.id).then(() => markSent(item.id, 'confirm_sent_at'));
  return { item: res.getReservation(item.id) };
}));
staff.post('/reservations/:id/status', desk, h((req) => ({ item: res.changeStatus(req.staff.id, Number(req.params.id), req.body?.status, req.body?.remark) })));
staff.patch('/reservations/:id', desk, h((req) => ({ item: res.updateDetails(req.staff.id, Number(req.params.id), req.body || {}) })));
staff.post('/reservations/:id/email', desk, h(async (req) => {
  const id = Number(req.params.id);
  if (!one('SELECT 1 FROM reservations WHERE id = ?', id)) throw new AppError('NOT_FOUND', 'Booking not found');
  const kind = req.body?.kind;
  const map = { confirm: [sendConfirmation, 'confirm_sent_at'], precheckout: [sendPreCheckout, 'precheckout_sent_at'], review: [sendReviewRequest, 'review_sent_at'] };
  if (!map[kind]) throw new AppError('VALIDATION_ERROR', 'Unknown email');
  await map[kind][0](id);
  markSent(id, map[kind][1]);
  return { item: res.getReservation(id) };
}));
function markSent(id, column) {
  run(`UPDATE reservations SET ${column} = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`, id);
}

/* ---- Inventory + rates ---- */
staff.get('/setup', desk, h(() => inv.getSetup()));
staff.post('/room-types', manager, h((req) => ({ id: inv.createRoomType(req.staff.id, req.body || {}), setup: inv.getSetup() })));
staff.put('/room-types/:id', manager, h((req) => ({ id: inv.updateRoomType(req.staff.id, Number(req.params.id), req.body || {}), setup: inv.getSetup() })));
staff.post('/rate-plans', manager, h((req) => ({ id: inv.saveRatePlan(req.staff.id, null, req.body || {}), setup: inv.getSetup() })));
staff.put('/rate-plans/:id', manager, h((req) => ({ id: inv.saveRatePlan(req.staff.id, Number(req.params.id), req.body || {}), setup: inv.getSetup() })));
staff.put('/settings', manager, h((req) => { inv.updateSettings(req.staff.id, req.body || {}); return inv.getSetup(); }));
staff.post('/reset-availability', manager, h((req) => ({ changed: inv.resetAvailability(req.staff.id, req.body?.roomTypeId ? Number(req.body.roomTypeId) : null) })));
staff.get('/calendar', desk, h((req) => inv.getCalendar(req.query.from || today(), Number(req.query.days || 14))));
staff.post('/bulk', manager, h((req) => inv.bulkUpdate(req.staff.id, req.body || {})));

/* ---- Reviews, emails, activity ---- */
staff.get('/reviews', desk, h(() => {
  const items = res.listReviews();
  const avg = items.length ? items.reduce((s, x) => s + x.rating, 0) / items.length : null;
  return { items, average: avg, reviewUrl: getSettings().review_url || '' };
}));
staff.get('/emails', manager, h(() => ({ items: all(`SELECT l.*, r.reference, e.ref AS lead_ref FROM email_log l LEFT JOIN reservations r ON r.id = l.reservation_id LEFT JOIN enquiries e ON e.id = l.enquiry_id ORDER BY l.id DESC LIMIT 300`), mailEnabled })));
staff.get('/audit', manager, h(() => ({ items: all('SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id ORDER BY a.id DESC LIMIT 300') })));
staff.post('/jobs/run', owner, h(() => runJobs({ force: true })));

/* ---- Staff accounts ---- */
staff.get('/staff', owner, h(() => ({ items: listStaff(), roles: ROLES })));
staff.post('/staff', owner, h((req) => { createStaff(req.staff.id, req.body || {}); return { items: listStaff() }; }));
staff.patch('/staff/:id', owner, h((req) => { updateStaff(req.staff.id, Number(req.params.id), req.body || {}); return { items: listStaff() }; }));

/* ---- Errors ---- */
api.use((req, r) => r.status(404).json({ error: 'Not found' }));
api.use((err, req, r, next) => {
  if (err instanceof AppError) return r.status(err.status).json({ error: err.message, code: err.code, ...(err.details || {}) });
  if (err.type === 'entity.parse.failed') return r.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  r.status(500).json({ error: 'Something went wrong. Please call or WhatsApp us.' });
});
