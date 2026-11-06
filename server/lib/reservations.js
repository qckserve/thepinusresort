// Reservations: website leads confirmed by the hotel, walk-ins, phone, WhatsApp, agents.
// Ported from hotelinventorysystem/src/extranet/reservations.ts. A sale takes rooms out of
// daily_inventory in the same transaction that records it, and cancel / no-show / early
// check-out give the unused nights back exactly once (released_from).
import { randomBytes } from 'node:crypto';
import { db, tx, one, all, run, audit, makeRef } from './db.js';
import { addDays, daysBetween, isIsoDate, MAX_NIGHTS, stayNights, today } from './dates.js';
import { checkStay } from './inventory.js';
import { AppError } from './errors.js';

export const SOURCES = ['WEBSITE', 'WALK_IN', 'PHONE', 'WHATSAPP', 'TRAVEL_AGENT', 'OTHER_OTA', 'OTHER'];
export const STATUSES = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'];
const TRANSITIONS = {
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};
const label = (s) => s.replace('_', ' ').toLowerCase();

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function money(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new AppError('VALIDATION_ERROR', `${name} must be an amount in rupees`);
  return Math.round(n * 100);
}

function parse(b) {
  const r = {
    roomTypeId: Number(b.roomTypeId),
    ratePlanId: b.ratePlanId ? Number(b.ratePlanId) : null,
    checkIn: b.checkIn, checkOut: b.checkOut,
    rooms: Number(b.rooms ?? 1), adults: Number(b.adults ?? 2), children: Number(b.children ?? 0),
    source: SOURCES.includes(b.source) ? b.source : null,
    sourceDetail: str(b.sourceDetail, 120) || null,
    guestName: str(b.guestName, 120),
    guestPhone: str(b.guestPhone, 30) || null,
    guestEmail: str(b.guestEmail, 160).toLowerCase() || null,
    amountMinor: money(b.amount, 'Amount'),
    advanceMinor: money(b.advance, 'Advance'),
    notes: str(b.notes, 1000) || null,
    sendEmail: b.sendEmail !== false,
  };
  const errors = {};
  if (!r.roomTypeId) errors.roomTypeId = 'Choose a room type';
  if (!isIsoDate(r.checkIn)) errors.checkIn = 'Choose a check-in date';
  if (!isIsoDate(r.checkOut)) errors.checkOut = 'Choose a check-out date';
  else if (isIsoDate(r.checkIn) && r.checkOut <= r.checkIn) errors.checkOut = 'Check-out must be after check-in';
  else if (isIsoDate(r.checkIn) && daysBetween(r.checkIn, r.checkOut) > MAX_NIGHTS) errors.checkOut = `At most ${MAX_NIGHTS} nights`;
  if (isIsoDate(r.checkIn) && r.checkIn < today()) errors.checkIn = 'Check-in is in the past';
  if (!Number.isInteger(r.rooms) || r.rooms < 1 || r.rooms > 20) errors.rooms = '1 to 20 rooms';
  if (!Number.isInteger(r.adults) || r.adults < 1 || r.adults > 60) errors.adults = '1 to 60 adults';
  if (!Number.isInteger(r.children) || r.children < 0 || r.children > 40) errors.children = '0 to 40 children';
  if (!r.source) errors.source = 'Choose where the booking came from';
  if (r.guestName.length < 2) errors.guestName = 'Guest name is needed';
  if (r.guestPhone && !/^\+?[0-9 ()-]{8,20}$/.test(r.guestPhone)) errors.guestPhone = 'Check the phone number';
  if (r.guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.guestEmail)) errors.guestEmail = 'Check the email';
  if (Object.keys(errors).length) throw new AppError('VALIDATION_ERROR', 'Please check the booking details', { fields: errors });
  return r;
}

/**
 * Creates a confirmed reservation and takes the rooms out of inventory.
 * `enquiryId` links a website lead (marks it booked).
 */
export function createReservation(staffId, body) {
  const r = parse(body);
  const enquiryId = body.enquiryId ? Number(body.enquiryId) : null;
  return tx(() => {
    if (enquiryId) {
      const e = one('SELECT * FROM enquiries WHERE id = ?', enquiryId);
      if (!e) throw new AppError('NOT_FOUND', 'Lead not found');
      if (e.reservation_id) throw new AppError('CONFLICT', 'This lead is already booked');
    }
    const check = checkStay({ ...r, channel: false });
    if (!check.ok) throw new AppError('SOLD_OUT', check.reasons.join('. '), { reasons: check.reasons });

    // Take the rooms. The WHERE re-checks capacity in the same statement.
    const nights = stayNights(r.checkIn, r.checkOut);
    const upd = run(`UPDATE daily_inventory SET allotment = allotment - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                      WHERE room_type_id = ? AND stay_date >= ? AND stay_date < ? AND allotment >= ?`,
      r.rooms, r.roomTypeId, r.checkIn, r.checkOut, r.rooms);
    if (Number(upd.changes) !== nights.length) throw new AppError('SOLD_OUT', 'Room just sold out');

    const amount = r.amountMinor ?? check.amountMinor;
    let id;
    let reference;
    for (let attempt = 0; ; attempt++) {
      reference = makeRef('TPR', 6);
      try {
        id = Number(run(`INSERT INTO reservations
            (reference, enquiry_id, room_type_id, rate_plan_id, source, source_detail, check_in, check_out, rooms, adults, children,
             guest_name, guest_phone, guest_email, amount_minor, advance_minor, notes, review_token, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          reference, enquiryId, r.roomTypeId, check.ratePlan?.id ?? null, r.source, r.sourceDetail, r.checkIn, r.checkOut, r.rooms, r.adults, r.children,
          r.guestName, r.guestPhone, r.guestEmail, amount, r.advanceMinor, r.notes, randomBytes(18).toString('base64url'), staffId).lastInsertRowid);
        break;
      } catch (e) {
        if (!String(e.message).includes('UNIQUE') || attempt >= 4) throw e;
      }
    }
    run("INSERT INTO reservation_events (reservation_id, from_status, to_status, staff_id, remark) VALUES (?, NULL, 'CONFIRMED', ?, ?)",
      id, staffId, enquiryId ? 'Confirmed from website lead' : `Recorded as ${label(r.source)}`);
    if (enquiryId) run("UPDATE enquiries SET status = 'booked', reservation_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", id, enquiryId);
    audit(staffId, 'RESERVATION_CREATE', `${reference}: ${r.rooms} x ${check.roomType.name}, ${r.checkIn} to ${r.checkOut}, ${r.guestName} (${label(r.source)})`, { reservationId: id });
    return getReservation(id);
  });
}

/** Moves a booking through its lifecycle; cancel / no-show / check-out return unused nights once. */
export function changeStatus(staffId, id, to, remark) {
  if (!STATUSES.includes(to)) throw new AppError('VALIDATION_ERROR', 'Unknown status');
  return tx(() => {
    const res = one('SELECT * FROM reservations WHERE id = ?', id);
    if (!res) throw new AppError('NOT_FOUND', 'Booking not found');
    const from = res.status;
    if (from === to) return getReservation(id);
    if (!TRANSITIONS[from].includes(to)) throw new AppError('CONFLICT', `A ${label(from)} booking cannot be marked ${label(to)}`);
    let releaseFrom = null;
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'].includes(to) && !res.released_from) {
      const start = res.check_in > today() ? res.check_in : today();
      if (start < res.check_out) {
        releaseFrom = start;
        run(`UPDATE daily_inventory SET allotment = allotment + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE room_type_id = ? AND stay_date >= ? AND stay_date < ?`, res.rooms, res.room_type_id, start, res.check_out);
      }
    }
    run(`UPDATE reservations SET status = ?, released_from = COALESCE(?, released_from), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`, to, releaseFrom, id);
    run('INSERT INTO reservation_events (reservation_id, from_status, to_status, staff_id, remark) VALUES (?, ?, ?, ?, ?)', id, from, to, staffId, remark ? String(remark).slice(0, 500) : null);
    audit(staffId, 'RESERVATION_STATUS', `${res.reference} ${res.guest_name}: ${label(from)} to ${label(to)}${releaseFrom ? `, ${daysBetween(releaseFrom, res.check_out)} night(s) back on sale` : ''}`, { reservationId: id });
    return getReservation(id);
  });
}

/** Contact details, money and notes can change; dates and rooms need a cancel and rebook. */
export function updateDetails(staffId, id, b) {
  return tx(() => {
    const res = one('SELECT * FROM reservations WHERE id = ?', id);
    if (!res) throw new AppError('NOT_FOUND', 'Booking not found');
    const email = b.guestEmail === undefined ? res.guest_email : str(b.guestEmail, 160).toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('VALIDATION_ERROR', 'Check the email');
    run(`UPDATE reservations SET guest_phone = ?, guest_email = ?, amount_minor = ?, advance_minor = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      b.guestPhone === undefined ? res.guest_phone : str(b.guestPhone, 30) || null,
      email,
      b.amount === undefined ? res.amount_minor : money(b.amount, 'Amount'),
      b.advance === undefined ? res.advance_minor : money(b.advance, 'Advance'),
      b.notes === undefined ? res.notes : str(b.notes, 1000) || null,
      id);
    audit(staffId, 'RESERVATION_EDIT', `${res.reference}: details updated`, { reservationId: id });
    return getReservation(id);
  });
}

const SELECT = `
  SELECT r.*, rt.name AS room_name, rp.name AS rate_plan_name, rp.meal_plan, s.name AS created_by_name,
         rv.rating AS review_rating, rv.comment AS review_comment, e.ref AS lead_ref
    FROM reservations r
    JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id
    LEFT JOIN staff s ON s.id = r.created_by
    LEFT JOIN reviews rv ON rv.reservation_id = r.id
    LEFT JOIN enquiries e ON e.id = r.enquiry_id`;

export function getReservation(id) {
  const r = one(`${SELECT} WHERE r.id = ?`, id);
  if (!r) return null;
  r.events = all(`SELECT ev.*, s.name AS staff_name FROM reservation_events ev LEFT JOIN staff s ON s.id = ev.staff_id WHERE reservation_id = ? ORDER BY ev.id`, id);
  r.emails = all('SELECT kind, recipient, status, error, created_at FROM email_log WHERE reservation_id = ? ORDER BY id DESC', id);
  return r;
}

/** view: upcoming (default), arrivals, departures, inhouse, past, all */
export function listReservations({ view = 'upcoming', q, from, to } = {}) {
  const t = today();
  const where = [];
  const p = [];
  if (view === 'arrivals') { where.push("r.check_in = ? AND r.status = 'CONFIRMED'"); p.push(t); }
  else if (view === 'departures') { where.push("r.check_out = ? AND r.status IN ('CONFIRMED','CHECKED_IN')"); p.push(t); }
  else if (view === 'inhouse') where.push("r.status = 'CHECKED_IN'");
  else if (view === 'past') { where.push('r.check_out < ?'); p.push(t); }
  else if (view === 'cancelled') where.push("r.status IN ('CANCELLED','NO_SHOW')");
  else if (view === 'upcoming') { where.push("r.check_out >= ? AND r.status IN ('CONFIRMED','CHECKED_IN')"); p.push(t); }
  if (from && isIsoDate(from)) { where.push('r.check_out > ?'); p.push(from); }
  if (to && isIsoDate(to)) { where.push('r.check_in <= ?'); p.push(to); }
  if (q) { where.push('(r.guest_name LIKE ? OR r.guest_phone LIKE ? OR r.guest_email LIKE ? OR r.reference LIKE ?)'); p.push(...Array(4).fill(`%${q}%`)); }
  const order = view === 'past' || view === 'cancelled' ? 'r.check_in DESC' : 'r.check_in, r.created_at';
  return all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 500`, ...p);
}

export function dashboardCounts() {
  const t = today();
  return {
    newLeads: Number(one("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'").n),
    arrivals: Number(one("SELECT COUNT(*) AS n FROM reservations WHERE check_in = ? AND status = 'CONFIRMED'", t).n),
    departures: Number(one("SELECT COUNT(*) AS n FROM reservations WHERE check_out = ? AND status IN ('CONFIRMED','CHECKED_IN')", t).n),
    inHouse: Number(one("SELECT COUNT(*) AS n FROM reservations WHERE status = 'CHECKED_IN'").n),
    upcoming: Number(one("SELECT COUNT(*) AS n FROM reservations WHERE check_out >= ? AND status IN ('CONFIRMED','CHECKED_IN')", t).n),
  };
}

/* ---------- Reviews ---------- */
export function reviewByToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return one(`SELECT r.id, r.guest_name, r.check_in, r.check_out, r.status, rv.rating FROM reservations r LEFT JOIN reviews rv ON rv.reservation_id = r.id WHERE r.review_token = ?`, token);
}

export function saveReview(token, rating, comment) {
  const r = reviewByToken(token);
  if (!r) throw new AppError('NOT_FOUND', 'This review link is not valid');
  if (['CANCELLED', 'NO_SHOW'].includes(r.status)) throw new AppError('CONFLICT', 'This booking was not completed');
  if (r.check_in > today()) throw new AppError('CONFLICT', 'You can review after your stay');
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError('VALIDATION_ERROR', 'Choose 1 to 5 stars');
  const text = typeof comment === 'string' ? comment.replace(/\r\n?/g, '\n').trim().slice(0, 2000) : '';
  run(`INSERT INTO reviews (reservation_id, rating, comment) VALUES (?, ?, ?)
       ON CONFLICT(reservation_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`, r.id, n, text || null);
  return { rating: n, name: r.guest_name };
}

export function listReviews() {
  return all(`SELECT rv.*, r.reference, r.guest_name, r.check_in, r.check_out FROM reviews rv JOIN reservations r ON r.id = rv.reservation_id ORDER BY rv.created_at DESC LIMIT 300`);
}

export function toCsv(rows, cols) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.map((c) => c[1]).join(','), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(','))].join('\n');
}

export { db };
