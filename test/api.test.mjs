// End-to-end API test: a throwaway MongoDB replica set, the real server, real HTTP calls.
//   npm test
// Emails are written to a temp folder (MAIL_PREVIEW_DIR) instead of being sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { MongoClient } from 'mongodb';

const PORT = 8796;
const B = `http://127.0.0.1:${PORT}/api`;
const mails = mkdtempSync(join(tmpdir(), 'pinus-mails-'));
let rs;
let srv;
let log = '';
let tok = '';
let mongo;

const day = (n) => new Date(Date.now() + n * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
const T = day(3);
const T2 = day(5);
async function call(method, path, body, t = tok) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}

before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = rs.getUri();
  mongo = await MongoClient.connect(uri);
  srv = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'pinus_test', PORT: String(PORT), ADMIN_PASSWORD: 'test-owner-pass', ADMIN_EMAIL: 'owner@example.com',
      SESSION_SECRET: 'test-secret', DISABLE_JOBS: '1', MAIL_PREVIEW_DIR: mails, PUBLIC_URL: 'http://localhost:5173', CRON_SECRET: 'cron-test-secret', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${B}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await call('POST', '/admin/login', { email: 'owner@example.com', password: 'test-owner-pass' }, '');
  assert.equal(login.status, 200, JSON.stringify(login.body));
  tok = login.body.token;
});

after(async () => {
  srv?.kill();
  await mongo?.close();
  await rs?.stop();
  if (process.exitCode) console.log(log);
});

test('no rooms on sale until the owner sets a count', async () => {
  const r = await call('GET', `/availability?checkIn=${T}&checkOut=${T2}`, null, '');
  assert.deepEqual(r.body, { configured: false, available: null, roomTypes: [] });
});

test('rooms, derived rate plan and bulk prices', async () => {
  const rt = await call('PUT', '/admin/room-types/1', { totalRooms: 4 });
  assert.equal(rt.body.setup.roomTypes[0].totalRooms, 4);
  const rp = await call('POST', '/admin/rate-plans', { roomTypeId: 1, name: 'With breakfast', mealPlan: 'CP', rateMode: 'DERIVED', parentId: 1, deriveType: 'PERCENT', deriveValue: 20 });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  const bulk = await call('POST', '/admin/bulk', { from: day(0), to: day(60), roomTypeIds: [1], ratePlanIds: [1], set: { price: 5000, extraAdult: 800 } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.rateChanged, 61);
  const sat = await call('POST', '/admin/bulk', { from: day(0), to: day(60), weekdays: [6], ratePlanIds: [1], set: { minLos: 2 } });
  assert.ok(sat.body.rateChanged >= 8);
  const cal = await call('GET', `/admin/calendar?from=${T}&days=3`);
  const room = cal.body.roomTypes[0];
  assert.equal(room.days[0].left, 4);
  assert.deepEqual(room.ratePlans.map((p) => p.days[0].price), [5000, 6000]);
});

test('website lead needs an email, then becomes a confirmed booking', async () => {
  const noEmail = await call('POST', '/enquiries', { kind: 'booking', name: 'Asha Rao', phone: '+91 98765 43210', checkIn: T, checkOut: T2, adults: 2, rooms: 1 }, '');
  assert.equal(noEmail.status, 422);
  const lead = await call('POST', '/enquiries', { kind: 'booking', name: 'Asha Rao', phone: '+91 98765 43210', email: 'asha@example.com', checkIn: T, checkOut: T2, adults: 2, children: 1, rooms: 1, roomType: 'Deluxe Room' }, '');
  assert.equal(lead.status, 201);
  const q = await call('POST', '/admin/quote', { roomTypeId: 1, checkIn: T, checkOut: T2, rooms: 1, adults: 3 });
  assert.equal(q.body.ok, false, 'Deluxe Room holds 2 adults');
  const c = await call('POST', '/admin/reservations', { enquiryId: 1, roomTypeId: 1, source: 'WEBSITE', checkIn: T, checkOut: T2, rooms: 1, adults: 2, children: 1, guestName: 'Asha Rao', guestEmail: 'asha@example.com' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.item.status, 'CONFIRMED');
  assert.equal(c.body.item.amount_minor, 1000000);
  assert.deepEqual(c.body.item.emails.map((e) => e.kind).sort(), ['confirm_admin', 'confirm_guest']);
  const again = await call('POST', '/admin/reservations', { enquiryId: 1, roomTypeId: 1, source: 'WEBSITE', checkIn: T, checkOut: T2, guestName: 'Asha Rao' });
  assert.equal(again.status, 409);
  const leads = await call('GET', '/admin/enquiries');
  assert.equal(leads.body.items[0].status, 'booked');
  assert.equal(leads.body.items[0].reservation_ref, c.body.item.reference);
});

test('two guests racing for the last room: exactly one wins', async () => {
  // 3 rooms left on these nights; book 2 so 1 is left, then race.
  const two = await call('POST', '/admin/reservations', { roomTypeId: 1, source: 'PHONE', checkIn: T, checkOut: T2, rooms: 2, adults: 4, guestName: 'Group' });
  assert.equal(two.status, 200, JSON.stringify(two.body));
  const race = await Promise.all([1, 2, 3, 4, 5].map((i) => call('POST', '/admin/reservations', { roomTypeId: 1, source: 'WALK_IN', checkIn: T, checkOut: T2, rooms: 1, guestName: `Racer ${i}` })));
  assert.equal(race.filter((r) => r.status === 200).length, 1, JSON.stringify(race.map((r) => [r.status, r.body.error])));
  const cal = await call('GET', `/admin/calendar?from=${T}&days=2`);
  assert.deepEqual(cal.body.roomTypes[0].days.map((d) => [d.left, d.sold]), [[0, 4], [0, 4]]);
});

test('cancel gives nights back exactly once; illegal moves are refused', async () => {
  const id = 1;
  const cx = await call('POST', `/admin/reservations/${id}/status`, { status: 'CANCELLED' });
  assert.equal(cx.body.item.status, 'CANCELLED');
  assert.equal((await call('POST', `/admin/reservations/${id}/status`, { status: 'CHECKED_IN' })).status, 409);
  await call('POST', `/admin/reservations/${id}/status`, { status: 'CANCELLED' });
  const cal = await call('GET', `/admin/calendar?from=${T}&days=2`);
  assert.deepEqual(cal.body.roomTypes[0].days.map((d) => d.left), [1, 1]);
  assert.equal((await call('POST', '/admin/reset-availability', {})).body.changed, 0);
});

test('day-before-checkout and review emails go out once, review page works', async () => {
  const w = await call('POST', '/admin/reservations', { roomTypeId: 1, source: 'WALK_IN', checkIn: day(0), checkOut: day(1), rooms: 1, guestName: 'Ravi Kumar', guestEmail: 'ravi@example.com' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  await call('POST', `/admin/reservations/${w.body.item.id}/status`, { status: 'CHECKED_IN' });
  assert.equal((await call('POST', '/admin/jobs/run', {})).body.preCheckout, 1);
  assert.equal((await call('POST', '/admin/jobs/run', {})).body.preCheckout, 0);
  await call('POST', `/admin/reservations/${w.body.item.id}/status`, { status: 'CHECKED_OUT' });
  const jobs = await call('POST', '/admin/jobs/run', {});
  assert.ok(jobs.body.reviews === 1 || jobs.body.busy, JSON.stringify(jobs.body));
  const doc = await mongo.db('pinus_test').collection('reservations').findOne({ _id: w.body.item.id });
  assert.ok(doc.review_sent_at, 'review request recorded');
  const page = await call('GET', `/review?t=${doc.review_token}`, null, '');
  assert.equal(page.body.name, 'Ravi');
  assert.equal((await call('POST', '/reviews', { token: doc.review_token, rating: 9 }, '')).status, 422);
  assert.equal((await call('POST', '/reviews', { token: doc.review_token, rating: 5, comment: 'Lovely pine room.' }, '')).status, 200);
  const reviews = await call('GET', '/admin/reviews');
  assert.equal(reviews.body.items[0].rating, 5);
  const kinds = readdirSync(mails).join(' ');
  for (const k of ['New-booking-request', 'We-have-your-booking-request', 'Your-booking-is-confirmed', 'Check-out-tomorrow', 'Your-check-out-tomorrow', 'How-was-your-stay']) {
    assert.ok(kinds.includes(k), `email written: ${k}`);
  }
});

test('cron endpoint needs the secret', async () => {
  assert.equal((await call('GET', '/cron', null, '')).status, 401);
  assert.equal((await call('GET', '/cron', null, 'wrong')).status, 401);
  assert.equal((await call('GET', '/cron', null, 'cron-test-secret')).status, 200);
});

test('roles and lockout', async () => {
  await call('POST', '/admin/staff', { email: 'desk@example.com', name: 'Desk', role: 'frontdesk', password: 'desk-password-1' });
  const desk = (await call('POST', '/admin/login', { email: 'desk@example.com', password: 'desk-password-1' }, '')).body.token;
  assert.equal((await call('POST', '/admin/bulk', {}, desk)).status, 403);
  assert.equal((await call('GET', '/admin/calendar', null, desk)).status, 200);
  for (let i = 0; i < 5; i++) await call('POST', '/admin/login', { email: 'desk@example.com', password: 'wrong' }, '');
  assert.equal((await call('POST', '/admin/login', { email: 'desk@example.com', password: 'desk-password-1' }, '')).status, 429);
  const audit = await call('GET', '/admin/audit');
  assert.ok(audit.body.items.length > 5);
  const csv = await call('GET', '/admin/reservations.csv');
  assert.match(csv.body, /^Reference,Status/);
});
