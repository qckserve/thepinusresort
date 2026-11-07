// End-to-end API test: a throwaway MongoDB replica set, the real server, real HTTP calls.
//   npm test
// Emails are written to a temp folder (MAIL_PREVIEW_DIR) instead of being sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
// `t` is a session cookie ("pinus_session=..."), '' for none. Changes carry the admin header.
async function call(method, path, body, t = tok, { header = true } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(t ? { Cookie: t } : {}), ...(header ? { 'X-Pinus-Admin': '1' } : {}) };
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const set = r.headers.getSetCookie().find((c) => c.startsWith('pinus_session='));
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), cookie: set ? set.split(';')[0] : null, setCookie: set };
}
const signIn = async (email, password, extra = {}) => call('POST', '/admin/login', { email, password, ...extra }, '');

before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = rs.getUri();
  mongo = await MongoClient.connect(uri);
  srv = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'pinus_test', PORT: String(PORT), ADMIN_PASSWORD: 'test-owner-pass', ADMIN_EMAIL: 'owner@example.com',
      SESSION_SECRET: 'test-secret', DISABLE_JOBS: '1', MAIL_PREVIEW_DIR: mails, PUBLIC_URL: 'http://localhost:5173', CRON_SECRET: 'cron-test-secret', NODE_ENV: 'test', LOGIN_LIMIT: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${B}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await signIn('owner@example.com', 'test-owner-pass');
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.match(login.setCookie, /HttpOnly/i);
  assert.match(login.setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(login.setCookie, /Expires/i, 'without "remember" the cookie ends with the browser');
  tok = login.cookie;
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
  const cron = async (secret) => (await fetch(`${B}/cron`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} })).status;
  assert.equal(await cron(''), 401);
  assert.equal(await cron('wrong'), 401);
  assert.equal(await cron('cron-test-secret'), 200);
});

test('roles and lockout', async () => {
  await call('POST', '/admin/staff', { email: 'desk@example.com', name: 'Desk', role: 'frontdesk', password: 'desk-password-1' });
  const desk = (await signIn('desk@example.com', 'desk-password-1')).cookie;
  assert.equal((await call('POST', '/admin/bulk', {}, desk)).status, 403);
  assert.equal((await call('GET', '/admin/calendar', null, desk)).status, 200);
  for (let i = 0; i < 5; i++) await signIn('desk@example.com', 'wrong');
  assert.equal((await signIn('desk@example.com', 'desk-password-1')).status, 429);
  const audit = await call('GET', '/admin/audit');
  assert.ok(audit.body.items.length > 5);
  const csv = await call('GET', '/admin/reservations.csv');
  assert.match(csv.body, /^Reference,Status/);
});

test('sessions: header required for changes, sign out really ends the session', async () => {
  assert.equal((await call('GET', '/admin/me', null, '')).status, 401);
  assert.equal((await call('POST', '/admin/bulk', {}, tok, { header: false })).status, 403, 'no CSRF header');
  assert.equal((await call('POST', '/admin/login', { email: 'owner@example.com', password: 'test-owner-pass' }, '', { header: false })).status, 403);
  const kept = await signIn('owner@example.com', 'test-owner-pass', { remember: true });
  assert.match(kept.setCookie, /Expires=/i, '"keep me signed in" sets a 30-day cookie');
  assert.equal((await call('GET', '/admin/me', null, kept.cookie)).status, 200);
  await call('POST', '/admin/logout', {}, kept.cookie);
  assert.equal((await call('GET', '/admin/me', null, kept.cookie)).status, 401, 'cookie no longer works after sign out');
  assert.equal((await call('GET', '/admin/me', null, 'pinus_session=forged-token-forged-token-forged-token-forg')).status, 401);
});

test('invite: owner adds staff, they set a password from the link and are signed in', async () => {
  const add = await call('POST', '/admin/staff', { email: 'manager@example.com', name: 'Mona Manager', role: 'manager', invite: true });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.link, null, 'emailed, so no link is handed back');
  const mona = add.body.items.find((u) => u.email === 'manager@example.com');
  assert.equal(mona.invited, true);
  assert.equal((await signIn('manager@example.com', 'anything-at-all')).status, 401, 'cannot sign in before setting a password');
  const file = readdirSync(mails).find((f) => f.includes('Your-sign-in-for'));
  assert.ok(file, 'invite email written');
  const token = decodeURIComponent(readFileSync(join(mails, file), 'utf8').match(/\?set=([A-Za-z0-9_%-]+)/)[1]);
  const info = await call('GET', `/admin/link?t=${token}`, null, '');
  assert.deepEqual(info.body, { kind: 'invite', name: 'Mona Manager', email: 'manager@example.com' });
  assert.equal((await call('POST', '/admin/link', { token, password: 'short' }, '')).status, 422);
  const done = await call('POST', '/admin/link', { token, password: 'mona-strong-pass' }, '');
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await call('GET', '/admin/me', null, done.cookie)).body.user.role, 'manager');
  assert.equal((await call('POST', '/admin/link', { token, password: 'mona-other-pass1' }, '')).status, 404, 'link works once');
});

test('forgot password: same answer for unknown emails, link resets and signs out old sessions', async () => {
  const before = readdirSync(mails).length;
  assert.deepEqual((await call('POST', '/admin/forgot', { email: 'nobody@example.com' }, '')).body, { ok: true, mailEnabled: true });
  const old = (await signIn('manager@example.com', 'mona-strong-pass')).cookie;
  assert.equal((await call('POST', '/admin/forgot', { email: 'manager@example.com' }, '')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const files = readdirSync(mails);
  assert.equal(files.length, before + 1, 'only the real account got an email');
  const file = files.find((f) => f.includes('Reset-your-password'));
  const token = decodeURIComponent(readFileSync(join(mails, file), 'utf8').match(/\?set=([A-Za-z0-9_%-]+)/)[1]);
  assert.equal((await call('POST', '/admin/link', { token, password: 'mona-new-password' }, '')).status, 200);
  assert.equal((await call('GET', '/admin/me', null, old)).status, 401, 'old sessions ended');
  assert.equal((await signIn('manager@example.com', 'mona-strong-pass')).status, 401);
  assert.equal((await signIn('manager@example.com', 'mona-new-password')).status, 200);
});

test('changing your own password signs out your other devices only', async () => {
  const a = (await signIn('manager@example.com', 'mona-new-password')).cookie;
  const b = (await signIn('manager@example.com', 'mona-new-password')).cookie;
  assert.equal((await call('POST', '/admin/me/password', { current: 'wrong', next: 'whatever-long-1' }, a)).status, 401);
  assert.equal((await call('POST', '/admin/me/password', { current: 'mona-new-password', next: 'mona-newest-pass' }, a)).status, 200);
  assert.equal((await call('GET', '/admin/me', null, a)).status, 200, 'this device stays in');
  assert.equal((await call('GET', '/admin/me', null, b)).status, 401, 'the other device is out');
  // Deactivating someone ends their sessions at once.
  const mona = (await call('GET', '/admin/staff')).body.items.find((u) => u.email === 'manager@example.com');
  await call('PATCH', `/admin/staff/${mona.id}`, { isActive: false });
  assert.equal((await call('GET', '/admin/me', null, a)).status, 401);
});

test('experience booking: request, validation, confirm, emails and Today', async () => {
  const bad = await call('POST', '/enquiries', { kind: 'activity', activity: 'skydiving', date: day(2), adults: 2, name: 'Zara Khan', phone: '+91 99000 11122', email: 'zara@example.com' }, '');
  assert.equal(bad.status, 422);
  assert.ok(bad.body.fields.activity);
  const tooMany = await call('POST', '/enquiries', { kind: 'activity', activity: 'fishing', date: day(2), adults: 25, name: 'Zara Khan', phone: '+91 99000 11122', email: 'zara@example.com' }, '');
  assert.equal(tooMany.status, 422, 'fishing takes at most 10');
  const req = await call('POST', '/enquiries', { kind: 'activity', activity: 'fishing', date: day(1), slot: 'Morning', adults: 2, children: 1, stayRef: 'tpr-abc123', name: 'Zara Khan', phone: '+91 99000 11122', email: 'zara@example.com', message: 'First time fishing' }, '');
  assert.equal(req.status, 201, JSON.stringify(req.body));
  await new Promise((r) => setTimeout(r, 300));
  const leads = await call('GET', '/admin/enquiries?kind=activity');
  const lead = leads.body.items.find((l) => l.ref === req.body.ref);
  assert.equal(lead.activity_name, 'Trout fishing on the Lidder');
  assert.equal(lead.slot, 'Morning');
  assert.equal(lead.stay_ref, 'TPR-ABC123');
  assert.ok(leads.body.items.every((l) => l.kind === 'activity'), 'type filter works');
  const files = readdirSync(mails).join(' ');
  assert.ok(files.includes('New-experience-request'), 'admin alerted');
  assert.ok(files.includes('We-have-your-experience-request'), 'guest acknowledged');
  const conf = await call('POST', `/admin/enquiries/${lead.id}/confirm-activity`, { date: day(1), time: '7:00 am pick-up', adults: 2, children: 1, amount: 3500, meeting: 'Resort reception', note: 'Bring warm layers.' });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.item.status, 'booked');
  assert.equal(conf.body.item.confirmed.amount_minor, 350000);
  await new Promise((r) => setTimeout(r, 200));
  const after = readdirSync(mails).join(' ');
  assert.ok(after.includes('Trout-fishing-on-the-Lidder-is-confirmed'), 'guest confirmation email');
  assert.ok(after.includes('Experience-confirmed'), 'admin copy');
  const dash = await call('GET', '/admin/dashboard');
  assert.ok(dash.body.experiences.some((x) => x.ref === req.body.ref), 'shows on Today');
  const notActivity = (await call('GET', '/admin/enquiries?kind=booking')).body.items[0];
  assert.equal((await call('POST', `/admin/enquiries/${notActivity.id}/confirm-activity`, {})).status, 409);
});
