// Staff sign-in with roles (ported from hotelinventorysystem/src/extranet/auth.ts + passwords.ts).
//   owner     : everything, including staff accounts and settings
//   manager   : inventory, rates, bookings, leads
//   frontdesk : leads and bookings only (no rate, inventory or setup changes)
// Passwords use scrypt. Tokens are signed and carry token_version, so changing a password
// or deactivating someone signs them out everywhere.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { col, nextId, nowIso, audit } from './db.js';
import { site } from './site.js';
import { AppError } from './errors.js';

const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MIN = 15;
export const ROLES = ['owner', 'manager', 'frontdesk'];
const RANK = { frontdesk: 1, manager: 2, owner: 3 };

if (!process.env.SESSION_SECRET) console.warn('[auth] SESSION_SECRET not set; staff sign-ins reset on every restart.');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(got, expected);
}
const DUMMY = hashPassword(randomBytes(12).toString('hex'));

function checkStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new AppError('VALIDATION_ERROR', 'Password must be at least 10 characters');
  if (pw.length > 200) throw new AppError('VALIDATION_ERROR', 'Password is too long');
}

/** First run: create the owner account from ADMIN_PASSWORD (and ADMIN_EMAIL) if nobody exists yet. */
export async function bootstrapOwner() {
  if (await col('staff').countDocuments({}, { limit: 1 })) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn('[auth] No staff accounts and ADMIN_PASSWORD not set; the admin panel is locked.');
    return;
  }
  const email = (process.env.ADMIN_EMAIL || site.email).toLowerCase();
  try {
    await col('staff').insertOne(newStaff(await nextId('staff'), email, 'Owner', 'owner', hashPassword(pw)));
    console.log(`[auth] Created owner account ${email} from ADMIN_PASSWORD.`);
  } catch (e) {
    if (e.code !== 11000) throw e; // another instance created it first
  }
}
const newStaff = (id, email, name, role, hash) => ({ _id: id, email, name, role, password_hash: hash, token_version: 1, is_active: true, failed_logins: 0, locked_until: null, last_login_at: null, created_at: nowIso() });

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function login(email, password) {
  const user = await col('staff').findOne({ email: String(email || '').trim().toLowerCase() });
  if (user?.locked_until && user.locked_until > new Date().toISOString()) {
    throw new AppError('RATE_LIMITED', `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}.`);
  }
  // Always run scrypt so response time does not reveal whether the email exists.
  const ok = verifyPassword(String(password || ''), user?.password_hash || DUMMY) && user && user.is_active;
  if (!ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
      await col('staff').updateOne({ _id: user._id }, { $set: { failed_logins: lock ? 0 : fails, locked_until: lock } });
    }
    throw new AppError('UNAUTHORIZED', 'Wrong email or password.');
  }
  await col('staff').updateOne({ _id: user._id }, { $set: { failed_logins: 0, locked_until: null, last_login_at: nowIso() } });
  await audit(user._id, 'LOGIN', `${user.name} signed in`);
  const payload = Buffer.from(JSON.stringify({ uid: user._id, v: user.token_version, exp: Date.now() + TTL_MS })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, user: publicUser(user) };
}

const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, isActive: !!u.is_active, lastLoginAt: u.last_login_at });

/** Express middleware factory: requireStaff('manager') lets managers and owners through. */
export function requireStaff(minRole = 'frontdesk') {
  return async (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const [payload, sig] = token.split('.');
    if (payload && sig && same(sig, sign(payload))) {
      try {
        const t = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const u = t.exp > Date.now() && await col('staff').findOne({ _id: t.uid });
        if (u && u.is_active && u.token_version === t.v) {
          if (RANK[u.role] < RANK[minRole]) return res.status(403).json({ error: 'Your role cannot do this.' });
          req.staff = publicUser(u);
          return next();
        }
      } catch {}
    }
    res.status(401).json({ error: 'Please sign in again.' });
  };
}

/* ---------- Staff management (owner only) ---------- */
export const listStaff = async () => (await col('staff').find().sort({ is_active: -1, role: 1, name: 1 }).toArray()).map(publicUser);

export async function createStaff(byId, b) {
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('VALIDATION_ERROR', 'Check the email');
  if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Name is needed');
  if (!ROLES.includes(b.role)) throw new AppError('VALIDATION_ERROR', 'Choose a role');
  checkStrength(b.password);
  if (await col('staff').findOne({ email })) throw new AppError('CONFLICT', 'That email already has an account');
  await col('staff').insertOne(newStaff(await nextId('staff'), email, name, b.role, hashPassword(b.password)));
  await audit(byId, 'STAFF', `Added ${name} (${b.role})`);
}

export async function updateStaff(byId, id, b) {
  const u = await col('staff').findOne({ _id: id });
  if (!u) throw new AppError('NOT_FOUND', 'Account not found');
  const role = b.role === undefined ? u.role : b.role;
  if (!ROLES.includes(role)) throw new AppError('VALIDATION_ERROR', 'Choose a role');
  const active = b.isActive === undefined ? !!u.is_active : !!b.isActive;
  if (u.role === 'owner' && (role !== 'owner' || !active)) {
    const owners = await col('staff').countDocuments({ role: 'owner', is_active: true });
    if (owners <= 1) throw new AppError('CONFLICT', 'There must always be one active owner');
  }
  let hash = u.password_hash;
  let bump = role !== u.role || active !== !!u.is_active;
  if (b.password) { checkStrength(b.password); hash = hashPassword(b.password); bump = true; }
  await col('staff').updateOne({ _id: id }, { $set: { role, is_active: active, password_hash: hash, failed_logins: 0, locked_until: null }, $inc: { token_version: bump ? 1 : 0 } });
  await audit(byId, 'STAFF', `Updated ${u.name}${b.password ? ': password reset' : ''}${role !== u.role ? `: role ${role}` : ''}${active !== !!u.is_active ? (active ? ': reactivated' : ': deactivated') : ''}`);
}

export async function changeOwnPassword(id, current, next) {
  const u = await col('staff').findOne({ _id: id });
  if (!u || !verifyPassword(String(current || ''), u.password_hash)) throw new AppError('UNAUTHORIZED', 'Current password is wrong');
  checkStrength(next);
  await col('staff').updateOne({ _id: id }, { $set: { password_hash: hashPassword(next) }, $inc: { token_version: 1 } });
  await audit(id, 'STAFF', `${u.name} changed their password`);
}
