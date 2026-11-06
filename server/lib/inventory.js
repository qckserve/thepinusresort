// Inventory and rates for The Pinus Resort.
// Ported from hotelinventorysystem (src/extranet/setup.ts, calendar.ts, inventory/ariUpdates.ts),
// reduced to one property and moved from Postgres to SQLite.
//
// Model: daily_inventory.allotment = rooms still sellable that night (sales subtract,
// cancellations add back). daily_rates holds price + restrictions per rate plan per night.
import { db, tx, one, all, run, audit, getSettings, setSetting } from './db.js';
import { addDays, daysBetween, isIsoDate, stayNights, today, weekday, MAX_NIGHTS } from './dates.js';
import { AppError } from './errors.js';

export const MEAL_PLANS = { EP: 'Room only', CP: 'With breakfast', MAP: 'Breakfast and dinner', AP: 'All meals' };
const MAX_CAL_DAYS = 62;
const MAX_BULK_DAYS = 400;

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

/* ---------- Sold nights (the source of truth for "reset availability") ---------- */
function soldOn(roomTypeId, date) {
  return Number(one(`
    SELECT COALESCE(SUM(rooms), 0) AS n FROM reservations
     WHERE room_type_id = ? AND status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
       AND check_in <= ? AND COALESCE(released_from, check_out) > ?`, roomTypeId, date, date).n);
}
function soldMap(roomTypeIds, from, to) {
  const map = new Map();
  if (!roomTypeIds.length) return map;
  const rows = all(`
    SELECT room_type_id, check_in, COALESCE(released_from, check_out) AS until, rooms FROM reservations
     WHERE room_type_id IN (${roomTypeIds.map(() => '?').join(',')})
       AND status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT') AND check_in <= ? AND COALESCE(released_from, check_out) > ?`,
    ...roomTypeIds, to, from);
  for (const r of rows) {
    for (const d of stayNights(r.check_in > from ? r.check_in : from, r.until)) {
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
function rederiveChildren(parentId, from, to) {
  const kids = all("SELECT * FROM rate_plans WHERE parent_id = ? AND rate_mode = 'DERIVED' AND is_active = 1", parentId);
  if (!kids.length) return;
  const parentRows = all('SELECT * FROM daily_rates WHERE rate_plan_id = ? AND stay_date BETWEEN ? AND ?', parentId, from, to);
  const upsert = db.prepare(`
    INSERT INTO daily_rates (rate_plan_id, stay_date, price_minor, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell, extra_adult_minor, extra_child_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rate_plan_id, stay_date) DO UPDATE SET
      price_minor = excluded.price_minor,
      min_los = CASE WHEN ? THEN excluded.min_los ELSE daily_rates.min_los END,
      max_los = CASE WHEN ? THEN excluded.max_los ELSE daily_rates.max_los END,
      closed_to_arrival = CASE WHEN ? THEN excluded.closed_to_arrival ELSE daily_rates.closed_to_arrival END,
      closed_to_departure = CASE WHEN ? THEN excluded.closed_to_departure ELSE daily_rates.closed_to_departure END,
      stop_sell = CASE WHEN ? THEN excluded.stop_sell ELSE daily_rates.stop_sell END,
      extra_adult_minor = excluded.extra_adult_minor, extra_child_minor = excluded.extra_child_minor,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  for (const k of kids) {
    const f = k.follow_parent_restrictions ? 1 : 0;
    for (const p of parentRows) {
      upsert.run(k.id, p.stay_date, derivePrice(p.price_minor, k), p.min_los, p.max_los, p.closed_to_arrival, p.closed_to_departure,
        p.stop_sell, p.extra_adult_minor, p.extra_child_minor, f, f, f, f, f);
    }
  }
}

/* ---------- Setup ---------- */
export function getSetup() {
  const rooms = all('SELECT * FROM room_types ORDER BY is_active DESC, sort_order, name');
  const plans = all(`SELECT rp.*, p.name AS parent_name FROM rate_plans rp LEFT JOIN rate_plans p ON p.id = rp.parent_id ORDER BY rp.is_default DESC, rp.rate_mode, rp.name`);
  const s = getSettings();
  return {
    settings: {
      horizonDays: Number(s.horizon_days || 365),
      checkinTime: s.checkin_time || '',
      checkoutTime: s.checkout_time || '',
      reviewUrl: s.review_url || '',
      notifyEmail: s.notify_email || '',
    },
    mealPlans: MEAL_PLANS,
    roomTypes: rooms.map((r) => ({
      id: r.id, code: r.code, name: r.name, totalRooms: r.total_rooms, baseOccupancy: r.base_occupancy,
      maxAdults: r.max_adults, maxChildren: r.max_children, maxOccupancy: r.max_occupancy, sortOrder: r.sort_order, isActive: !!r.is_active,
      ratePlans: plans.filter((p) => p.room_type_id === r.id).map((p) => ({
        id: p.id, code: p.code, name: p.name, mealPlan: p.meal_plan, isDefault: !!p.is_default, isActive: !!p.is_active,
        rateMode: p.rate_mode, parentId: p.parent_id, parentName: p.parent_name, deriveType: p.derive_type,
        deriveValue: p.derive_value == null ? null : p.derive_type === 'PERCENT' ? p.derive_value / 100 : p.derive_value / 100,
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
    is_active: b.isActive === undefined ? (existing ? existing.is_active : 1) : b.isActive ? 1 : 0,
  };
  if (f.base_occupancy > f.max_occupancy) throw new AppError('VALIDATION_ERROR', 'Base occupancy cannot be more than max guests');
  return f;
}

export function createRoomType(staffId, b) {
  return tx(() => {
    const f = roomTypeFields(b);
    if (one('SELECT 1 FROM room_types WHERE code = ?', f.code)) throw new AppError('CONFLICT', `Code ${f.code} is already used`);
    const id = Number(run(`INSERT INTO room_types (code, name, total_rooms, base_occupancy, max_adults, max_children, max_occupancy, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.code, f.name, f.total_rooms, f.base_occupancy, f.max_adults, f.max_children, f.max_occupancy, f.sort_order, f.is_active).lastInsertRowid);
    run("INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default) VALUES (?, 'EP', 'Room only', 'EP', 1)", id);
    audit(staffId, 'ROOM_TYPE', `Added room type ${f.name} (${f.total_rooms} rooms)`);
    openHorizon(id);
    return id;
  });
}

export function updateRoomType(staffId, id, b) {
  return tx(() => {
    const existing = one('SELECT * FROM room_types WHERE id = ?', id);
    if (!existing) throw new AppError('NOT_FOUND', 'Room type not found');
    const f = roomTypeFields(b, existing);
    if (f.code !== existing.code && one('SELECT 1 FROM room_types WHERE code = ? AND id <> ?', f.code, id)) throw new AppError('CONFLICT', `Code ${f.code} is already used`);
    run(`UPDATE room_types SET code=?, name=?, total_rooms=?, base_occupancy=?, max_adults=?, max_children=?, max_occupancy=?, sort_order=?, is_active=? WHERE id=?`,
      f.code, f.name, f.total_rooms, f.base_occupancy, f.max_adults, f.max_children, f.max_occupancy, f.sort_order, f.is_active, id);
    // Changing total rooms shifts every future night by the difference; sold stays sold.
    const diff = f.total_rooms - existing.total_rooms;
    if (diff) {
      run('UPDATE daily_inventory SET allotment = MAX(0, allotment + ?), updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE room_type_id = ? AND stay_date >= ?', diff, id, today());
    }
    audit(staffId, 'ROOM_TYPE', `Updated ${f.name}${diff ? `: total rooms ${existing.total_rooms} to ${f.total_rooms}` : ''}`);
    openHorizon(id);
    return id;
  });
}

export function saveRatePlan(staffId, id, b) {
  return tx(() => {
    const roomTypeId = id ? one('SELECT room_type_id FROM rate_plans WHERE id = ?', id)?.room_type_id : Number(b.roomTypeId);
    if (!roomTypeId || !one('SELECT 1 FROM room_types WHERE id = ?', roomTypeId)) throw new AppError('NOT_FOUND', 'Room type not found');
    const name = String(b.name || '').trim().slice(0, 80);
    if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Rate plan needs a name');
    const mealPlan = MEAL_PLANS[b.mealPlan] ? b.mealPlan : 'EP';
    const mode = b.rateMode === 'DERIVED' ? 'DERIVED' : 'MANUAL';
    let parentId = null;
    let deriveType = null;
    let deriveValue = null;
    if (mode === 'DERIVED') {
      const parent = one('SELECT * FROM rate_plans WHERE id = ? AND room_type_id = ?', Number(b.parentId), roomTypeId);
      if (!parent) throw new AppError('VALIDATION_ERROR', 'Choose the plan this one follows');
      if (parent.rate_mode !== 'MANUAL') throw new AppError('VALIDATION_ERROR', 'A derived plan must follow a manual plan (no chains)');
      if (id && parent.id === id) throw new AppError('VALIDATION_ERROR', 'A plan cannot follow itself');
      deriveType = b.deriveType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
      const v = Number(b.deriveValue);
      if (!Number.isFinite(v)) throw new AppError('VALIDATION_ERROR', 'Set the adjustment');
      if (deriveType === 'PERCENT' && (v < -90 || v > 500)) throw new AppError('VALIDATION_ERROR', 'Percent must be between -90 and +500');
      if (deriveType === 'AMOUNT' && Math.abs(v) > 100000) throw new AppError('VALIDATION_ERROR', 'Amount out of range');
      deriveValue = Math.round(v * 100);
      parentId = parent.id;
    }
    if (id && mode === 'DERIVED' && one("SELECT 1 FROM rate_plans WHERE parent_id = ? AND is_active = 1", id)) {
      throw new AppError('VALIDATION_ERROR', 'Other plans follow this one, so it must stay manual');
    }
    const isDefault = b.isDefault ? 1 : 0;
    if (isDefault) run('UPDATE rate_plans SET is_default = 0 WHERE room_type_id = ?', roomTypeId);
    const follow = b.followParentRestrictions === false ? 0 : 1;
    let planId = id;
    if (id) {
      run(`UPDATE rate_plans SET name=?, meal_plan=?, is_default=MAX(is_default, ?), rate_mode=?, parent_id=?, derive_type=?, derive_value=?, follow_parent_restrictions=?, is_active=COALESCE(?, is_active) WHERE id=?`,
        name, mealPlan, isDefault, mode, parentId, deriveType, deriveValue, follow, b.isActive === undefined ? null : b.isActive ? 1 : 0, id);
    } else {
      let code = String(b.code || mealPlan).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) || 'RP';
      let n = 1;
      while (one('SELECT 1 FROM rate_plans WHERE room_type_id = ? AND code = ?', roomTypeId, code)) code = `${code.replace(/\d+$/, '')}${++n}`;
      planId = Number(run(`INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default, rate_mode, parent_id, derive_type, derive_value, follow_parent_restrictions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, roomTypeId, code, name, mealPlan, isDefault, mode, parentId, deriveType, deriveValue, follow).lastInsertRowid);
    }
    if (!one('SELECT 1 FROM rate_plans WHERE room_type_id = ? AND is_default = 1', roomTypeId)) run('UPDATE rate_plans SET is_default = 1 WHERE id = ?', planId);
    if (parentId) rederiveChildren(parentId, today(), addDays(today(), 750));
    openHorizon(roomTypeId);
    audit(staffId, 'RATE_PLAN', `${id ? 'Updated' : 'Added'} rate plan ${name}${mode === 'DERIVED' ? ` (follows parent ${b.deriveValue >= 0 ? '+' : ''}${b.deriveValue}${deriveType === 'PERCENT' ? '%' : ' INR'})` : ''}`);
    return planId;
  });
}

export function updateSettings(staffId, b) {
  tx(() => {
    if (b.horizonDays !== undefined) setSetting('horizon_days', int(b.horizonDays, 0, 730, 'Selling window'));
    for (const [k, key] of [['checkinTime', 'checkin_time'], ['checkoutTime', 'checkout_time']]) {
      if (b[k] !== undefined) {
        const v = String(b[k]).trim();
        if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new AppError('VALIDATION_ERROR', 'Times must look like 12:00');
        setSetting(key, v);
      }
    }
    if (b.reviewUrl !== undefined) {
      const v = String(b.reviewUrl).trim();
      if (v && !/^https:\/\//.test(v)) throw new AppError('VALIDATION_ERROR', 'Review link must start with https://');
      setSetting('review_url', v.slice(0, 500));
    }
    if (b.notifyEmail !== undefined) {
      const v = String(b.notifyEmail).trim();
      if (v && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}(\s*,\s*[^\s@,]+@[^\s@,]+\.[^\s@,]{2,})*$/.test(v)) throw new AppError('VALIDATION_ERROR', 'Check the notification email');
      setSetting('notify_email', v.slice(0, 300));
    }
    audit(staffId, 'SETTINGS', 'Updated settings');
  });
  rollHorizon();
}

/* ---------- Rolling selling window ---------- */
/** Open nights up to the horizon. New nights get total rooms minus bookings, and the latest price/restrictions. */
function openHorizon(onlyRoomTypeId) {
  const horizon = Number(getSettings().horizon_days || 365);
  if (!horizon) return 0;
  const start = today();
  const end = addDays(start, horizon - 1);
  const rooms = all(`SELECT * FROM room_types WHERE is_active = 1 ${onlyRoomTypeId ? 'AND id = ?' : ''}`, ...(onlyRoomTypeId ? [onlyRoomTypeId] : []));
  let opened = 0;
  const insInv = db.prepare('INSERT OR IGNORE INTO daily_inventory (room_type_id, stay_date, allotment) VALUES (?, ?, ?)');
  const insRate = db.prepare(`INSERT OR IGNORE INTO daily_rates (rate_plan_id, stay_date, price_minor, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell, extra_adult_minor, extra_child_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const rt of rooms) {
    const last = one('SELECT MAX(stay_date) AS d FROM daily_inventory WHERE room_type_id = ?', rt.id).d;
    const from = last && last >= start ? addDays(last, 1) : start;
    if (from <= end) {
      const sold = soldMap([rt.id], from, end);
      for (const d of stayNights(from, addDays(end, 1))) {
        opened += Number(insInv.run(rt.id, d, Math.max(0, rt.total_rooms - (sold.get(`${rt.id}|${d}`) || 0))).changes);
      }
    }
    for (const p of all("SELECT * FROM rate_plans WHERE room_type_id = ? AND rate_mode = 'MANUAL' AND is_active = 1", rt.id)) {
      const lastRate = one('SELECT * FROM daily_rates WHERE rate_plan_id = ? ORDER BY stay_date DESC LIMIT 1', p.id);
      const rFrom = lastRate && lastRate.stay_date >= start ? addDays(lastRate.stay_date, 1) : start;
      if (rFrom > end) continue;
      const t = lastRate || { price_minor: null, min_los: 1, max_los: null, closed_to_arrival: 0, closed_to_departure: 0, stop_sell: 0, extra_adult_minor: 0, extra_child_minor: 0 };
      for (const d of stayNights(rFrom, addDays(end, 1))) {
        insRate.run(p.id, d, t.price_minor, t.min_los, t.max_los, 0, 0, 0, t.extra_adult_minor, t.extra_child_minor);
      }
      rederiveChildren(p.id, rFrom, end);
    }
  }
  return opened;
}

export function rollHorizon() {
  return tx(() => openHorizon());
}

export function resetAvailability(staffId, roomTypeId) {
  return tx(() => {
    const rooms = all(`SELECT * FROM room_types WHERE is_active = 1 ${roomTypeId ? 'AND id = ?' : ''}`, ...(roomTypeId ? [roomTypeId] : []));
    let changed = 0;
    for (const rt of rooms) {
      const rows = all('SELECT stay_date, allotment FROM daily_inventory WHERE room_type_id = ? AND stay_date >= ?', rt.id, today());
      if (!rows.length) continue;
      const sold = soldMap([rt.id], rows[0].stay_date, rows.at(-1).stay_date);
      const upd = db.prepare('UPDATE daily_inventory SET allotment = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE room_type_id = ? AND stay_date = ?');
      for (const r of rows) {
        const v = Math.max(0, rt.total_rooms - (sold.get(`${rt.id}|${r.stay_date}`) || 0));
        if (v !== r.allotment) changed += Number(upd.run(v, rt.id, r.stay_date).changes);
      }
    }
    audit(staffId, 'RESET_AVAILABILITY', `Recomputed rooms left from bookings (${changed} night${changed === 1 ? '' : 's'} corrected)`);
    return changed;
  });
}

/* ---------- Calendar ---------- */
export function getCalendar(from, days) {
  if (!isIsoDate(from)) throw new AppError('VALIDATION_ERROR', 'from must be YYYY-MM-DD');
  days = int(days, 1, MAX_CAL_DAYS, 'days');
  const to = addDays(from, days - 1);
  const dates = stayNights(from, addDays(to, 1));
  const rooms = all('SELECT * FROM room_types WHERE is_active = 1 ORDER BY sort_order, name');
  const ids = rooms.map((r) => r.id);
  const plans = all(`SELECT * FROM rate_plans WHERE is_active = 1 ORDER BY is_default DESC, rate_mode, name`);
  const inv = new Map(all('SELECT * FROM daily_inventory WHERE stay_date BETWEEN ? AND ?', from, to).map((r) => [`${r.room_type_id}|${r.stay_date}`, r]));
  const rates = new Map(all('SELECT * FROM daily_rates WHERE stay_date BETWEEN ? AND ?', from, to).map((r) => [`${r.rate_plan_id}|${r.stay_date}`, r]));
  const sold = soldMap(ids, from, to);
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
      id: rt.id, name: rt.name, code: rt.code, totalRooms: rt.total_rooms,
      days: dates.map((d) => {
        const i = inv.get(`${rt.id}|${d}`);
        return { date: d, open: !!i, left: i?.allotment ?? 0, sold: sold.get(`${rt.id}|${d}`) || 0, stopSell: !!i?.stop_sell };
      }),
      ratePlans: plans.filter((p) => p.room_type_id === rt.id).map((p) => ({
        id: p.id, name: p.name, mealPlan: p.meal_plan, isDefault: !!p.is_default, rateMode: p.rate_mode,
        followParentRestrictions: !!p.follow_parent_restrictions,
        rule: p.rate_mode === 'DERIVED' ? `${p.derive_value >= 0 ? '+' : ''}${p.derive_type === 'PERCENT' ? `${p.derive_value / 100}%` : `INR ${p.derive_value / 100}`}` : null,
        days: dates.map((d) => rateDay(rates.get(`${p.id}|${d}`), d)),
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
  const flag = (v) => (v === undefined || v === null || v === '' ? null : v === true || v === 'true' || v === 1 ? 1 : 0);
  const stopSell = flag(s.stopSell);
  const cta = flag(s.cta);
  const ctd = flag(s.ctd);

  return tx(() => {
    let invChanged = 0;
    let rateChanged = 0;
    const warnings = [];
    for (const rtId of roomTypeIds) {
      const rt = one('SELECT * FROM room_types WHERE id = ?', rtId);
      if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');
      if (rooms === null && stopSell === null) continue;
      const sold = soldMap([rtId], dates[0], dates.at(-1));
      for (const d of dates) {
        const i = one('SELECT * FROM daily_inventory WHERE room_type_id = ? AND stay_date = ?', rtId, d);
        if (!i) continue; // outside the selling window
        let left = i.allotment;
        if (rooms !== null) {
          const cap = Math.max(0, rt.total_rooms - (sold.get(`${rtId}|${d}`) || 0));
          if (rooms > cap) warnings.push(d);
          left = Math.min(rooms, cap);
        }
        invChanged += Number(run('UPDATE daily_inventory SET allotment = ?, stop_sell = COALESCE(?, stop_sell), updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE room_type_id = ? AND stay_date = ?',
          left, stopSell, rtId, d).changes);
      }
    }
    const touchedParents = new Set();
    for (const rpId of ratePlanIds) {
      const p = one('SELECT * FROM rate_plans WHERE id = ?', rpId);
      if (!p) throw new AppError('NOT_FOUND', 'Rate plan not found');
      const derived = p.rate_mode === 'DERIVED';
      // A derived plan's price always follows its parent; its restrictions too unless unlinked.
      const restrictionsLocked = derived && p.follow_parent_restrictions;
      for (const d of dates) {
        const exists = one('SELECT 1 FROM daily_rates WHERE rate_plan_id = ? AND stay_date = ?', rpId, d);
        if (!exists) continue;
        const r = run(`UPDATE daily_rates SET
            price_minor = COALESCE(?, price_minor),
            min_los = COALESCE(?, min_los),
            max_los = CASE WHEN ? THEN ? ELSE max_los END,
            closed_to_arrival = COALESCE(?, closed_to_arrival),
            closed_to_departure = COALESCE(?, closed_to_departure),
            stop_sell = COALESCE(?, stop_sell),
            extra_adult_minor = COALESCE(?, extra_adult_minor),
            extra_child_minor = COALESCE(?, extra_child_minor),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE rate_plan_id = ? AND stay_date = ?`,
          derived ? null : price,
          restrictionsLocked ? null : minLos,
          !restrictionsLocked && maxLos !== undefined ? 1 : 0, maxLos ?? null,
          restrictionsLocked ? null : cta, restrictionsLocked ? null : ctd, restrictionsLocked ? null : stopSell,
          derived ? null : extraAdult, derived ? null : extraChild,
          rpId, d);
        rateChanged += Number(r.changes);
      }
      if (!derived) touchedParents.add(rpId);
    }
    for (const id of touchedParents) rederiveChildren(id, dates[0], dates.at(-1));
    const parts = [];
    if (rooms !== null) parts.push(`rooms ${rooms}`);
    if (stopSell !== null) parts.push(stopSell ? 'stop-sell on' : 'stop-sell off');
    if (price !== null) parts.push(`price INR ${price / 100}`);
    if (minLos !== null) parts.push(`min stay ${minLos}`);
    if (cta !== null) parts.push(cta ? 'closed to arrival' : 'open to arrival');
    if (ctd !== null) parts.push(ctd ? 'closed to departure' : 'open to departure');
    audit(staffId, 'ARI_UPDATE', `${from === to ? from : `${from} to ${to}`}${wd.size < 7 ? ' (some weekdays)' : ''}: ${parts.join(', ') || 'no change'}`, { roomTypeIds, ratePlanIds });
    return { invChanged, rateChanged, cappedDates: warnings };
  });
}

/* ---------- Availability + quote (website and new bookings) ---------- */
/**
 * Can `rooms` rooms of a room type be sold for the stay? For the website (`channel: true`) the
 * plan's restrictions apply; staff booking a walk-in only need capacity (as in the original extranet).
 */
export function checkStay({ roomTypeId, ratePlanId, checkIn, checkOut, rooms = 1, adults = 2, children = 0, channel = false }) {
  const rt = one('SELECT * FROM room_types WHERE id = ? AND is_active = 1', roomTypeId);
  if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');
  const plan = ratePlanId
    ? one('SELECT * FROM rate_plans WHERE id = ? AND room_type_id = ? AND is_active = 1', ratePlanId, roomTypeId)
    : one('SELECT * FROM rate_plans WHERE room_type_id = ? AND is_active = 1 ORDER BY is_default DESC LIMIT 1', roomTypeId);
  const nights = stayNights(checkIn, checkOut);
  const reasons = [];
  if (adults > rt.max_adults * rooms || children > rt.max_children * rooms || adults + children > rt.max_occupancy * rooms) {
    reasons.push(`${rt.name} takes up to ${rt.max_adults} adults and ${rt.max_children} children per room`);
  }
  const inv = all('SELECT * FROM daily_inventory WHERE room_type_id = ? AND stay_date >= ? AND stay_date < ? ORDER BY stay_date', roomTypeId, checkIn, checkOut);
  const byDate = new Map(inv.map((r) => [r.stay_date, r]));
  const short = nights.filter((d) => !byDate.has(d) || byDate.get(d).allotment < rooms);
  if (short.length) reasons.push(`Not enough rooms on ${short.join(', ')}`);

  const rates = plan ? all('SELECT * FROM daily_rates WHERE rate_plan_id = ? AND stay_date >= ? AND stay_date < ? ORDER BY stay_date', plan.id, checkIn, checkOut) : [];
  if (channel) {
    if (nights.some((d) => byDate.get(d)?.stop_sell) || rates.some((r) => r.stop_sell)) reasons.push('Closed for sale on some of these dates');
    const first = rates[0];
    if (first?.closed_to_arrival) reasons.push('No arrivals on that date');
    const dep = one('SELECT closed_to_departure FROM daily_rates WHERE rate_plan_id = ? AND stay_date = ?', plan?.id, checkOut);
    if (dep?.closed_to_departure) reasons.push('No departures on that date');
    if (first && nights.length < first.min_los) reasons.push(`Minimum stay is ${first.min_los} nights from that date`);
    if (first?.max_los && nights.length > first.max_los) reasons.push(`Maximum stay is ${first.max_los} nights from that date`);
  }

  // Price: every night must have a rate; extra guests beyond base occupancy pay per night.
  let amount = null;
  if (rates.length === nights.length && rates.every((r) => r.price_minor)) {
    const extraAdults = Math.max(0, adults - rt.base_occupancy * rooms);
    const extraKids = Math.max(0, Math.min(children, adults + children - rt.base_occupancy * rooms));
    amount = rates.reduce((s, r) => s + r.price_minor * rooms + r.extra_adult_minor * extraAdults + r.extra_child_minor * extraKids, 0);
  }
  return { ok: reasons.length === 0, reasons, roomType: rt, ratePlan: plan, nights: nights.length, amountMinor: amount };
}

/** Website availability: which room types can take this stay. No prices are shown publicly. */
export function publicAvailability({ checkIn, checkOut, rooms, adults, children }) {
  const types = all('SELECT id, name FROM room_types WHERE is_active = 1 AND total_rooms > 0 ORDER BY sort_order, name');
  if (!types.length) return { configured: false, available: null, roomTypes: [] };
  const out = types.map((t) => {
    const r = checkStay({ roomTypeId: t.id, checkIn, checkOut, rooms, adults, children, channel: true });
    return { name: t.name, available: r.ok };
  });
  return { configured: true, available: out.some((x) => x.available), roomTypes: out };
}

/* Exposed for reservations.js */
export const _internal = { soldOn };
