// Staff sign-in (ported from hotelinventorysystem/src/extranet/auth.ts + passwords.ts).
//
// - Email + password (scrypt). 5 wrong passwords lock the account for 15 minutes.
// - The session token lives in an HttpOnly, SameSite=Strict cookie, so page scripts cannot
//   read it. Only its sha256 is stored (sessions collection, expired ones removed by a TTL index).
// - Every state-changing request must carry "X-Pinus-Admin: 1". Browsers will not send a custom
//   header cross-site without a CORS preflight we never allow, so with SameSite=Strict this
//   blocks CSRF.
// - Roles are checked against the database on every request (owner > manager > frontdesk), and
//   password changes, role changes and deactivation sign the person out everywhere at once.
// - Forgot password and staff invites use one-time links (sha256 stored, 30 min / 7 days).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { col, nextId, nowIso, audit } from './db.js';
import { site } from './site.js';
import { AppError } from './errors.js';

export const ROLES = ['owner', 'manager', 'frontdesk'];
const RANK = { frontdesk: 1, manager: 2, owner: 3 };
export const COOKIE = 'pinus_session';
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const RESET_MIN = 30;
const INVITE_DAYS = 7;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/* ---------- Passwords ---------- */
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
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/* ---------- Indexes ---------- */
let indexed = null;
function ensureIndexes() {
  indexed ??= Promise.all([
    col('sessions').createIndexes([{ key: { expires_at: 1 }, expireAfterSeconds: 0 }, { key: { staff_id: 1 } }]),
    col('password_tokens').createIndexes([{ key: { expires_at: 1 }, expireAfterSeconds: 0 }, { key: { staff_id: 1 } }]),
  ]).catch((e) => { indexed = null; throw e; });
  return indexed;
}

const newStaff = (id, email, name, role, hash) => ({
  _id: id, email, name, role, password_hash: hash, is_active: true, failed_logins: 0, locked_until: null,
  last_login_at: null, password_set: !!hash, created_at: nowIso(),
});
const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name, role: u.role, isActive: !!u.is_active, lastLoginAt: u.last_login_at, invited: !u.password_hash });

/** First run: create the owner account from ADMIN_PASSWORD (and ADMIN_EMAIL) if nobody exists yet. */
export async function bootstrapOwner() {
  await ensureIndexes();
  if (await col('staff').countDocuments({}, { limit: 1 })) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    console.warn('[auth] No staff accounts and ADMIN_PASSWORD not set; nobody can sign in yet.');
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

export async function hasStaff() {
  return (await col('staff').countDocuments({}, { limit: 1 })) > 0;
}

/* ---------- Sessions ---------- */
export async function login(email, password, { remember, ip, userAgent } = {}) {
  const user = await col('staff').findOne({ email: String(email || '').trim().toLowerCase() });
  // Always run scrypt so response time does not reveal whether the email exists.
  const ok = verifyPassword(String(password || ''), user?.password_hash || DUMMY);
  const generic = new AppError('UNAUTHORIZED', 'Wrong email or password.');
  if (!user || !user.is_active || !user.password_hash) throw generic;
  if (user.locked_until && user.locked_until > nowIso()) {
    throw new AppError('RATE_LIMITED', `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}, or reset your password.`);
  }
  if (!ok) {
    const fails = (user.failed_logins || 0) + 1;
    const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
    await col('staff').updateOne({ _id: user._id }, { $set: { failed_logins: lock ? 0 : fails, locked_until: lock } });
    if (lock) await audit(user._id, 'LOGIN_LOCKED', `${user.name}: locked for ${LOCK_MIN} minutes after ${MAX_FAILS} wrong passwords`);
    throw generic;
  }
  await ensureIndexes();
  const token = newToken();
  const expires = new Date(Date.now() + (remember ? REMEMBER_DAYS * 864e5 : SESSION_HOURS * 3600e3));
  await col('sessions').insertOne({ _id: sha(token), staff_id: user._id, expires_at: expires, remember: !!remember, created_at: nowIso(), ip: ip || null, user_agent: String(userAgent || '').slice(0, 300) });
  await col('staff').updateOne({ _id: user._id }, { $set: { failed_logins: 0, locked_until: null, last_login_at: nowIso() } });
  await audit(user._id, 'LOGIN', `${user.name} signed in${remember ? ' (kept signed in on this device)' : ''}`);
  return { token, expires, remember: !!remember, user: publicUser(user) };
}

export async function logout(token, { everywhere = false } = {}) {
  if (!token) return;
  const s = await col('sessions').findOne({ _id: sha(token) });
  if (!s) return;
  if (everywhere) await col('sessions').deleteMany({ staff_id: s.staff_id });
  else await col('sessions').deleteOne({ _id: s._id });
}

const endSessions = (staffId) => col('sessions').deleteMany({ staff_id: staffId });

export function setCookie(res, token, expires, remember) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    path: '/api/admin',
    ...(remember ? { expires } : {}), // without "remember", the cookie ends when the browser closes
  });
}
export const clearCookie = (res) => res.clearCookie(COOKIE, { path: '/api/admin' });

export function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Middleware factory: requireStaff('manager') lets managers and owners through. */
export function requireStaff(minRole = 'frontdesk') {
  return async (req, res, next) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method) && req.get('x-pinus-admin') !== '1') return res.status(403).json({ error: 'Missing request header.' });
      const token = readCookie(req);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(401).json({ error: 'Please sign in.' });
      const s = await col('sessions').findOne({ _id: sha(token), expires_at: { $gt: new Date() } });
      const u = s && await col('staff').findOne({ _id: s.staff_id, is_active: true });
      if (!u) {
        clearCookie(res);
        return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
      }
      if (RANK[u.role] < RANK[minRole]) return res.status(403).json({ error: 'Your role cannot do this.' });
      req.staff = publicUser(u);
      req.sessionToken = token;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/* ---------- One-time links: forgot password and invites ---------- */
async function issueLink(staffId, kind) {
  await ensureIndexes();
  await col('password_tokens').deleteMany({ staff_id: staffId });
  const token = newToken();
  const ms = kind === 'invite' ? INVITE_DAYS * 864e5 : RESET_MIN * 60000;
  await col('password_tokens').insertOne({ _id: sha(token), staff_id: staffId, kind, expires_at: new Date(Date.now() + ms), created_at: nowIso() });
  return token;
}

/** Returns { user, token } when the email belongs to an active account, else null (caller answers the same either way). */
export async function startPasswordReset(email) {
  const user = await col('staff').findOne({ email: String(email || '').trim().toLowerCase(), is_active: true });
  if (!user) return null;
  const token = await issueLink(user._id, 'reset');
  await audit(user._id, 'PASSWORD_RESET_REQUESTED', `${user.name} asked for a password reset link`);
  return { user: publicUser(user), token };
}

export async function checkLink(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const t = await col('password_tokens').findOne({ _id: sha(token), expires_at: { $gt: new Date() } });
  if (!t) return null;
  const u = await col('staff').findOne({ _id: t.staff_id, is_active: true });
  return u ? { kind: t.kind, name: u.name, email: u.email } : null;
}

/** Sets a new password from a reset or invite link. The link works once. */
export async function completePasswordLink(token, password) {
  checkStrength(password);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('NOT_FOUND', 'This link is not valid. Ask for a new one.');
  const t = await col('password_tokens').findOneAndDelete({ _id: sha(token), expires_at: { $gt: new Date() } });
  if (!t) throw new AppError('NOT_FOUND', 'This link has expired or was already used. Ask for a new one.');
  const u = await col('staff').findOne({ _id: t.staff_id, is_active: true });
  if (!u) throw new AppError('NOT_FOUND', 'This account is no longer active.');
  await col('staff').updateOne({ _id: u._id }, { $set: { password_hash: hashPassword(password), password_set: true, failed_logins: 0, locked_until: null } });
  await endSessions(u._id);
  await audit(u._id, 'PASSWORD_SET', `${u.name} ${t.kind === 'invite' ? 'accepted the invite and set a password' : 'reset their password'}`);
  return { email: u.email };
}

/* ---------- Staff management (owner only) ---------- */
export const listStaff = async () => (await col('staff').find().sort({ is_active: -1, role: 1, name: 1 }).toArray()).map(publicUser);

/** Adds a staff member with a password, or (invite: true) with an emailed link to set their own. */
export async function createStaff(byId, b) {
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  if (!validEmail(email)) throw new AppError('VALIDATION_ERROR', 'Check the email');
  if (name.length < 2) throw new AppError('VALIDATION_ERROR', 'Name is needed');
  if (!ROLES.includes(b.role)) throw new AppError('VALIDATION_ERROR', 'Choose a role');
  if (!b.invite) checkStrength(b.password);
  if (await col('staff').findOne({ email })) throw new AppError('CONFLICT', 'That email already has an account');
  const id = await nextId('staff');
  await col('staff').insertOne(newStaff(id, email, name, b.role, b.invite ? null : hashPassword(b.password)));
  await audit(byId, 'STAFF', `Added ${name} (${b.role})${b.invite ? ', invite emailed' : ''}`);
  return { user: publicUser(await col('staff').findOne({ _id: id })), inviteToken: b.invite ? await issueLink(id, 'invite') : null };
}

export async function reinvite(byId, id) {
  const u = await col('staff').findOne({ _id: id, is_active: true });
  if (!u) throw new AppError('NOT_FOUND', 'Account not found');
  await audit(byId, 'STAFF', `Sent a new sign-in link to ${u.name}`);
  return { user: publicUser(u), token: await issueLink(id, u.password_set ? 'reset' : 'invite') };
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
  const set = { role, is_active: active, failed_logins: 0, locked_until: null };
  if (b.password) { checkStrength(b.password); set.password_hash = hashPassword(b.password); set.password_set = true; }
  await col('staff').updateOne({ _id: id }, { $set: set });
  // Anything that changes what someone may do signs them out everywhere.
  if (b.password || role !== u.role || active !== !!u.is_active) await endSessions(id);
  await audit(byId, 'STAFF', `Updated ${u.name}${b.password ? ': password reset' : ''}${role !== u.role ? `: role ${role}` : ''}${active !== !!u.is_active ? (active ? ': reactivated' : ': deactivated') : ''}`);
}

export async function changeOwnPassword(id, current, next, keepToken) {
  const u = await col('staff').findOne({ _id: id });
  if (!u || !verifyPassword(String(current || ''), u.password_hash || DUMMY)) throw new AppError('UNAUTHORIZED', 'Current password is wrong');
  checkStrength(next);
  await col('staff').updateOne({ _id: id }, { $set: { password_hash: hashPassword(next), password_set: true } });
  // Sign out every other device; this one stays signed in.
  await col('sessions').deleteMany({ staff_id: id, _id: { $ne: sha(keepToken || '') } });
  await audit(id, 'STAFF', `${u.name} changed their password`);
}

export async function listSessions(staffId, currentToken) {
  const rows = await col('sessions').find({ staff_id: staffId, expires_at: { $gt: new Date() } }).sort({ created_at: -1 }).toArray();
  const cur = currentToken ? sha(currentToken) : '';
  return rows.map((s) => ({ current: s._id === cur, created_at: s.created_at, expires_at: s.expires_at, remember: s.remember, ip: s.ip, device: s.user_agent }));
}
