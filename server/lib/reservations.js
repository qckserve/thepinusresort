// Reservations: website leads confirmed by the hotel, walk-ins, phone, WhatsApp, agents.
// Ported from hotelinventorysystem/src/extranet/reservations.ts. A sale takes rooms out of
// daily_inventory in the same transaction that records it, and cancel / no-show / early
// check-out give the unused nights back exactly once (released_from).
import { randomBytes } from 'node:crypto';
import { col, tx, nextId, nowIso, audit, makeRef, searchRe, pub } from './db.js';
import { daysBetween, isIsoDate, MAX_NIGHTS, stayNights, today } from './dates.js';
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

const event = (from, to, staffId, remark) => ({ from_status: from, to_status: to, staff_id: staffId ?? null, remark: remark ?? null, created_at: nowIso() });

/**
 * Creates a confirmed reservation and takes the rooms out of inventory.
 * `enquiryId` links a website lead (marks it booked).
 */
export async function createReservation(staffId, body) {
  const r = parse(body);
  const enquiryId = body.enquiryId ? Number(body.enquiryId) : null;
  const id = await tx(async (session) => {
    if (enquiryId) {
      const e = await col('enquiries').findOne({ _id: enquiryId }, { session });
      if (!e) throw new AppError('NOT_FOUND', 'Lead not found');
      if (e.reservation_id) throw new AppError('CONFLICT', 'This lead is already booked');
    }
    const check = await checkStay({ ...r, channel: false }, session);
    if (!check.ok) throw new AppError('SOLD_OUT', check.reasons.join('. '), { reasons: check.reasons });

    // Take the rooms. The filter re-checks capacity; two buyers of the last room conflict
    // inside their transactions and the loser is retried, then finds it sold out.
    const nights = stayNights(r.checkIn, r.checkOut);
    const upd = await col('daily_inventory').updateMany(
      { room_type_id: r.roomTypeId, stay_date: { $gte: r.checkIn, $lt: r.checkOut }, allotment: { $gte: r.rooms } },
      { $inc: { allotment: -r.rooms }, $set: { updated_at: nowIso() } },
      { session },
    );
    if (upd.modifiedCount !== nights.length) throw new AppError('SOLD_OUT', 'Room just sold out');

    let reference;
    for (let attempt = 0; ; attempt++) {
      reference = makeRef('TPR', 6);
      if (!(await col('reservations').findOne({ reference }, { session, projection: { _id: 1 } }))) break;
      if (attempt >= 4) throw new Error('Could not create a unique reference');
    }
    const newId = await nextId('reservations', session);
    const now = nowIso();
    await col('reservations').insertOne({
      _id: newId, reference, enquiry_id: enquiryId, room_type_id: r.roomTypeId, rate_plan_id: check.ratePlan?._id ?? null,
      source: r.source, source_detail: r.sourceDetail, check_in: r.checkIn, check_out: r.checkOut, rooms: r.rooms, adults: r.adults, children: r.children,
      guest_name: r.guestName, guest_phone: r.guestPhone, guest_email: r.guestEmail,
      amount_minor: r.amountMinor ?? check.amountMinor, advance_minor: r.advanceMinor, notes: r.notes,
      status: 'CONFIRMED', released_from: null, review_token: randomBytes(18).toString('base64url'),
      confirm_sent_at: null, precheckout_sent_at: null, review_sent_at: null, review: null,
      events: [event(null, 'CONFIRMED', staffId, enquiryId ? 'Confirmed from website lead' : `Recorded as ${label(r.source)}`)],
      created_by: staffId ?? null, created_at: now, updated_at: now,
    }, { session });
    if (enquiryId) await col('enquiries').updateOne({ _id: enquiryId }, { $set: { status: 'booked', reservation_id: newId, updated_at: now } }, { session });
    await audit(staffId, 'RESERVATION_CREATE', `${reference}: ${r.rooms} x ${check.roomType.name}, ${r.checkIn} to ${r.checkOut}, ${r.guestName} (${label(r.source)})`, { reservationId: newId }, session);
    return newId;
  });
  return getReservation(id);
}

/** Moves a booking through its lifecycle; cancel / no-show / check-out return unused nights once. */
export async function changeStatus(staffId, id, to, remark) {
  if (!STATUSES.includes(to)) throw new AppError('VALIDATION_ERROR', 'Unknown status');
  await tx(async (session) => {
    const res = await col('reservations').findOne({ _id: id }, { session });
    if (!res) throw new AppError('NOT_FOUND', 'Booking not found');
    const from = res.status;
    if (from === to) return;
    if (!TRANSITIONS[from].includes(to)) throw new AppError('CONFLICT', `A ${label(from)} booking cannot be marked ${label(to)}`);
    let releaseFrom = null;
    if (['CANCELLED', 'NO_SHOW', 'CHECKED_OUT'].includes(to) && !res.released_from) {
      const start = res.check_in > today() ? res.check_in : today();
      if (start < res.check_out) {
        releaseFrom = start;
        await col('daily_inventory').updateMany({ room_type_id: res.room_type_id, stay_date: { $gte: start, $lt: res.check_out } },
          { $inc: { allotment: res.rooms }, $set: { updated_at: nowIso() } }, { session });
      }
    }
    // The status filter makes a concurrent double click a no-op instead of a double release.
    const u = await col('reservations').updateOne({ _id: id, status: from }, {
      $set: { status: to, updated_at: nowIso(), ...(releaseFrom ? { released_from: releaseFrom } : {}) },
      $push: { events: event(from, to, staffId, remark ? String(remark).slice(0, 500) : null) },
    }, { session });
    if (u.modifiedCount !== 1) throw new AppError('CONFLICT', 'This booking just changed. Please refresh.');
    await audit(staffId, 'RESERVATION_STATUS', `${res.reference} ${res.guest_name}: ${label(from)} to ${label(to)}${releaseFrom ? `, ${daysBetween(releaseFrom, res.check_out)} night(s) back on sale` : ''}`, { reservationId: id }, session);
  });
  return getReservation(id);
}

/** Contact details, money and notes can change; dates and rooms need a cancel and rebook. */
export async function updateDetails(staffId, id, b) {
  const res = await col('reservations').findOne({ _id: id });
  if (!res) throw new AppError('NOT_FOUND', 'Booking not found');
  const email = b.guestEmail === undefined ? res.guest_email : str(b.guestEmail, 160).toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('VALIDATION_ERROR', 'Check the email');
  await col('reservations').updateOne({ _id: id }, { $set: {
    guest_phone: b.guestPhone === undefined ? res.guest_phone : str(b.guestPhone, 30) || null,
    guest_email: email,
    amount_minor: b.amount === undefined ? res.amount_minor : money(b.amount, 'Amount'),
    advance_minor: b.advance === undefined ? res.advance_minor : money(b.advance, 'Advance'),
    notes: b.notes === undefined ? res.notes : str(b.notes, 1000) || null,
    updated_at: nowIso(),
  } });
  await audit(staffId, 'RESERVATION_EDIT', `${res.reference}: details updated`, { reservationId: id });
  return getReservation(id);
}

/* ---------- Reading (joins done in code; the lookup collections are tiny) ---------- */
async function decorate(rows) {
  if (!rows.length) return [];
  const [rooms, plans, staff, leads] = await Promise.all([
    col('room_types').find({}, { projection: { name: 1 } }).toArray(),
    col('rate_plans').find({}, { projection: { name: 1, meal_plan: 1 } }).toArray(),
    col('staff').find({}, { projection: { name: 1 } }).toArray(),
    col('enquiries').find({ _id: { $in: rows.map((r) => r.enquiry_id).filter(Boolean) } }, { projection: { ref: 1 } }).toArray(),
  ]);
  const m = (list) => new Map(list.map((x) => [x._id, x]));
  const [R, P, S, L] = [m(rooms), m(plans), m(staff), m(leads)];
  return rows.map((r) => ({
    ...pub(r),
    room_name: R.get(r.room_type_id)?.name ?? '',
    rate_plan_name: P.get(r.rate_plan_id)?.name ?? null,
    meal_plan: P.get(r.rate_plan_id)?.meal_plan ?? null,
    created_by_name: S.get(r.created_by)?.name ?? null,
    review_rating: r.review?.rating ?? null,
    review_comment: r.review?.comment ?? null,
    lead_ref: L.get(r.enquiry_id)?.ref ?? null,
    events: (r.events || []).map((ev) => ({ ...ev, staff_name: S.get(ev.staff_id)?.name ?? null })),
  }));
}

export async function getReservation(id) {
  const doc = await col('reservations').findOne({ _id: id });
  if (!doc) return null;
  const [r] = await decorate([doc]);
  r.emails = (await col('email_log').find({ reservation_id: id }).sort({ _id: -1 }).toArray()).map(({ kind, recipient, status, error, created_at }) => ({ kind, recipient, status, error, created_at }));
  return r;
}

/** view: upcoming (default), arrivals, departures, inhouse, past, cancelled, all */
export async function listReservations({ view = 'upcoming', q } = {}) {
  const t = today();
  const f = {};
  if (view === 'arrivals') Object.assign(f, { check_in: t, status: 'CONFIRMED' });
  else if (view === 'departures') Object.assign(f, { check_out: t, status: { $in: ['CONFIRMED', 'CHECKED_IN'] } });
  else if (view === 'inhouse') f.status = 'CHECKED_IN';
  else if (view === 'past') f.check_out = { $lt: t };
  else if (view === 'cancelled') f.status = { $in: ['CANCELLED', 'NO_SHOW'] };
  else if (view === 'upcoming') Object.assign(f, { check_out: { $gte: t }, status: { $in: ['CONFIRMED', 'CHECKED_IN'] } });
  if (q) { const re = searchRe(q); f.$or = [{ guest_name: re }, { guest_phone: re }, { guest_email: re }, { reference: re }]; }
  const sort = view === 'past' || view === 'cancelled' ? { check_in: -1 } : { check_in: 1, created_at: 1 };
  return decorate(await col('reservations').find(f, { projection: { events: 0 } }).sort(sort).limit(500).toArray());
}

export async function dashboardCounts() {
  const t = today();
  const R = col('reservations');
  const [newLeads, arrivals, departures, inHouse, upcoming] = await Promise.all([
    col('enquiries').countDocuments({ status: 'new' }),
    R.countDocuments({ check_in: t, status: 'CONFIRMED' }),
    R.countDocuments({ check_out: t, status: { $in: ['CONFIRMED', 'CHECKED_IN'] } }),
    R.countDocuments({ status: 'CHECKED_IN' }),
    R.countDocuments({ check_out: { $gte: t }, status: { $in: ['CONFIRMED', 'CHECKED_IN'] } }),
  ]);
  return { newLeads, arrivals, departures, inHouse, upcoming };
}

/* ---------- Reviews (stored on the reservation) ---------- */
export async function reviewByToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const r = await col('reservations').findOne({ review_token: token }, { projection: { guest_name: 1, check_in: 1, check_out: 1, status: 1, review: 1 } });
  return r ? { id: r._id, guest_name: r.guest_name, check_in: r.check_in, check_out: r.check_out, status: r.status, rating: r.review?.rating ?? null } : null;
}

export async function saveReview(token, rating, comment) {
  const r = await reviewByToken(token);
  if (!r) throw new AppError('NOT_FOUND', 'This review link is not valid');
  if (['CANCELLED', 'NO_SHOW'].includes(r.status)) throw new AppError('CONFLICT', 'This booking was not completed');
  if (r.check_in > today()) throw new AppError('CONFLICT', 'You can review after your stay');
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError('VALIDATION_ERROR', 'Choose 1 to 5 stars');
  const text = typeof comment === 'string' ? comment.replace(/\r\n?/g, '\n').trim().slice(0, 2000) : '';
  await col('reservations').updateOne({ _id: r.id }, { $set: { review: { rating: n, comment: text || null, created_at: nowIso() } } });
  return { rating: n, name: r.guest_name };
}

export async function listReviews() {
  const rows = await col('reservations').find({ review: { $ne: null } }, { projection: { reference: 1, guest_name: 1, check_in: 1, check_out: 1, review: 1 } })
    .sort({ 'review.created_at': -1 }).limit(300).toArray();
  return rows.map((r) => ({ id: r._id, reservation_id: r._id, reference: r.reference, guest_name: r.guest_name, check_in: r.check_in, check_out: r.check_out, ...r.review }));
}

export function toCsv(rows, cols) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.map((c) => c[1]).join(','), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(','))].join('\n');
}
