// MongoDB data layer.
//   Production / Vercel : MONGODB_URI (MongoDB Atlas), database MONGODB_DB (default "thepinus")
//   Local development   : the replica set started by scripts/dev-mongo.mjs (npm run dev)
// Bookings use multi-document transactions, which Atlas supports on every tier.
// Documents keep numeric ids (from the counters collection) and snake_case fields so the
// admin and the API look the same as before.
import { MongoClient } from 'mongodb';
import { AppError } from './errors.js';

const LOCAL_URI = `mongodb://127.0.0.1:${process.env.DEV_MONGO_PORT || 27027}/?replicaSet=pinus`;
const uri = process.env.MONGODB_URI || (process.env.VERCEL || process.env.NODE_ENV === 'production' ? null : LOCAL_URI);
const dbName = process.env.MONGODB_DB || 'thepinus';

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

let clientPromise = null;
let db = null;
let client = null;

async function connect() {
  if (!uri) throw new AppError('NOT_CONFIGURED', 'Database not configured. Set MONGODB_URI in the server settings.');
  const c = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8_000, appName: 'thepinus' });
  try {
    await c.connect();
  } catch (e) {
    await c.close().catch(() => {});
    throw dbError(e);
  }
  if (process.env.VERCEL) {
    // Lets Vercel Fluid Compute close idle connections cleanly when an instance is suspended.
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(c);
  }
  return c;
}

/**
 * Turns a connection failure into a clear reason. The message never contains the password.
 *   auth    : wrong user name or password in MONGODB_URI
 *   dns     : the cluster address in MONGODB_URI is wrong
 *   network : Atlas refused or dropped the connection, usually Network Access (IP Access List)
 */
function dbError(e) {
  const m = `${e?.message || ''} ${e?.cause?.message || ''} ${e?.reason?.error?.message || ''}`;
  let reason = 'network';
  if (/bad auth|authentication failed|auth error|SCRAM/i.test(m) || e?.code === 8000 || e?.code === 18) reason = 'auth';
  else if (/ENOTFOUND|querySrv|EAI_AGAIN|Invalid scheme|Invalid connection string|URI must/i.test(m)) reason = 'dns';
  console.error(`[db] cannot connect (${reason}): ${m.replace(/\/\/[^@\s]+@/g, '//<user>:<password>@').trim().slice(0, 300)}`);
  const help = {
    auth: 'MongoDB rejected the user name or password in MONGODB_URI. Reset the password in Atlas (Database & Network Access > Database Users), put it in MONGODB_URI without the < >, and redeploy.',
    dns: 'The cluster address in MONGODB_URI looks wrong. Copy it again from Atlas (Clusters > Connect > Drivers) and redeploy.',
    network: 'MongoDB Atlas is blocking this server. In Atlas open Database & Network Access > IP Access List, add 0.0.0.0/0 (Allow access from anywhere), wait a minute and reload.',
  }[reason];
  return new AppError('DB_UNREACHABLE', help, { reason });
}

/** Connects once, creates indexes and seed data. Every request awaits this. */
export function ready() {
  if (!clientPromise) {
    clientPromise = (async () => {
      client = await connect();
      db = client.db(dbName);
      await setup();
      return db;
    })().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

/** Collection accessor: col('reservations'). Only valid after ready(). */
export const col = (name) => db.collection(name);

/** Next numeric id for a collection (atomic). */
export async function nextId(name, session) {
  const r = await col('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
  return r.seq;
}

/** Run fn(session) in a transaction; the driver retries it on transient write conflicts. */
export async function tx(fn) {
  const session = client.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return out;
  } finally {
    await session.endSession();
  }
}

/** Mongo document -> API object: _id becomes id. */
export const pub = (doc) => {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

/* ---------- Indexes and seed data ---------- */
async function setup() {
  await Promise.all([
    col('enquiries').createIndexes([{ key: { ref: 1 }, unique: true }, { key: { status: 1, created_at: -1 } }, { key: { created_at: -1 } }]),
    col('staff').createIndex({ email: 1 }, { unique: true }),
    col('room_types').createIndex({ code: 1 }, { unique: true }),
    col('rate_plans').createIndexes([{ key: { room_type_id: 1, code: 1 }, unique: true }, { key: { parent_id: 1 } }]),
    col('daily_inventory').createIndex({ room_type_id: 1, stay_date: 1 }, { unique: true }),
    col('daily_rates').createIndex({ rate_plan_id: 1, stay_date: 1 }, { unique: true }),
    col('reservations').createIndexes([
      { key: { reference: 1 }, unique: true },
      { key: { review_token: 1 }, unique: true, sparse: true },
      { key: { check_in: 1 } },
      { key: { check_out: 1, status: 1 } },
      { key: { room_type_id: 1, check_in: 1 } },
    ]),
    col('audit_log').createIndex({ created_at: -1 }),
    col('email_log').createIndexes([{ key: { reservation_id: 1 } }, { key: { created_at: -1 } }]),
  ]);
  await col('settings').updateOne(
    { _id: 'main' },
    { $setOnInsert: { horizon_days: 365, checkin_time: '', checkout_time: '', review_url: '', notify_email: '', last_roll: '' } },
    { upsert: true },
  );
  // Starting point: the one room type we can see in the photos. Only the first instance to
  // claim the "seeded" marker inserts it. The room count is set in the admin.
  try {
    await col('counters').insertOne({ _id: 'seeded', seq: 1 });
  } catch (e) {
    if (e.code === 11000) return;
    throw e;
  }
  const rtId = await nextId('room_types');
  await col('room_types').insertOne({ _id: rtId, code: 'DLX', name: 'Deluxe Room', total_rooms: 0, base_occupancy: 2, max_adults: 2, max_children: 1, max_occupancy: 3, sort_order: 0, is_active: true, created_at: nowIso() });
  await col('rate_plans').insertOne({
    _id: await nextId('rate_plans'), room_type_id: rtId, code: 'EP', name: 'Room only', meal_plan: 'EP', is_default: true,
    rate_mode: 'MANUAL', parent_id: null, derive_type: null, derive_value: null, follow_parent_restrictions: true, is_active: true,
  });
}

/* ---------- Settings ---------- */
export async function getSettings(session) {
  return (await col('settings').findOne({ _id: 'main' }, { session })) || {};
}
export function setSettings(values, session) {
  return col('settings').updateOne({ _id: 'main' }, { $set: values }, { upsert: true, session });
}

/* ---------- Audit ---------- */
export function audit(staffId, action, summary, details, session) {
  return col('audit_log').insertOne({ staff_id: staffId ?? null, action, summary, details: details ?? null, created_at: nowIso() }, { session });
}

/* ---------- Short references (no 0/O/1/I so they read well on the phone) ---------- */
export function makeRef(prefix, len = 5) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return `${prefix}-${s}`;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const searchRe = (q) => new RegExp(escRe(String(q).slice(0, 80)), 'i');

/* ---------- Enquiries (leads) ---------- */
export const LEAD_STATUSES = ['new', 'contacted', 'booked', 'lost'];

export async function createEnquiry(data) {
  const id = await nextId('enquiries');
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = makeRef('PIN');
    try {
      const now = nowIso();
      await col('enquiries').insertOne({ _id: id, ref, ...data, status: 'new', notes: null, reservation_id: null, created_at: now, updated_at: now });
      return { id, ref };
    } catch (e) {
      if (e.code !== 11000 || !String(e.message).includes('ref')) throw e;
    }
  }
  throw new Error('Could not create a unique reference');
}

export async function listEnquiries({ status, kind, q, limit = 200 } = {}) {
  const filter = {};
  if (['booking', 'activity', 'contact'].includes(kind)) filter.kind = kind;
  if (status && LEAD_STATUSES.includes(status)) filter.status = status;
  if (q) {
    const re = searchRe(q);
    filter.$or = [{ name: re }, { phone: re }, { email: re }, { ref: re }];
  }
  const rows = await col('enquiries').find(filter).sort({ created_at: -1, _id: -1 }).limit(Math.min(Number(limit) || 200, 1000)).toArray();
  const resIds = rows.map((r) => r.reservation_id).filter(Boolean);
  const refs = new Map((await col('reservations').find({ _id: { $in: resIds } }, { projection: { reference: 1 } }).toArray()).map((r) => [r._id, r.reference]));
  return rows.map((r) => ({ ...pub(r), reservation_ref: refs.get(r.reservation_id) ?? null }));
}

export async function countByStatus(kind) {
  const match = ['booking', 'activity', 'contact'].includes(kind) ? [{ $match: { kind } }] : [];
  const rows = await col('enquiries').aggregate([...match, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  return Object.fromEntries(LEAD_STATUSES.map((s) => [s, rows.find((r) => r._id === s)?.n || 0]));
}

export async function updateEnquiry(id, { status, notes }) {
  const set = { updated_at: nowIso() };
  if (status && LEAD_STATUSES.includes(status)) set.status = status;
  if (notes !== undefined) set.notes = String(notes).slice(0, 2000);
  return pub(await col('enquiries').findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' }));
}

/** Confirm an experience request: store the agreed details and mark the lead booked. */
export async function confirmActivity(id, staffId, b) {
  const e = await col('enquiries').findOne({ _id: id });
  if (!e) throw new AppError('NOT_FOUND', 'Lead not found');
  if (e.kind !== 'activity') throw new AppError('CONFLICT', 'This lead is not an experience request');
  const date = String(b.date || e.check_in || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('VALIDATION_ERROR', 'Choose a date', { fields: { date: 'Choose a date' } });
  const n = (v, min, max, d) => { const x = v === '' || v == null ? d : Number(v); if (!Number.isInteger(x) || x < min || x > max) throw new AppError('VALIDATION_ERROR', 'Check the number of people'); return x; };
  const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000)) throw new AppError('VALIDATION_ERROR', 'Price must be an amount in rupees');
  const clip = (v, m) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, m) : null);
  const confirmed = {
    date, time: clip(b.time, 60) || e.slot, adults: n(b.adults, 1, 60, e.adults), children: n(b.children, 0, 40, e.children || 0),
    amount_minor: amount == null ? null : Math.round(amount * 100), meeting: clip(b.meeting, 200), note: clip(b.note, 600),
    at: nowIso(), by: staffId ?? null,
  };
  await col('enquiries').updateOne({ _id: id }, { $set: { status: 'booked', confirmed, updated_at: nowIso() } });
  await audit(staffId, 'ACTIVITY_CONFIRM', `${e.ref} ${e.name}: ${e.activity_name} on ${date}${confirmed.time ? `, ${confirmed.time}` : ''}`);
  return pub(await col('enquiries').findOne({ _id: id }));
}
