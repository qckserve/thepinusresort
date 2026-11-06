// SQLite storage using Node's built-in driver (node:sqlite). One file, no database server.
// Schema changes are numbered migrations tracked in PRAGMA user_version.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const file = resolve(process.env.DB_FILE || resolve(import.meta.dirname, '../../data/pinus.db'));
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))";

const migrations = [
  // 1: website enquiries (leads)
  `CREATE TABLE IF NOT EXISTS enquiries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ref TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL DEFAULT 'booking',
     name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
     check_in TEXT, check_out TEXT, adults INTEGER, children INTEGER, rooms INTEGER, room_type TEXT,
     message TEXT, source TEXT,
     status TEXT NOT NULL DEFAULT 'new', notes TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
   );
   CREATE INDEX IF NOT EXISTS enquiries_status ON enquiries(status, created_at DESC);`,

  // 2: inventory system (ported from hotelinventorysystem, single property)
  `UPDATE enquiries SET status = 'booked' WHERE status = 'confirmed';
   UPDATE enquiries SET status = 'lost' WHERE status = 'cancelled';
   ALTER TABLE enquiries ADD COLUMN reservation_id INTEGER;

   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

   CREATE TABLE staff (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner','manager','frontdesk')),
     password_hash TEXT NOT NULL,
     token_version INTEGER NOT NULL DEFAULT 1,
     is_active INTEGER NOT NULL DEFAULT 1,
     failed_logins INTEGER NOT NULL DEFAULT 0,
     locked_until TEXT,
     last_login_at TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );

   CREATE TABLE room_types (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     total_rooms INTEGER NOT NULL DEFAULT 0 CHECK (total_rooms >= 0),
     base_occupancy INTEGER NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
     max_adults INTEGER NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
     max_children INTEGER NOT NULL DEFAULT 1 CHECK (max_children >= 0),
     max_occupancy INTEGER NOT NULL DEFAULT 3 CHECK (max_occupancy >= 1),
     sort_order INTEGER NOT NULL DEFAULT 0,
     is_active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );

   -- Derived plans follow a manual parent: PERCENT in basis points (+1500 = +15%), AMOUNT in paise.
   CREATE TABLE rate_plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
     code TEXT NOT NULL,
     name TEXT NOT NULL,
     meal_plan TEXT NOT NULL DEFAULT 'EP' CHECK (meal_plan IN ('EP','CP','MAP','AP')),
     is_default INTEGER NOT NULL DEFAULT 0,
     rate_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (rate_mode IN ('MANUAL','DERIVED')),
     parent_id INTEGER REFERENCES rate_plans(id) ON DELETE RESTRICT,
     derive_type TEXT CHECK (derive_type IN ('PERCENT','AMOUNT')),
     derive_value INTEGER,
     follow_parent_restrictions INTEGER NOT NULL DEFAULT 1,
     is_active INTEGER NOT NULL DEFAULT 1,
     UNIQUE (room_type_id, code),
     CHECK ((rate_mode = 'MANUAL' AND parent_id IS NULL) OR
            (rate_mode = 'DERIVED' AND parent_id IS NOT NULL AND derive_type IS NOT NULL AND derive_value IS NOT NULL))
   );
   CREATE UNIQUE INDEX rate_plans_one_default ON rate_plans(room_type_id) WHERE is_default = 1;

   -- Rooms still sellable per room type per night (shared by all rate plans).
   CREATE TABLE daily_inventory (
     room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
     stay_date TEXT NOT NULL,
     allotment INTEGER NOT NULL DEFAULT 0 CHECK (allotment >= 0),
     stop_sell INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL DEFAULT ${NOW},
     PRIMARY KEY (room_type_id, stay_date)
   ) WITHOUT ROWID;

   CREATE TABLE daily_rates (
     rate_plan_id INTEGER NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
     stay_date TEXT NOT NULL,
     price_minor INTEGER CHECK (price_minor IS NULL OR price_minor > 0),
     min_los INTEGER NOT NULL DEFAULT 1 CHECK (min_los >= 1),
     max_los INTEGER CHECK (max_los IS NULL OR max_los >= 1),
     closed_to_arrival INTEGER NOT NULL DEFAULT 0,
     closed_to_departure INTEGER NOT NULL DEFAULT 0,
     stop_sell INTEGER NOT NULL DEFAULT 0,
     extra_adult_minor INTEGER NOT NULL DEFAULT 0 CHECK (extra_adult_minor >= 0),
     extra_child_minor INTEGER NOT NULL DEFAULT 0 CHECK (extra_child_minor >= 0),
     updated_at TEXT NOT NULL DEFAULT ${NOW},
     PRIMARY KEY (rate_plan_id, stay_date)
   ) WITHOUT ROWID;

   CREATE TABLE reservations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     reference TEXT NOT NULL UNIQUE,
     enquiry_id INTEGER REFERENCES enquiries(id),
     room_type_id INTEGER NOT NULL REFERENCES room_types(id),
     rate_plan_id INTEGER REFERENCES rate_plans(id),
     source TEXT NOT NULL CHECK (source IN ('WEBSITE','WALK_IN','PHONE','WHATSAPP','TRAVEL_AGENT','OTHER_OTA','OTHER')),
     source_detail TEXT,
     check_in TEXT NOT NULL, check_out TEXT NOT NULL,
     rooms INTEGER NOT NULL CHECK (rooms BETWEEN 1 AND 20),
     adults INTEGER NOT NULL DEFAULT 2 CHECK (adults >= 1),
     children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
     guest_name TEXT NOT NULL, guest_phone TEXT, guest_email TEXT,
     amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
     advance_minor INTEGER CHECK (advance_minor IS NULL OR advance_minor >= 0),
     notes TEXT,
     status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW')),
     released_from TEXT,
     review_token TEXT UNIQUE,
     confirm_sent_at TEXT, precheckout_sent_at TEXT, review_sent_at TEXT,
     created_by INTEGER REFERENCES staff(id),
     created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW},
     CHECK (check_out > check_in)
   );
   CREATE INDEX reservations_dates ON reservations(check_in, check_out);
   CREATE INDEX reservations_checkout ON reservations(check_out, status);

   CREATE TABLE reservation_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
     from_status TEXT, to_status TEXT NOT NULL,
     staff_id INTEGER REFERENCES staff(id), remark TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );

   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     staff_id INTEGER REFERENCES staff(id),
     action TEXT NOT NULL, summary TEXT NOT NULL, details TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );
   CREATE INDEX audit_log_time ON audit_log(created_at DESC);

   CREATE TABLE email_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
     enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE SET NULL,
     recipient TEXT NOT NULL, subject TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
     error TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );
   CREATE INDEX email_log_res ON email_log(reservation_id);

   CREATE TABLE reviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
     rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
     comment TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW}
   );

   -- Starting point: the one room type we can see in the photos. Room count is set in Setup.
   INSERT INTO room_types (code, name, total_rooms, base_occupancy, max_adults, max_children, max_occupancy)
     VALUES ('DLX', 'Deluxe Room', 0, 2, 2, 1, 3);
   INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default)
     VALUES ((SELECT id FROM room_types WHERE code = 'DLX'), 'EP', 'Room only', 'EP', 1);
   INSERT INTO settings (key, value) VALUES ('horizon_days', '365'), ('checkin_time', ''), ('checkout_time', ''), ('review_url', ''), ('notify_email', '');`,
];

(function migrate() {
  let v = Number(db.prepare('PRAGMA user_version').get().user_version);
  // Databases created before migrations existed already have the enquiries table.
  while (v < migrations.length) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${v + 1} failed: ${e.message}`);
    }
    v += 1;
  }
})();

/** Run fn inside one write transaction. node:sqlite is synchronous, so nothing interleaves. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

/* ---------- Settings ---------- */
export function getSettings() {
  return Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
}
export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value ?? ''));
}

/* ---------- Audit ---------- */
export function audit(staffId, action, summary, details) {
  run('INSERT INTO audit_log (staff_id, action, summary, details) VALUES (?, ?, ?, ?)', staffId ?? null, action, summary, details ? JSON.stringify(details) : null);
}

/* ---------- Short references (no 0/O/1/I so they read well on the phone) ---------- */
export function makeRef(prefix, len = 5) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return `${prefix}-${s}`;
}

/* ---------- Enquiries (leads) ---------- */
export const LEAD_STATUSES = ['new', 'contacted', 'booked', 'lost'];

const insertEnquiry = db.prepare(`
  INSERT INTO enquiries (ref, kind, name, phone, email, check_in, check_out, adults, children, rooms, room_type, message, source)
  VALUES (:ref, :kind, :name, :phone, :email, :check_in, :check_out, :adults, :children, :rooms, :room_type, :message, :source)
`);

export function createEnquiry(data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = makeRef('PIN');
    try {
      const r = insertEnquiry.run({ ...data, ref });
      return { id: Number(r.lastInsertRowid), ref };
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('Could not create a unique reference');
}

export function listEnquiries({ status, q, limit = 200 } = {}) {
  const where = [];
  const params = {};
  if (status && LEAD_STATUSES.includes(status)) { where.push('e.status = :status'); params.status = status; }
  if (q) { where.push('(e.name LIKE :q OR e.phone LIKE :q OR e.email LIKE :q OR e.ref LIKE :q)'); params.q = `%${q}%`; }
  params.limit = Math.min(Number(limit) || 200, 1000);
  return db.prepare(`
    SELECT e.*, r.reference AS reservation_ref
      FROM enquiries e LEFT JOIN reservations r ON r.id = e.reservation_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC, e.id DESC LIMIT :limit`).all(params);
}

export function countByStatus() {
  const rows = all('SELECT status, COUNT(*) AS n FROM enquiries GROUP BY status');
  return Object.fromEntries(LEAD_STATUSES.map((s) => [s, Number(rows.find((r) => r.status === s)?.n || 0)]));
}

export function updateEnquiry(id, { status, notes }) {
  const row = one('SELECT * FROM enquiries WHERE id = ?', id);
  if (!row) return null;
  run(`UPDATE enquiries SET status = ?, notes = ?, updated_at = ${NOW} WHERE id = ?`,
    status && LEAD_STATUSES.includes(status) ? status : row.status,
    notes === undefined ? row.notes : String(notes).slice(0, 2000),
    id);
  return one('SELECT * FROM enquiries WHERE id = ?', id);
}
