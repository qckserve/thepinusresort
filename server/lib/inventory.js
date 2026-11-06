// Inventory and rates for The Pinus Resort, on MongoDB.
// Ported from hotelinventorysystem (src/extranet/setup.ts, calendar.ts, inventory/ariUpdates.ts),
// reduced to one property.
//
// Model: daily_inventory.allotment = rooms still sellable that night (sales subtract,
// cancellations add back). daily_rates holds price + restrictions per rate plan per night.
// Many-night changes go out as one bulkWrite, inside a transaction where it matters.
import { col, tx, nextId, nowIso, audit, getSettings, setSettings } from './db.js';
import { addDays, daysBetween, isIsoDate, stayNights, today, weekday, MAX_NIGHTS } from './dates.js';
import { AppError } from './errors.js';

export const MEAL_PLANS = { EP: 'Room only', CP: 'With breakfast', MAP: 'Breakfast and dinner', AP: 'All meals' };
const MAX_CAL_DAYS = 62;
const MAX_BULK_DAYS = 400;
const SOLD = ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'];
const RATE_DEFAULTS = { price_minor: null, min_los: 1, max_los: null, closed_to_arrival: false, closed_to_departure: false, stop_sell: false, extra_adult_minor: 0, extra_child_minor: 0 };

const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError('VALIDATION_ERROR', `${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const optInt = (v, min, max, name) => (v === undefined || v === null || v === '' ? null : int(v, min, max, name));
const rupeesToMinor = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new AppError('VALIDATION_ERROR', `${name} must be an amount in rupees`);
  return Math.round(n * 100);
};

/* ---------- Sold nights per room type per date ---------- */
async function soldMap(roomTypeIds, from, to, session) {
  const map = new Map();
  if (!roomTypeIds.length) return map;
  const rows = await col('reservations').find({
    room_type_id: { $in: roomTypeIds },
    status: { $in: SOLD },
    check_in: { $lte: to },
    $or: [{ released_from: null, check_out: { $gt: from } }, { released_from: { $gt: from } }],
  }, { projection: { room_type_id: 1, check_in: 1, check_out: 1, released_from: 1, rooms: 1 }, session }).toArray();
  for (const r of rows) {
    const until = r.released_from || r.check_out;
    for (const d of stayNights(r.check_in > from ? r.check_in : from, until)) {
      if (d > to) break;
      const k = `${r.room_type_id}|${d}`;
      map.set(k, (map.get(k) || 0) + r.rooms);
    }
  }
  return map;
}

/* ---------- Derived rate plans ---------- */
function derivePrice(parentMinor, plan) {
  if (parentMinor == null) return null;
  const v = Number(plan.derive_value);
  const p = plan.derive_type === 'PERCENT' ? Math.round((parentMinor * (10000 + v)) / 10000) : parentMinor + v;
  return p > 0 ? p : null;
}

/** Recalculate every derived child of a manual plan for [from, to]. */
async function rederiveChildren(parentId, from, to, session) {
  const kids = await col('rate_plans').find({ parent_id: parentId, rate_mode: 'DERIVED', is_active: true }, { session }).toArray();
  if (!kids.length) return;
  const parentRows = await col('daily_rates').find({ rate_plan_id: parentId, stay_date: { $gte: from, $lte: to } }, { session }).toArray();
  const ops = [];
  for (const k of kids) {
    for (const p of parentRows) {
      const restr = { min_los: p.min_los, max_los: p.max_los, closed_to_arrival: p.closed_to_arrival, closed_to_departure: p.closed_to_departure, stop_sell: p.stop_sell };
      const set = { price_minor: derivePrice(p.price_minor, k), extra_adult_minor: p.extra_adult_minor, extra_child_minor: p.extra_child_minor, updated_at: nowIso(), ...(k.follow_parent_restrictions ? restr : {}) };
      ops.push({ updateOne: { filter: { rate_plan_id: k._id, stay_date: p.stay_date }, update: { $set: set, ...(k.follow_parent_restrictions ? {} : { $setOnInsert: restr }) }, upsert: true } });
    }
  }
  if (ops.length) await col('daily_rates').bulkWrite(ops, { session, ordered: false });
}

/* ---------- Setup ---------- */
export async function getSetup() {
  const [rooms, plans, s] = await Promise.all([
    col('room_types').find().sort({ is_active: -1, sort_order: 1, name: 1 }).toArray(),
    col('rate_plans').find().sort({ is_default: -1, rate_mode: 1, name: 1 }).toArray(),
    getSettings(),
  ]);
  const planName = new Map(plans.map((p) => [p._id, p.name]));
  return {
    settings: {
      horizonDays: Number(s.horizon_days ?? 365),
      checkinTime: s.checkin_time || '',
      checkoutTime: s.checkout_time || '',
      reviewUrl: s.review_url || '',
      notifyEmail: s.notify_email || '',
    },
    mealPlans: MEAL_PLANS,
    roomTypes: rooms.map((r) => ({
      id: r._id, code: r.code, name: r.name, totalRooms: r.total_rooms, baseOccupancy: r.base_occupancy,
      maxAdults: r.max_adults, maxChildren: r.max_children, maxOccupancy: r.max_occupancy, sortOrder: r.sort_order, isActive: !!r.is_active,
      ratePlans: plans.filter((p) => p.room_type_id === r._id).map((p) => ({
        id: p._id, code: p.code, name: p.name, mealPlan: p.meal_plan, isDefault: !!p.is_default, isActive: !!p.is_active,
        rateMode: p.rate_mode, parentId: p.parent_id, parentName: p.parent_id ? planName.get(p.parent_id) : null, deriveType: p.derive_type,
        deriveValue: p.derive_value == null ? null : p.derive_value / 100,
        followParentRestrictions: !!p.follow_parent_restrictions,
      })),
    })),
  };
}

function roomTypeFields(b, existing) {
  const name = String(b.name ?? existing?.name ?? '').trim().slice(0, 80);
  if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Room type needs a name');
  const code = String(b.code ?? existing?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
  if (!code) throw new AppError('VALIDATION_ERROR', 'Room type needs a short code, e.g. DLX');
  const f = {
    name, code,
    total_rooms: int(b.totalRooms ?? existing?.total_rooms ?? 0, 0, 200, 'Total rooms'),
    base_occupancy: int(b.baseOccupancy ?? existing?.base_occupancy ?? 2, 1, 20, 'Base occupancy'),
    max_adults: int(b.maxAdults ?? existing?.max_adults ?? 2, 1, 20, 'Max adults'),
    max_children: int(b.maxChildren ?? existing?.max_children ?? 0, 0, 20, 'Max children'),
    max_occupancy: int(b.maxOccupancy ?? existing?.max_occupancy ?? 2, 1, 40, 'Max guests'),
    sort_order: int(b.sortOrder ?? existing?.sort_order ?? 0, 0, 999, 'Order'),
    is_active: b.isActive === undefined ? (existing ? !!existing.is_active : true) : !!b.isActive,
  };
  if (f.base_occupancy > f.max_occupancy) throw new AppError('VALIDATION_ERROR', 'Base occupancy cannot be more than max guests');
  return f;
}

export function createRoomType(staffId, b) {
  const f = roomTypeFields(b);
  return tx(async (session) => {
    if (await col('room_types').findOne({ code: f.code }, { session })) throw new AppError('CONFLICT', `Code ${f.code} is already used`);
    const id = await nextId('room_types', session);
    await col('room_types').insertOne({ _id: id, ...f, created_at: nowIso() }, { session });
    await col('rate_plans').insertOne({
      _id: await nextId('rate_plans', session), room_type_id: id, code: 'EP', name: 'Room only', meal_plan: 'EP', is_default: true,
      rate_mode: 'MANUAL', parent_id: null, derive_type: null, derive_value: null, follow_parent_restrictions: true, is_active: true,
    }, { session });
    await audit(staffId, 'ROOM_TYPE', `Added room type ${f.name} (${f.total_rooms} rooms)`, null, session);
    await openHorizon(session, id);
    return id;
  });
}

export function updateRoomType(staffId, id, b) {
  return tx(async (session) => {
    const existing = await col('room_types').findOne({ _id: id }, { session });
    if (!existing) throw new AppError('NOT_FOUND', 'Room type not found');
    const f = roomTypeFields(b, existing);
    if (f.code !== existing.code && await col('room_types').findOne({ code: f.code, _id: { $ne: id } }, { session })) throw new AppError('CONFLICT', `Code ${f.code} is already used`);
    await col('room_types').updateOne({ _id: id }, { $set: f }, { session });
    // Changing total rooms shifts every future night by the difference; sold stays sold.
    const diff = f.total_rooms - existing.total_rooms;
    if (diff) {
      await col('daily_inventory').updateMany({ room_type_id: id, stay_date: { $gte: today() } },
        [{ $set: { allotment: { $max: [0, { $add: ['$allotment', diff] }] }, updated_at: nowIso() } }], { session });
    }
    await audit(staffId, 'ROOM_TYPE', `Updated ${f.name}${diff ? `: total rooms ${existing.total_rooms} to ${f.total_rooms}` : ''}`, null, session);
    await openHorizon(session, id);
    return id;
  });
}

export function saveRatePlan(staffId, id, b) {
  return tx(async (session) => {
    const plans = col('rate_plans');
    const roomTypeId = id ? (await plans.findOne({ _id: id }, { session }))?.room_type_id : Number(b.roomTypeId);
    if (!roomTypeId || !(await col('room_types').findOne({ _id: roomTypeId }, { session }))) throw new AppError('NOT_FOUND', 'Room type not found');
    const name = String(b.name || '').trim().slice(0, 80);
    if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Rate plan needs a name');
    const mealPlan = MEAL_PLANS[b.mealPlan] ? b.mealPlan : 'EP';
    const mode = b.rateMode === 'DERIVED' ? 'DERIVED' : 'MANUAL';
    let parentId = null;
    let deriveType = null;
    let deriveValue = null;
    if (mode === 'DERIVED') {
      const parent = await plans.findOne({ _id: Number(b.parentId), room_type_id: roomTypeId }, { session });
      if (!parent) throw new AppError('VALIDATION_ERROR', 'Choose the plan this one follows');
      if (parent.rate_mode !== 'MANUAL') throw new AppError('VALIDATION_ERROR', 'A derived plan must follow a manual plan (no chains)');
      if (id && parent._id === id) throw new AppError('VALIDATION_ERROR', 'A plan cannot follow itself');
      deriveType = b.deriveType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
      const v = Number(b.deriveValue);
      if (!Number.isFinite(v)) throw new AppError('VALIDATION_ERROR', 'Set the adjustment');
      if (deriveType === 'PERCENT' && (v < -90 || v > 500)) throw new AppError('VALIDATION_ERROR', 'Percent must be between -90 and +500');
      if (deriveType === 'AMOUNT' && Math.abs(v) > 100000) throw new AppError('VALIDATION_ERROR', 'Amount out of range');
      deriveValue = Math.round(v * 100);
      parentId = parent._id;
    }
    if (id && mode === 'DERIVED' && await plans.findOne({ parent_id: id, is_active: true }, { session })) {
      throw new AppError('VALIDATION_ERROR', 'Other plans follow this one, so it must stay manual');
    }
    if (b.isDefault) await plans.updateMany({ room_type_id: roomTypeId }, { $set: { is_default: false } }, { session });
    const fields = { name, meal_plan: mealPlan, rate_mode: mode, parent_id: parentId, derive_type: deriveType, derive_value: deriveValue, follow_parent_restrictions: b.followParentRestrictions !== false };
    let planId = id;
    if (id) {
      await plans.updateOne({ _id: id }, { $set: { ...fields, ...(b.isDefault ? { is_default: true } : {}), ...(b.isActive === undefined ? {} : { is_active: !!b.isActive }) } }, { session });
    } else {
      let code = String(b.code || mealPlan).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) || 'RP';
      let n = 1;
      while (await plans.findOne({ room_type_id: roomTypeId, code }, { session })) code = `${code.replace(/\d+$/, '')}${++n}`;
      planId = await nextId('rate_plans', session);
      await plans.insertOne({ _id: planId, room_type_id: roomTypeId, code, ...fields, is_default: !!b.isDefault, is_active: true }, { session });
    }
    if (!(await plans.findOne({ room_type_id: roomTypeId, is_default: true }, { session }))) await plans.updateOne({ _id: planId }, { $set: { is_default: true } }, { session });
    if (parentId) await rederiveChildren(parentId, today(), addDays(today(), 750), session);
    await openHorizon(session, roomTypeId);
    await audit(staffId, 'RATE_PLAN', `${id ? 'Updated' : 'Added'} rate plan ${name}${mode === 'DERIVED' ? ` (follows parent ${b.deriveValue >= 0 ? '+' : ''}${b.deriveValue}${deriveType === 'PERCENT' ? '%' : ' INR'})` : ''}`, null, session);
    return planId;
  });
}

export async function updateSettings(staffId, b) {
  const set = {};
  if (b.horizonDays !== undefined) set.horizon_days = int(b.horizonDays, 0, 730, 'Selling window');
  for (const [k, key] of [['checkinTime', 'checkin_time'], ['checkoutTime', 'checkout_time']]) {
    if (b[k] !== undefined) {
      const v = String(b[k]).trim();
      if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new AppError('VALIDATION_ERROR', 'Times must look like 12:00');
      set[key] = v;
    }
  }
  if (b.reviewUrl !== undefined) {
    const v = String(b.reviewUrl).trim();
    if (v && !/^https:\/\//.test(v)) throw new AppError('VALIDATION_ERROR', 'Review link must start with https://');
    set.review_url = v.slice(0, 500);
  }
  if (b.notifyEmail !== undefined) {
    const v = String(b.notifyEmail).trim();
    if (v && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}(\s*,\s*[^\s@,]+@[^\s@,]+\.[^\s@,]{2,})*$/.test(v)) throw new AppError('VALIDATION_ERROR', 'Check the notification email');
    set.notify_email = v.slice(0, 300);
  }
  await setSettings(set);
  await audit(staffId, 'SETTINGS', 'Updated settings');
  await rollHorizon();
}

/* ---------- Rolling selling window ---------- */
/** Open nights up to the horizon. New nights get total rooms minus bookings, and the latest price/restrictions. */
async function openHorizon(session, onlyRoomTypeId) {
  const horizon = Number((await getSettings(session)).horizon_days ?? 365);
  if (!horizon) return 0;
  const start = today();
  const end = addDays(start, horizon - 1);
  const rooms = await col('room_types').find({ is_active: true, ...(onlyRoomTypeId ? { _id: onlyRoomTypeId } : {}) }, { session }).toArray();
  const invOps = [];
  const rateOps = [];
  const parents = [];
  for (const rt of rooms) {
    const last = (await col('daily_inventory').find({ room_type_id: rt._id }, { session }).sort({ stay_date: -1 }).limit(1).toArray())[0]?.stay_date;
    const from = last && last >= start ? addDays(last, 1) : start;
    if (from <= end) {
      const sold = await soldMap([rt._id], from, end, session);
      for (const d of stayNights(from, addDays(end, 1))) {
        invOps.push({ updateOne: { filter: { room_type_id: rt._id, stay_date: d }, update: { $setOnInsert: { allotment: Math.max(0, rt.total_rooms - (sold.get(`${rt._id}|${d}`) || 0)), stop_sell: false, updated_at: nowIso() } }, upsert: true } });
      }
    }
    for (const p of await col('rate_plans').find({ room_type_id: rt._id, rate_mode: 'MANUAL', is_active: true }, { session }).toArray()) {
      const lastRate = (await col('daily_rates').find({ rate_plan_id: p._id }, { session }).sort({ stay_date: -1 }).limit(1).toArray())[0];
      const rFrom = lastRate && lastRate.stay_date >= start ? addDays(lastRate.stay_date, 1) : start;
      if (rFrom > end) continue;
      const t = lastRate
        ? { ...RATE_DEFAULTS, price_minor: lastRate.price_minor, min_los: lastRate.min_los, max_los: lastRate.max_los, extra_adult_minor: lastRate.extra_adult_minor, extra_child_minor: lastRate.extra_child_minor }
        : RATE_DEFAULTS;
      for (const d of stayNights(rFrom, addDays(end, 1))) {
        rateOps.push({ updateOne: { filter: { rate_plan_id: p._id, stay_date: d }, update: { $setOnInsert: { ...t, updated_at: nowIso() } }, upsert: true } });
      }
      parents.push([p._id, rFrom]);
    }
  }
  let opened = 0;
  if (invOps.length) opened += (await col('daily_inventory').bulkWrite(invOps, { session, ordered: false })).upsertedCount;
  if (rateOps.length) await col('daily_rates').bulkWrite(rateOps, { session, ordered: false });
  for (const [id, from] of parents) await rederiveChildren(id, from, end, session);
  return opened;
}

export function rollHorizon() {
  return tx((session) => openHorizon(session));
}

export function resetAvailability(staffId, roomTypeId) {
  return tx(async (session) => {
    const rooms = await col('room_types').find({ is_active: true, ...(roomTypeId ? { _id: roomTypeId } : {}) }, { session }).toArray();
    const ops = [];
    for (const rt of rooms) {
      const rows = await col('daily_inventory').find({ room_type_id: rt._id, stay_date: { $gte: today() } }, { session }).sort({ stay_date: 1 }).toArray();
      if (!rows.length) continue;
      const sold = await soldMap([rt._id], rows[0].stay_date, rows.at(-1).stay_date, session);
      for (const r of rows) {
        const v = Math.max(0, rt.total_rooms - (sold.get(`${rt._id}|${r.stay_date}`) || 0));
        if (v !== r.allotment) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { allotment: v, updated_at: nowIso() } } } });
      }
    }
    const changed = ops.length ? (await col('daily_inventory').bulkWrite(ops, { session })).modifiedCount : 0;
    await audit(staffId, 'RESET_AVAILABILITY', `Recomputed rooms left from bookings (${changed} night${changed === 1 ? '' : 's'} corrected)`, null, session);
    return changed;
  });
}

/* ---------- Calendar ---------- */
export async function getCalendar(from, days) {
  if (!isIsoDate(from)) throw new AppError('VALIDATION_ERROR', 'from must be YYYY-MM-DD');
  days = int(days, 1, MAX_CAL_DAYS, 'days');
  const to = addDays(from, days - 1);
  const dates = stayNights(from, addDays(to, 1));
  const [rooms, plans, invRows, rateRows] = await Promise.all([
    col('room_types').find({ is_active: true }).sort({ sort_order: 1, name: 1 }).toArray(),
    col('rate_plans').find({ is_active: true }).sort({ is_default: -1, rate_mode: 1, name: 1 }).toArray(),
    col('daily_inventory').find({ stay_date: { $gte: from, $lte: to } }).toArray(),
    col('daily_rates').find({ stay_date: { $gte: from, $lte: to } }).toArray(),
  ]);
  const inv = new Map(invRows.map((r) => [`${r.room_type_id}|${r.stay_date}`, r]));
  const rates = new Map(rateRows.map((r) => [`${r.rate_plan_id}|${r.stay_date}`, r]));
  const sold = await soldMap(rooms.map((r) => r._id), from, to);
  const rateDay = (r, d) => ({
    date: d,
    price: r?.price_minor == null ? null : r.price_minor / 100,
    minLos: r?.min_los ?? 1, maxLos: r?.max_los ?? null,
    cta: !!r?.closed_to_arrival, ctd: !!r?.closed_to_departure, stopSell: !!r?.stop_sell,
    extraAdult: (r?.extra_adult_minor ?? 0) / 100, extraChild: (r?.extra_child_minor ?? 0) / 100,
  });
  return {
    from, to, dates, today: today(),
    roomTypes: rooms.map((rt) => ({
      id: rt._id, name: rt.name, code: rt.code, totalRooms: rt.total_rooms,
      days: dates.map((d) => {
        const i = inv.get(`${rt._id}|${d}`);
        return { date: d, open: !!i, left: i?.allotment ?? 0, sold: sold.get(`${rt._id}|${d}`) || 0, stopSell: !!i?.stop_sell };
      }),
      ratePlans: plans.filter((p) => p.room_type_id === rt._id).map((p) => ({
        id: p._id, name: p.name, mealPlan: p.meal_plan, isDefault: !!p.is_default, rateMode: p.rate_mode,
        followParentRestrictions: !!p.follow_parent_restrictions,
        rule: p.rate_mode === 'DERIVED' ? `${p.derive_value >= 0 ? '+' : ''}${p.derive_type === 'PERCENT' ? `${p.derive_value / 100}%` : `INR ${p.derive_value / 100}`}` : null,
        days: dates.map((d) => rateDay(rates.get(`${p._id}|${d}`), d)),
      })),
    })),
  };
}

/* ---------- Bulk update (also used for a single day) ---------- */
// set: { rooms, stopSell, price, minLos, maxLos, cta, ctd, extraAdult, extraChild } (undefined = leave as is)
export function bulkUpdate(staffId, b) {
  const { from, to } = b;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new AppError('VALIDATION_ERROR', 'Choose a valid date range');
  if (from < today()) throw new AppError('VALIDATION_ERROR', 'Past dates cannot be changed');
  if (daysBetween(from, to) + 1 > MAX_BULK_DAYS) throw new AppError('VALIDATION_ERROR', `At most ${MAX_BULK_DAYS} days at a time`);
  const wd = Array.isArray(b.weekdays) && b.weekdays.length ? new Set(b.weekdays.map(Number)) : new Set([0, 1, 2, 3, 4, 5, 6]);
  const dates = stayNights(from, addDays(to, 1)).filter((d) => wd.has(weekday(d)));
  if (!dates.length) throw new AppError('VALIDATION_ERROR', 'No dates match those weekdays');
  const s = b.set || {};
  const roomTypeIds = (b.roomTypeIds || []).map(Number);
  const ratePlanIds = (b.ratePlanIds || []).map(Number);

  const rooms = s.rooms === undefined || s.rooms === '' ? null : int(s.rooms, 0, 200, 'Rooms to sell');
  const price = rupeesToMinor(s.price, 'Price');
  const minLos = optInt(s.minLos, 1, MAX_NIGHTS, 'Minimum stay');
  const maxLos = s.maxLos === '' || s.maxLos === undefined ? undefined : s.maxLos === null || s.maxLos === 0 ? null : int(s.maxLos, 1, MAX_NIGHTS, 'Maximum stay');
  const extraAdult = rupeesToMinor(s.extraAdult, 'Extra adult price');
  const extraChild = rupeesToMinor(s.extraChild, 'Extra child price');
  const flag = (v) => (v === undefined || v === null || v === '' ? null : v === true || v === 'true' || v === 1);
  const stopSell = flag(s.stopSell);
  const cta = flag(s.cta);
  const ctd = flag(s.ctd);

  return tx(async (session) => {
    const warnings = [];
    let invChanged = 0;
    for (const rtId of roomTypeIds) {
      const rt = await col('room_types').findOne({ _id: rtId }, { session });
      if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');
      if (rooms === null && stopSell === null) continue;
      const sold = await soldMap([rtId], dates[0], dates.at(-1), session);
      const ops = dates.map((d) => {
        const set = { updated_at: nowIso() };
        if (rooms !== null) {
          const cap = Math.max(0, rt.total_rooms - (sold.get(`${rtId}|${d}`) || 0));
          if (rooms > cap) warnings.push(d);
          set.allotment = Math.min(rooms, cap);
        }
        if (stopSell !== null) set.stop_sell = stopSell;
        // No upsert: nights outside the selling window stay closed.
        return { updateOne: { filter: { room_type_id: rtId, stay_date: d }, update: { $set: set } } };
      });
      invChanged += (await col('daily_inventory').bulkWrite(ops, { session, ordered: false })).matchedCount;
    }
    let rateChanged = 0;
    const touchedParents = [];
    for (const rpId of ratePlanIds) {
      const p = await col('rate_plans').findOne({ _id: rpId }, { session });
      if (!p) throw new AppError('NOT_FOUND', 'Rate plan not found');
      const derived = p.rate_mode === 'DERIVED';
      // A derived plan's price always follows its parent; its restrictions too unless unlinked.
      const locked = derived && p.follow_parent_restrictions;
      const set = {};
      if (!derived && price !== null) set.price_minor = price;
      if (!derived && extraAdult !== null) set.extra_adult_minor = extraAdult;
      if (!derived && extraChild !== null) set.extra_child_minor = extraChild;
      if (!locked) {
        if (minLos !== null) set.min_los = minLos;
        if (maxLos !== undefined) set.max_los = maxLos;
        if (cta !== null) set.closed_to_arrival = cta;
        if (ctd !== null) set.closed_to_departure = ctd;
        if (stopSell !== null) set.stop_sell = stopSell;
      }
      if (Object.keys(set).length) {
        rateChanged += (await col('daily_rates').updateMany({ rate_plan_id: rpId, stay_date: { $in: dates } }, { $set: { ...set, updated_at: nowIso() } }, { session })).matchedCount;
      }
      if (!derived) touchedParents.push(rpId);
    }
    for (const id of touchedParents) await rederiveChildren(id, dates[0], dates.at(-1), session);
    const parts = [];
    if (rooms !== null) parts.push(`rooms ${rooms}`);
    if (stopSell !== null) parts.push(stopSell ? 'stop-sell on' : 'stop-sell off');
    if (price !== null) parts.push(`price INR ${price / 100}`);
    if (minLos !== null) parts.push(`min stay ${minLos}`);
    if (cta !== null) parts.push(cta ? 'closed to arrival' : 'open to arrival');
    if (ctd !== null) parts.push(ctd ? 'closed to departure' : 'open to departure');
    await audit(staffId, 'ARI_UPDATE', `${from === to ? from : `${from} to ${to}`}${wd.size < 7 ? ' (some weekdays)' : ''}: ${parts.join(', ') || 'no change'}`, { roomTypeIds, ratePlanIds }, session);
    return { invChanged, rateChanged, cappedDates: warnings };
  });
}

/* ---------- Availability + quote (website and new bookings) ---------- */
/**
 * Can `rooms` rooms of a room type be sold for the stay? For the website (`channel: true`) the
 * plan's restrictions apply; staff booking a walk-in only need capacity (as in the original extranet).
 * Pass a session to read inside a transaction.
 */
export async function checkStay({ roomTypeId, ratePlanId, checkIn, checkOut, rooms = 1, adults = 2, children = 0, channel = false }, session) {
  const rt = await col('room_types').findOne({ _id: roomTypeId, is_active: true }, { session });
  if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');
  const plan = ratePlanId
    ? await col('rate_plans').findOne({ _id: ratePlanId, room_type_id: roomTypeId, is_active: true }, { session })
    : await col('rate_plans').findOne({ room_type_id: roomTypeId, is_active: true }, { sort: { is_default: -1 }, session });
  const nights = stayNights(checkIn, checkOut);
  const reasons = [];
  if (adults > rt.max_adults * rooms || children > rt.max_children * rooms || adults + children > rt.max_occupancy * rooms) {
    reasons.push(`${rt.name} takes up to ${rt.max_adults} adults and ${rt.max_children} children per room`);
  }
  const inv = await col('daily_inventory').find({ room_type_id: roomTypeId, stay_date: { $gte: checkIn, $lt: checkOut } }, { session }).toArray();
  const byDate = new Map(inv.map((r) => [r.stay_date, r]));
  const short = nights.filter((d) => !byDate.has(d) || byDate.get(d).allotment < rooms);
  if (short.length) reasons.push(`Not enough rooms on ${short.join(', ')}`);

  const rates = plan ? await col('daily_rates').find({ rate_plan_id: plan._id, stay_date: { $gte: checkIn, $lt: checkOut } }, { session }).sort({ stay_date: 1 }).toArray() : [];
  if (channel) {
    if (nights.some((d) => byDate.get(d)?.stop_sell) || rates.some((r) => r.stop_sell)) reasons.push('Closed for sale on some of these dates');
    const first = rates[0];
    if (first?.closed_to_arrival) reasons.push('No arrivals on that date');
    const dep = plan ? await col('daily_rates').findOne({ rate_plan_id: plan._id, stay_date: checkOut }, { session }) : null;
    if (dep?.closed_to_departure) reasons.push('No departures on that date');
    if (first && nights.length < first.min_los) reasons.push(`Minimum stay is ${first.min_los} nights from that date`);
    if (first?.max_los && nights.length > first.max_los) reasons.push(`Maximum stay is ${first.max_los} nights from that date`);
  }

  // Price: every night must have a rate; extra guests beyond base occupancy pay per night.
  let amount = null;
  if (rates.length === nights.length && rates.every((r) => r.price_minor)) {
    const extraAdults = Math.max(0, adults - rt.base_occupancy * rooms);
    const extraKids = Math.max(0, Math.min(children, adults + children - rt.base_occupancy * rooms));
    amount = rates.reduce((sum, r) => sum + r.price_minor * rooms + r.extra_adult_minor * extraAdults + r.extra_child_minor * extraKids, 0);
  }
  return { ok: reasons.length === 0, reasons, roomType: rt, ratePlan: plan, nights: nights.length, amountMinor: amount };
}

/** Website availability: which room types can take this stay. No prices are shown publicly. */
export async function publicAvailability({ checkIn, checkOut, rooms, adults, children }) {
  const types = await col('room_types').find({ is_active: true, total_rooms: { $gt: 0 } }).sort({ sort_order: 1, name: 1 }).toArray();
  if (!types.length) return { configured: false, available: null, roomTypes: [] };
  const out = [];
  for (const t of types) {
    const r = await checkStay({ roomTypeId: t._id, checkIn, checkOut, rooms, adults, children, channel: true });
    out.push({ name: t.name, available: r.ok });
  }
  return { configured: true, available: out.some((x) => x.available), roomTypes: out };
}
