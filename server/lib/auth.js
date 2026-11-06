// Staff sign-in with roles (ported from hotelinventorysystem/src/extranet/auth.ts + passwords.ts).
//   owner     : everything, including staff accounts and settings
//   manager   : inventory, rates, bookings, leads
//   frontdesk : leads and bookings only (no rate, inventory or setup changes)
// Passwords use scrypt. Tokens are signed and carry token_version, so changing a password
// or deactivating someone signs them out everywhere.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one, all, run, audit } from './db.js';
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
export function bootstrapOwner() {
  if (Number(one('SELECT COUNT(*) AS n FROM staff').n) > 0) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn('[auth] No staff accounts and ADMIN_PASSWORD not set; the admin panel is locked.');
    return;
  }
  const email = (process.env.ADMIN_EMAIL || site.email).toLowerCase();
  run("INSERT INTO staff (email, name, role, password_hash) VALUES (?, 'Owner', 'owner', ?)", email, hashPassword(pw));
  console.log(`[auth] Created owner account ${email} from ADMIN_PASSWORD.`);
}

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function login(email, password) {
  const user = one('SELECT * FROM staff WHERE email = ?', String(email || '').trim());
  if (user?.locked_until && user.locked_until > new Date().toISOString()) {
    throw new AppError('RATE_LIMITED', `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}.`);
  }
  // Always run scrypt so response time does not reveal whether the email exists.
  const ok = verifyPassword(String(password || ''), user?.password_hash || DUMMY) && user && user.is_active;
  if (!ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
      run('UPDATE staff SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
    }
    throw new AppError('UNAUTHORIZED', 'Wrong email or password.');
  }
  run("UPDATE staff SET failed_logins = 0, locked_until = NULL, last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", user.id);
  audit(user.id, 'LOGIN', `${user.name} signed in`);
  const payload = Buffer.from(JSON.stringify({ uid: user.id, v: user.token_version, exp: Date.now() + TTL_MS })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, user: publicUser(user) };
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isActive: !!u.is_active, lastLoginAt: u.last_login_at });

/** Express middleware factory: requireStaff('manager') lets managers and owners through. */
export function requireStaff(minRole = 'frontdesk') {
  return (req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const [payload, sig] = token.split('.');
    if (payload && sig && same(sig, sign(payload))) {
      try {
        const t = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const u = t.exp > Date.now() && one('SELECT * FROM staff WHERE id = ?', t.uid);
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
export const listStaff = () => all('SELECT * FROM staff ORDER BY is_active DESC, role, name').map(publicUser);

export function createStaff(byId, b) {
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AppError('VALIDATION_ERROR', 'Check the email');
  if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Name is needed');
  if (!ROLES.includes(b.role)) throw new AppError('VALIDATION_ERROR', 'Choose a role');
  checkStrength(b.password);
  if (one('SELECT 1 FROM staff WHERE email = ?', email)) throw new AppError('CONFLICT', 'That email already has an account');
  run('INSERT INTO staff (email, name, role, password_hash) VALUES (?, ?, ?, ?)', email, name, b.role, hashPassword(b.password));
  audit(byId, 'STAFF', `Added ${name} (${b.role})`);
}

export function updateStaff(byId, id, b) {
  const u = one('SELECT * FROM staff WHERE id = ?', id);
  if (!u) throw new AppError('NOT_FOUND', 'Account not found');
  const role = b.role === undefined ? u.role : b.role;
  if (!ROLES.includes(role)) throw new AppError('VALIDATION_ERROR', 'Choose a role');
  const active = b.isActive === undefined ? u.is_active : b.isActive ? 1 : 0;
  if (u.role === 'owner' && (role !== 'owner' || !active)) {
    const owners = Number(one("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND is_active = 1").n);
    if (owners <= 1) throw new AppError('CONFLICT', 'There must always be one active owner');
  }
  let hash = u.password_hash;
  let bump = role !== u.role || active !== u.is_active;
  if (b.password) { checkStrength(b.password); hash = hashPassword(b.password); bump = true; }
  run('UPDATE staff SET role = ?, is_active = ?, password_hash = ?, token_version = token_version + ?, failed_logins = 0, locked_until = NULL WHERE id = ?',
    role, active, hash, bump ? 1 : 0, id);
  audit(byId, 'STAFF', `Updated ${u.name}${b.password ? ': password reset' : ''}${role !== u.role ? `: role ${role}` : ''}${active !== u.is_active ? (active ? ': reactivated' : ': deactivated') : ''}`);
}

export function changeOwnPassword(id, current, next) {
  const u = one('SELECT * FROM staff WHERE id = ?', id);
  if (!u || !verifyPassword(String(current || ''), u.password_hash)) throw new AppError('UNAUTHORIZED', 'Current password is wrong');
  checkStrength(next);
  run('UPDATE staff SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', hashPassword(next), id);
  audit(id, 'STAFF', `${u.name} changed their password`);
}
