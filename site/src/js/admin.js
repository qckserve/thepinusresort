// The Pinus Resort admin: leads, bookings, inventory calendar, rooms and rates, reviews, emails, staff.
// Plain JS against /api/admin. The session lives in an HttpOnly cookie the page cannot read;
// every request sends the X-Pinus-Admin header the server requires for changes.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const HEADERS = { 'Content-Type': 'application/json', 'X-Pinus-Admin': '1' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (n) => `<svg class="icon"><use href="#i-${n}"/></svg>`;
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const dt = (s, o = {}) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC', ...o }) : '');
const dty = (s) => dt(s, { year: 'numeric' });
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const inr = (minor) => (minor == null ? '' : `INR ${(minor / 100).toLocaleString('en-IN')}`);
const wa = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length === 10 ? `91${d}` : d; };
const SRC = { WEBSITE: 'Website', WALK_IN: 'Walk-in', PHONE: 'Phone', WHATSAPP: 'WhatsApp', TRAVEL_AGENT: 'Travel agent', OTHER_OTA: 'Other OTA', OTHER: 'Other' };
const ST = { CONFIRMED: 'Confirmed', CHECKED_IN: 'Checked in', CHECKED_OUT: 'Checked out', CANCELLED: 'Cancelled', NO_SHOW: 'No-show' };
const NEXT = { CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'], CHECKED_IN: ['CHECKED_OUT'], CHECKED_OUT: [], CANCELLED: [], NO_SHOW: [] };
const LEAD = { new: 'New', contacted: 'Contacted', booked: 'Booked', lost: 'Lost' };
const MAIL = { lead_admin: 'Lead alert (admin)', lead_guest: 'Request received (guest)', confirm_admin: 'Confirmation (admin)', confirm_guest: 'Confirmation (guest)', precheckout_admin: 'Check-out tomorrow (admin)', precheckout_guest: 'Check-out tomorrow (guest)', review_admin: 'Review request (admin copy)', review_guest: 'Review request (guest)' };
const RANK = { frontdesk: 1, manager: 2, owner: 3 };

let me = null;
let setup = null;
let view = 'today';
const viewEl = $('[data-view]');
const dialog = $('[data-dialog]');

/* ---------- API ---------- */
class ApiError extends Error { constructor(msg, data) { super(msg); this.data = data; } }
async function api(method, path, body) {
  const r = await fetch(`/api/admin${path}`, {
    method,
    headers: HEADERS,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && me && !path.startsWith('/me/password')) { showSignIn('Your session has ended. Please sign in again.'); throw new ApiError('Signed out'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(data.error || 'Request failed', data);
  return data;
}
function toast(msg, bad) {
  const t = $('[data-toast]');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
const can = (role) => me && RANK[me.role] >= RANK[role];

/* ---------- Sign in, forgot password, set password ---------- */
const loginView = $('[data-login-view]');
function pane(name) {
  $$('[data-pane]', loginView).forEach((p) => (p.hidden = p.dataset.pane !== name));
  $$('[data-err], [data-msg]', loginView).forEach((n) => (n.hidden = true));
  $(`[data-pane="${name}"] input:not([type=checkbox])`, loginView)?.focus();
}
function showSignIn(message) {
  me = null;
  $('[data-app]').hidden = true;
  loginView.hidden = false;
  pane('login');
  if (message) { const e = $('[data-pane="login"] [data-err]'); e.textContent = message; e.hidden = false; }
}
const paneErr = (form, msg) => { const e = $('[data-err]', form); e.textContent = msg; e.hidden = false; };
$$('[data-go-pane]', loginView).forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.goPane === 'forgot') $('[data-forgot]').email.value = $('[data-login]').email.value;
  pane(b.dataset.goPane);
}));
$$('[data-show-pw]').forEach((b) => b.addEventListener('click', () => {
  const i = b.previousElementSibling;
  i.type = i.type === 'password' ? 'text' : 'password';
  b.textContent = i.type === 'password' ? 'Show' : 'Hide';
}));

$('[data-login]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('[data-err]', f).hidden = true;
  if (!f.email.value || !f.password.value) return paneErr(f, 'Enter your email and password.');
  const btn = $('[type=submit]', f);
  btn.disabled = true;
  try {
    await api('POST', '/login', { email: f.email.value, password: f.password.value, remember: f.remember.checked });
    f.password.value = '';
    start();
  } catch (x) { paneErr(f, x.message); } finally { btn.disabled = false; }
});

$('[data-forgot]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('[data-msg]', f);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.value)) { msg.className = 'note-box bad'; msg.textContent = 'Enter your work email.'; msg.hidden = false; return; }
  try {
    const out = await api('POST', '/forgot', { email: f.email.value });
    msg.className = 'note-box ok';
    msg.textContent = out.mailEnabled
      ? 'If that email has an account, a reset link is on its way. Check your inbox (and spam) in a minute.'
      : 'Email is not set up on this system yet, so we cannot send a link. Ask the owner to set a new password for you under Staff.';
    msg.hidden = false;
  } catch (x) { msg.className = 'note-box bad'; msg.textContent = x.message; msg.hidden = false; }
});

// Reset and invite links arrive as /admin/?set=TOKEN. The token is removed from the address bar at once.
const linkToken = new URLSearchParams(location.search).get('set');
if (linkToken) history.replaceState(null, '', location.pathname);
async function openLink(token) {
  loginView.hidden = false;
  pane('set');
  const f = $('[data-set]');
  try {
    const l = await api('GET', `/link?t=${encodeURIComponent(token)}`);
    $('[data-set-title]').textContent = l.kind === 'invite' ? `Welcome, ${l.name.split(' ')[0]}` : 'Choose a new password';
    $('[data-set-sub]').textContent = `${l.kind === 'invite' ? 'Set a password for' : 'New password for'} ${l.email}.`;
    $('[data-set-fields]').hidden = false;
    $('[data-set-btn]').hidden = false;
    f.password.focus();
  } catch (x) { $('[data-set-sub]').textContent = ''; paneErr(f, x.message); }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('[data-err]', f).hidden = true;
    if (f.password.value.length < 10) return paneErr(f, 'Use at least 10 characters.');
    if (f.password.value !== f.confirm.value) return paneErr(f, 'The two passwords do not match.');
    try { await api('POST', '/link', { token, password: f.password.value }); f.reset(); toast('Password saved. You are signed in.'); start(); } catch (x) { paneErr(f, x.message); }
  });
}

async function signOut(everywhere = false) {
  try { await api('POST', '/logout', { everywhere }); } catch {}
  showSignIn();
}
$$('[data-logout]').forEach((b) => b.addEventListener('click', () => signOut()));
$$('[data-pw]').forEach((b) => b.addEventListener('click', accountDialog));

async function start() {
  try {
    const out = await api('GET', '/me');
    me = { ...out.user, mailEnabled: out.mailEnabled, notify: out.notify };
  } catch {
    const st = await fetch('/api/admin/status').then((r) => r.json()).catch(() => ({}));
    $('[data-first-run]').hidden = st.hasStaff !== false;
    return showSignIn();
  }
  loginView.hidden = true;
  $('[data-app]').hidden = false;
  $$('[data-user-name]').forEach((n) => (n.textContent = me.name));
  $('[data-user-role]').textContent = `${me.role[0].toUpperCase()}${me.role.slice(1)} · ${me.email}`;
  setup = await api('GET', '/setup');
  renderNav();
  go(location.hash.slice(1) || 'today');
}

/* ---------- Navigation ---------- */
const VIEWS = [
  ['today', 'Today', 'clock', 'frontdesk'],
  ['leads', 'Leads', 'mail', 'frontdesk'],
  ['bookings', 'Bookings', 'calendar', 'frontdesk'],
  ['calendar', 'Inventory', 'bed', 'frontdesk'],
  ['rooms', 'Rooms and rates', 'cottage', 'frontdesk'],
  ['reviews', 'Reviews', 'heart', 'frontdesk'],
  ['emails', 'Emails', 'mail', 'manager'],
  ['activity', 'Activity', 'compass', 'manager'],
  ['staff', 'Staff', 'users', 'owner'],
];
function renderNav(badge = {}) {
  $('[data-nav]').innerHTML = VIEWS.filter((v) => can(v[3]))
    .map(([k, label, ic]) => `<button type="button" data-go="${k}" ${k === view ? 'aria-current="page"' : ''}>${icon(ic)}${label}${badge[k] ? `<span class="badge">${badge[k]}</span>` : ''}</button>`).join('');
}
$('[data-nav]').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== view) go(v); });
async function go(v) {
  if (!VIEWS.some((x) => x[0] === v && can(x[3]))) v = 'today';
  view = v;
  if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`);
  $$('[data-go]').forEach((b) => (b.getAttribute('data-go') === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  viewEl.innerHTML = '<p class="empty">Loading...</p>';
  try { await RENDER[v](); } catch (e) { if (e.message !== 'Signed out') viewEl.innerHTML = `<p class="note-box bad">${esc(e.message)}</p>`; }
}
const refresh = () => go(view);

/* ---------- Shared bits ---------- */
const pill = (s, map = ST) => `<span class="pill pill--${esc(s)}">${esc(map[s] || s)}</span>`;
const guests = (a, c) => `${a} adult${a > 1 ? 's' : ''}${c ? `, ${c} child${c > 1 ? 'ren' : ''}` : ''}`;
function bookingRow(r) {
  return `<button type="button" class="row" data-s="${r.status}" data-open-res="${r.id}">
    <div class="row__top"><span><span class="row__name">${esc(r.guest_name)}</span> <span class="meta">${esc(r.reference)} &middot; ${esc(SRC[r.source] || r.source)}</span></span>${pill(r.status)}</div>
    <dl class="facts-g">
      <div><dt>Stay</dt><dd>${dt(r.check_in)} to ${dt(r.check_out)} (${nights(r.check_in, r.check_out)}N)</dd></div>
      <div><dt>Room</dt><dd>${r.rooms} x ${esc(r.room_name)}</dd></div>
      <div><dt>Guests</dt><dd>${guests(r.adults, r.children)}</dd></div>
      <div><dt>Amount</dt><dd>${inr(r.amount_minor) || '&ndash;'}${r.advance_minor ? ` <span class="meta">(adv ${inr(r.advance_minor)})</span>` : ''}</dd></div>
    </dl>
  </button>`;
}
viewEl.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open-res]');
  if (o) bookingDialog(Number(o.dataset.openRes));
});

function openDialog(html, onReady) {
  dialog.innerHTML = html;
  dialog.showModal();
  $('[data-close]', dialog)?.addEventListener('click', () => dialog.close());
  onReady?.(dialog);
}
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
const dlgHead = (t) => `<div class="dlg__head"><h2>${t}</h2><button type="button" data-close aria-label="Close">${icon('close')}</button></div>`;
function fieldErrors(form, fields = {}) {
  $$('.f', form).forEach((f) => { f.classList.remove('bad'); $('.err', f)?.remove(); });
  for (const [k, msg] of Object.entries(fields)) {
    const input = form.elements[k];
    const f = input?.closest?.('.f');
    if (f) { f.classList.add('bad'); f.insertAdjacentHTML('beforeend', `<span class="err">${esc(msg)}</span>`); }
  }
}
const roomOptions = (sel) => setup.roomTypes.filter((r) => r.isActive).map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)} (${r.totalRooms} rooms)</option>`).join('');
const planOptions = (rtId, sel) => (setup.roomTypes.find((r) => r.id === rtId)?.ratePlans || []).filter((p) => p.isActive)
  .map((p) => `<option value="${p.id}" ${p.id === sel || (!sel && p.isDefault) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

/* ================= Today ================= */
const RENDER = {};
RENDER.today = async () => {
  const d = await api('GET', '/dashboard');
  renderNav({ leads: d.counts.newLeads });
  const c = d.counts;
  const noRooms = !setup.roomTypes.some((r) => r.isActive && r.totalRooms > 0);
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(me.name.split(' ')[0])}</h1><p>${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
      <div class="ad-actions"><button class="b b--primary" type="button" data-new-booking>${icon('plus')}New booking</button></div></div>
    ${!me.mailEnabled ? '<div class="banner">Email is not set up yet, so guests and admin do not receive emails. Everything is still saved here. Add SMTP details to the server settings (.env) to switch emails on.</div>' : ''}
    ${noRooms ? `<div class="banner">No rooms are on sale yet. ${can('manager') ? 'Set how many rooms you have under <a class="lnk" href="#rooms">Rooms and rates</a>.' : 'Ask a manager to set the room count.'}</div>` : ''}
    <div class="kpis">
      <button class="kpi" type="button" data-jump="leads"><b>${c.newLeads}</b><span>New leads</span></button>
      <button class="kpi" type="button" data-jump="bookings:arrivals"><b>${c.arrivals}</b><span>Arriving today</span></button>
      <button class="kpi" type="button" data-jump="bookings:departures"><b>${c.departures}</b><span>Leaving today</span></button>
      <button class="kpi" type="button" data-jump="bookings:inhouse"><b>${c.inHouse}</b><span>In house</span></button>
      <button class="kpi" type="button" data-jump="bookings:upcoming"><b>${c.upcoming}</b><span>Upcoming</span></button>
    </div>
    <div class="grid2">
      <section class="card-w"><h2>Arriving today</h2><div class="pad">${d.arrivals.length ? `<div class="mini">${d.arrivals.map((r) => `<div><span><b>${esc(r.guest_name)}</b> <span class="meta">${r.rooms} x ${esc(r.room_name)}, ${nights(r.check_in, r.check_out)}N</span></span><span class="row__actions"><button class="b b--sm" data-open-res="${r.id}">Open</button><button class="b b--sm b--primary" data-status="${r.id}:CHECKED_IN">Check in</button></span></div>`).join('')}</div>` : '<p class="meta">No arrivals today.</p>'}</div></section>
      <section class="card-w"><h2>Leaving today</h2><div class="pad">${d.departures.length ? `<div class="mini">${d.departures.map((r) => `<div><span><b>${esc(r.guest_name)}</b> <span class="meta">${esc(r.reference)}${r.amount_minor != null ? `, balance ${inr(r.amount_minor - (r.advance_minor || 0))}` : ''}</span></span><span class="row__actions"><button class="b b--sm" data-open-res="${r.id}">Open</button>${r.status === 'CHECKED_IN' ? `<button class="b b--sm b--primary" data-status="${r.id}:CHECKED_OUT">Check out</button>` : ''}</span></div>`).join('')}</div>` : '<p class="meta">No departures today.</p>'}</div></section>
    </div>
    <section class="card-w" style="margin-top:16px"><h2>New leads <button class="b b--sm" data-jump="leads">All leads</button></h2><div class="pad">${d.leads.length ? `<div class="mini">${d.leads.map((l) => `<div><span><b>${esc(l.name)}</b> <span class="meta">${esc(l.ref)} &middot; ${l.kind === 'booking' ? `${dt(l.check_in)} to ${dt(l.check_out)}, ${guests(l.adults, l.children)}` : 'Message'} &middot; ${when(l.created_at)}</span></span><span class="row__actions"><a class="b b--sm" href="https://wa.me/${wa(l.phone)}" target="_blank" rel="noopener">WhatsApp</a>${l.kind === 'booking' ? `<button class="b b--sm b--primary" data-confirm-lead="${l.id}">Confirm booking</button>` : ''}</span></div>`).join('')}</div>` : '<p class="meta">No new leads. Nice and tidy.</p>'}</div></section>`;
  todayLeads = d.leads;
};
let todayLeads = [];
let bookingsView = 'upcoming';
viewEl.addEventListener('click', async (e) => {
  const j = e.target.closest('[data-jump]');
  if (j) { const [v, sub] = j.dataset.jump.split(':'); if (sub) bookingsView = sub; return go(v); }
  if (e.target.closest('[data-new-booking]')) return bookingForm({});
  const st = e.target.closest('[data-status]');
  if (st) {
    const [id, s] = st.dataset.status.split(':');
    try { await api('POST', `/reservations/${id}/status`, { status: s }); toast(`Marked ${ST[s].toLowerCase()}`); refresh(); } catch (x) { toast(x.message, true); }
  }
  const cl = e.target.closest('[data-confirm-lead]');
  if (cl) {
    const lead = [...todayLeads, ...leadItems].find((l) => l.id === Number(cl.dataset.confirmLead));
    if (lead) bookingForm({ lead });
  }
});

/* ================= Leads ================= */
let leadStatus = '';
let leadItems = [];
RENDER.leads = async () => {
  const q = $('[data-lead-q]')?.value || '';
  const p = new URLSearchParams();
  if (leadStatus) p.set('status', leadStatus);
  if (q) p.set('q', q);
  const d = await api('GET', `/enquiries?${p}`);
  leadItems = d.items;
  renderNav({ leads: d.counts.new });
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Leads</h1><p>Booking requests and messages from the website. Confirm a booking to block the rooms and email the guest.</p></div>
      <div class="ad-actions"><button class="b" type="button" data-csv="/enquiries.csv">Export CSV</button></div></div>
    <div class="toolbar"><div class="chips" data-lead-chips>${['', ...d.statuses].map((s) => `<button type="button" class="chip" data-ls="${s}" aria-pressed="${s === leadStatus}">${s ? LEAD[s] : 'All'} <b>${s ? d.counts[s] : total}</b></button>`).join('')}</div>
      <input class="inp search" type="search" placeholder="Search name, phone, ref" data-lead-q value="${esc(q)}" aria-label="Search leads"></div>
    <div class="rows">${d.items.length ? d.items.map(leadRow).join('') : '<p class="empty">No leads here.</p>'}</div>`;
  $('[data-lead-chips]').addEventListener('click', (e) => { const b = e.target.closest('[data-ls]'); if (b) { leadStatus = b.dataset.ls; refresh(); } });
  const qi = $('[data-lead-q]');
  qi.addEventListener('input', () => { clearTimeout(qi.t); qi.t = setTimeout(async () => { await RENDER.leads(); const n = $('[data-lead-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 300); });
};
function leadRow(l) {
  const booking = l.kind === 'booking';
  return `<article class="row" data-s="${l.status}" data-lead="${l.id}">
    <div class="row__top"><span><span class="row__name">${esc(l.name)}</span> <span class="meta">${booking ? 'Booking request' : 'Message'} &middot; ${esc(l.ref)} &middot; ${when(l.created_at)}</span></span>${pill(l.status, LEAD)}</div>
    <dl class="facts-g">
      <div><dt>Phone</dt><dd><a class="lnk" href="tel:${esc(l.phone)}">${esc(l.phone)}</a></dd></div>
      ${l.email ? `<div><dt>Email</dt><dd><a class="lnk" href="mailto:${esc(l.email)}">${esc(l.email)}</a></dd></div>` : ''}
      ${booking ? `<div><dt>Stay</dt><dd>${dt(l.check_in)} to ${dt(l.check_out)} (${nights(l.check_in, l.check_out)}N)</dd></div><div><dt>Guests</dt><dd>${guests(l.adults, l.children)}, ${l.rooms} room${l.rooms > 1 ? 's' : ''}</dd></div>` : ''}
    </dl>
    ${l.message ? `<p class="msg">${esc(l.message)}</p>` : ''}
    <div class="row__actions">
      <select class="sel" aria-label="Lead status" data-lead-status>${Object.entries(LEAD).map(([k, v]) => `<option value="${k}" ${k === l.status ? 'selected' : ''} ${k === 'booked' && !l.reservation_ref ? 'disabled' : ''}>${v}</option>`).join('')}</select>
      <input class="inp" placeholder="Private note (quoted rate, called at 5 pm...)" value="${esc(l.notes)}" data-lead-note aria-label="Note">
      <a class="b b--sm" href="https://wa.me/${wa(l.phone)}?text=${encodeURIComponent(`Hello ${l.name.split(' ')[0]}, thank you for your enquiry (${l.ref}) at The Pinus Resort.`)}" target="_blank" rel="noopener">${icon('whatsapp')}WhatsApp</a>
      ${l.reservation_ref ? `<button class="b b--sm" data-open-res="${l.reservation_id}">Booking ${esc(l.reservation_ref)}</button>` : booking ? `<button class="b b--sm b--primary" data-confirm-lead="${l.id}">Confirm booking</button>` : ''}
    </div>
  </article>`;
}
viewEl.addEventListener('change', async (e) => {
  const row = e.target.closest('[data-lead]');
  if (!row) return;
  const body = e.target.matches('[data-lead-status]') ? { status: e.target.value } : e.target.matches('[data-lead-note]') ? { notes: e.target.value } : null;
  if (!body) return;
  try { await api('PATCH', `/enquiries/${row.dataset.lead}`, body); toast('Saved'); if (body.status) refresh(); } catch (x) { toast(x.message, true); }
});
viewEl.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-csv]');
  if (!c) return;
  const r = await fetch(`/api/admin${c.dataset.csv}`, { credentials: 'same-origin' });
  const url = URL.createObjectURL(await r.blob());
  Object.assign(document.createElement('a'), { href: url, download: `pinus-${c.dataset.csv.replace(/\W+/g, '-').replace(/^-|-csv$/g, '')}-${iso(new Date())}.csv` }).click();
  URL.revokeObjectURL(url);
});

/* ================= Booking form (new / from lead) ================= */
function bookingForm({ lead }) {
  const rt = setup.roomTypes.find((r) => r.isActive) || {};
  const today = iso(new Date());
  const v = lead
    ? { checkIn: lead.check_in, checkOut: lead.check_out, adults: lead.adults, children: lead.children || 0, rooms: lead.rooms, guestName: lead.name, guestPhone: lead.phone, guestEmail: lead.email || '', notes: lead.message || '', source: 'WEBSITE' }
    : { checkIn: today, checkOut: addDays(today, 1), adults: 2, children: 0, rooms: 1, guestName: '', guestPhone: '', guestEmail: '', notes: '', source: 'PHONE' };
  openDialog(`${dlgHead(lead ? `Confirm booking for ${esc(lead.name)}` : 'New booking')}
    <form data-bf novalidate>
      <div class="dlg__body">
        ${lead ? `<p class="note-box">From website lead ${esc(lead.ref)}. Check the details with the guest, then confirm. The rooms are blocked and the guest gets a confirmation email.</p>` : ''}
        <div class="fgrid">
          <label class="f"><span>Room type</span><select class="sel" name="roomTypeId">${roomOptions(rt.id)}</select></label>
          <label class="f"><span>Rate plan</span><select class="sel" name="ratePlanId">${planOptions(rt.id)}</select></label>
          <label class="f"><span>Check in</span><input class="inp" type="date" name="checkIn" min="${today}" value="${esc(v.checkIn)}" required></label>
          <label class="f"><span>Check out</span><input class="inp" type="date" name="checkOut" min="${addDays(today, 1)}" value="${esc(v.checkOut)}" required></label>
        </div>
        <div class="fgrid fgrid--3">
          <label class="f"><span>Rooms</span><input class="inp" type="number" name="rooms" min="1" max="20" value="${v.rooms}"></label>
          <label class="f"><span>Adults</span><input class="inp" type="number" name="adults" min="1" max="60" value="${v.adults}"></label>
          <label class="f"><span>Children</span><input class="inp" type="number" name="children" min="0" max="40" value="${v.children}"></label>
        </div>
        <div class="note-box" data-quote>Checking availability...</div>
        <div class="fgrid">
          <label class="f full"><span>Guest name</span><input class="inp" name="guestName" value="${esc(v.guestName)}" required></label>
          <label class="f"><span>Phone</span><input class="inp" name="guestPhone" type="tel" value="${esc(v.guestPhone)}"></label>
          <label class="f"><span>Email <small class="hint">(for the confirmation email)</small></span><input class="inp" name="guestEmail" type="email" value="${esc(v.guestEmail)}"></label>
          <label class="f"><span>Source</span><select class="sel" name="source">${Object.entries(SRC).map(([k, l]) => `<option value="${k}" ${k === v.source ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="f"><span>Source detail <small class="hint">(agent, OTA name)</small></span><input class="inp" name="sourceDetail"></label>
          <label class="f"><span>Total amount (INR)</span><input class="inp" name="amount" type="number" min="0" step="1" placeholder="From rates if left empty" data-amount></label>
          <label class="f"><span>Advance received (INR)</span><input class="inp" name="advance" type="number" min="0" step="1"></label>
          <label class="f full"><span>Notes</span><textarea class="ta" name="notes">${esc(v.notes)}</textarea></label>
        </div>
        <label class="check"><input type="checkbox" name="sendEmail" checked> Email the confirmation to the guest and admin</label>
        <p class="note-box bad" data-bf-err hidden></p>
      </div>
      <div class="dlg__foot"><button class="b" type="button" data-close>Cancel</button><button class="b b--primary" type="submit">${lead ? 'Confirm booking' : 'Save booking'}</button></div>
    </form>`, (dlg) => {
    const f = $('[data-bf]', dlg);
    f.roomTypeId.addEventListener('change', () => { f.ratePlanId.innerHTML = planOptions(Number(f.roomTypeId.value)); quote(); });
    f.checkIn.addEventListener('change', () => { if (f.checkOut.value <= f.checkIn.value) f.checkOut.value = addDays(f.checkIn.value, 1); f.checkOut.min = addDays(f.checkIn.value, 1); });
    let qt;
    async function quote() {
      const box = $('[data-quote]', f);
      try {
        const q = await api('POST', '/quote', { roomTypeId: f.roomTypeId.value, ratePlanId: f.ratePlanId.value, checkIn: f.checkIn.value, checkOut: f.checkOut.value, rooms: f.rooms.value, adults: f.adults.value, children: f.children.value });
        box.className = `note-box ${q.ok ? 'ok' : 'bad'}`;
        box.textContent = q.ok ? `Available. ${q.nights} night${q.nights > 1 ? 's' : ''}${q.amount != null ? `, INR ${q.amount.toLocaleString('en-IN')} from your rates` : ', no rate set for some nights (enter the amount)'}.` : q.reasons.join('. ');
        $('[data-amount]', f).placeholder = q.amount != null ? `${q.amount} from rates` : 'Enter the agreed total';
      } catch (x) { box.className = 'note-box bad'; box.textContent = x.message; }
    }
    f.addEventListener('input', (e) => { if (['roomTypeId', 'ratePlanId', 'checkIn', 'checkOut', 'rooms', 'adults', 'children'].includes(e.target.name)) { clearTimeout(qt); qt = setTimeout(quote, 250); } });
    quote();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.sendEmail = f.sendEmail.checked;
      if (lead) body.enquiryId = lead.id;
      const btn = $('[type=submit]', f);
      btn.disabled = true;
      try {
        const out = await api('POST', '/reservations', body);
        dialog.close();
        toast(`Booking ${out.item.reference} saved${body.sendEmail ? (me.mailEnabled ? ', confirmation emailed' : ' (email not set up, nothing sent)') : ''}`);
        refresh();
      } catch (x) {
        fieldErrors(f, x.data?.fields);
        const err = $('[data-bf-err]', f);
        err.textContent = x.message;
        err.hidden = false;
      } finally { btn.disabled = false; }
    });
  });
}

/* ================= Bookings ================= */
RENDER.bookings = async () => {
  const q = $('[data-res-q]')?.value || '';
  const d = await api('GET', `/reservations?view=${bookingsView}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const views = [['upcoming', 'Upcoming', d.counts.upcoming], ['arrivals', 'Arriving today', d.counts.arrivals], ['departures', 'Leaving today', d.counts.departures], ['inhouse', 'In house', d.counts.inHouse], ['past', 'Past'], ['cancelled', 'Cancelled'], ['all', 'All']];
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Bookings</h1><p>Every confirmed stay. Open one to check in, check out, cancel, edit or resend emails.</p></div>
      <div class="ad-actions"><button class="b" type="button" data-csv="/reservations.csv?view=all">Export CSV</button><button class="b b--primary" type="button" data-new-booking>${icon('plus')}New booking</button></div></div>
    <div class="toolbar"><div class="chips" data-res-chips>${views.map(([k, l, n]) => `<button type="button" class="chip" data-rv="${k}" aria-pressed="${k === bookingsView}">${l}${n !== undefined ? ` <b>${n}</b>` : ''}</button>`).join('')}</div>
      <input class="inp search" type="search" placeholder="Search guest, phone, ref" data-res-q value="${esc(q)}" aria-label="Search bookings"></div>
    <div class="rows">${d.items.length ? d.items.map(bookingRow).join('') : '<p class="empty">No bookings here.</p>'}</div>`;
  $('[data-res-chips]').addEventListener('click', (e) => { const b = e.target.closest('[data-rv]'); if (b) { bookingsView = b.dataset.rv; refresh(); } });
  const qi = $('[data-res-q]');
  qi.addEventListener('input', () => { clearTimeout(qi.t); qi.t = setTimeout(async () => { await RENDER.bookings(); const n = $('[data-res-q]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 300); });
};

async function bookingDialog(id) {
  const { item: r } = await api('GET', `/reservations/${id}`);
  const next = NEXT[r.status];
  const btnLabel = { CHECKED_IN: 'Check in', CHECKED_OUT: 'Check out', CANCELLED: 'Cancel booking', NO_SHOW: 'Mark no-show' };
  const sent = (k) => r.emails.find((e) => e.kind === k);
  const mailLine = (label, kind, key) => {
    const g = sent(`${kind}_guest`);
    const a = sent(`${kind}_admin`);
    const st = (x) => (x ? `${x.status}${x.status !== 'sent' && x.error ? ` (${esc(x.error)})` : ''}, ${when(x.created_at)}` : 'not yet');
    return `<tr><td>${label}</td><td>Guest: ${st(g)}<br>Admin: ${st(a)}</td><td><button class="b b--sm" type="button" data-resend="${key}">${g || a ? 'Resend' : 'Send now'}</button></td></tr>`;
  };
  openDialog(`${dlgHead(`${esc(r.guest_name)} <span class="meta">${esc(r.reference)}</span>`)}
    <div class="dlg__body">
      <div class="row__top">${pill(r.status)}<span class="meta">${esc(SRC[r.source])}${r.source_detail ? `: ${esc(r.source_detail)}` : ''}${r.lead_ref ? ` &middot; lead ${esc(r.lead_ref)}` : ''} &middot; by ${esc(r.created_by_name || 'system')} ${when(r.created_at)}</span></div>
      <dl class="facts-g">
        <div><dt>Check in</dt><dd>${dty(r.check_in)}</dd></div>
        <div><dt>Check out</dt><dd>${dty(r.check_out)} (${nights(r.check_in, r.check_out)}N)</dd></div>
        <div><dt>Room</dt><dd>${r.rooms} x ${esc(r.room_name)}${r.rate_plan_name ? `, ${esc(r.rate_plan_name)}` : ''}</dd></div>
        <div><dt>Guests</dt><dd>${guests(r.adults, r.children)}</dd></div>
      </dl>
      ${next.length ? `<div class="row__actions">${next.map((s) => `<button class="b ${s === 'CHECKED_IN' || s === 'CHECKED_OUT' ? 'b--primary' : 'b--danger'}" type="button" data-to="${s}">${btnLabel[s]}</button>`).join('')}</div>` : ''}
      <form data-edit class="fgrid">
        <label class="f"><span>Phone</span><input class="inp" name="guestPhone" value="${esc(r.guest_phone)}"></label>
        <label class="f"><span>Email</span><input class="inp" name="guestEmail" type="email" value="${esc(r.guest_email)}"></label>
        <label class="f"><span>Total (INR)</span><input class="inp" name="amount" type="number" min="0" value="${r.amount_minor == null ? '' : r.amount_minor / 100}"></label>
        <label class="f"><span>Advance received (INR)</span><input class="inp" name="advance" type="number" min="0" value="${r.advance_minor == null ? '' : r.advance_minor / 100}"></label>
        <label class="f full"><span>Notes</span><textarea class="ta" name="notes">${esc(r.notes)}</textarea></label>
        <div class="full row__actions"><button class="b" type="submit">Save details</button>${r.guest_phone ? `<a class="b" href="https://wa.me/${wa(r.guest_phone)}" target="_blank" rel="noopener">${icon('whatsapp')}WhatsApp guest</a>` : ''}${r.amount_minor != null ? `<span class="meta">Balance ${inr(r.amount_minor - (r.advance_minor || 0))}</span>` : ''}</div>
      </form>
      <section><h3 class="f"><span>Emails</span></h3>
        <div class="tbl-wrap"><table class="tbl"><tbody>
          ${mailLine('Booking confirmed', 'confirm', 'confirm')}
          ${mailLine('Check-out tomorrow', 'precheckout', 'precheckout')}
          ${mailLine('Review request', 'review', 'review')}
        </tbody></table></div>
        ${r.review_rating ? `<p class="mt-s"><span class="stars-s">${'★'.repeat(r.review_rating)}${'☆'.repeat(5 - r.review_rating)}</span> ${esc(r.review_comment || '')}</p>` : ''}
      </section>
      <section><h3 class="f"><span>History</span></h3>
        <ul class="timeline" role="list">${r.events.map((ev) => `<li><time>${when(ev.created_at)}</time><span>${ev.from_status ? `${ST[ev.from_status]} to ` : ''}${ST[ev.to_status]}${ev.staff_name ? ` by ${esc(ev.staff_name)}` : ''}${ev.remark ? `: ${esc(ev.remark)}` : ''}</span></li>`).join('')}</ul>
      </section>
    </div>`, (dlg) => {
    $$('[data-to]', dlg).forEach((b) => b.addEventListener('click', async () => {
      const s = b.dataset.to;
      if ((s === 'CANCELLED' || s === 'NO_SHOW') && !confirm(`${btnLabel[s]} for ${r.guest_name}? Unused nights go back on sale.`)) return;
      try { await api('POST', `/reservations/${id}/status`, { status: s }); toast(`${ST[s]}`); dialog.close(); refresh(); } catch (x) { toast(x.message, true); }
    }));
    $('[data-edit]', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PATCH', `/reservations/${id}`, Object.fromEntries(new FormData(e.target))); toast('Details saved'); refresh(); } catch (x) { toast(x.message, true); }
    });
    $$('[data-resend]', dlg).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api('POST', `/reservations/${id}/email`, { kind: b.dataset.resend }); toast(me.mailEnabled ? 'Email sent' : 'Logged, but email is not set up yet'); bookingDialog(id); } catch (x) { toast(x.message, true); b.disabled = false; }
    }));
  });
}

/* ================= Inventory calendar ================= */
let calFrom = iso(new Date());
let calDays = 14;
let calData = null;
RENDER.calendar = async () => {
  calData = await api('GET', `/calendar?from=${calFrom}&days=${calDays}`);
  const d = calData;
  const wd = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
  const head = d.dates.map((s) => `<th class="${[0, 6].includes(wd(s)) ? 'we' : ''} ${s === d.today ? 'today' : ''}"><small>${new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</small>${dt(s)}</th>`).join('');
  const body = d.roomTypes.map((rt) => `
    <tr class="rt-head"><td class="lab" colspan="1"><b>${esc(rt.name)}</b><small>${rt.totalRooms} rooms in total</small></td>${d.dates.map(() => '<td></td>').join('')}</tr>
    <tr><td class="lab">Rooms left</td>${rt.days.map((x) => `<td class="${!x.open ? 'cell-closed' : x.stopSell ? 'cell-stop' : ''}"><button type="button" class="cell-left ${x.open && !x.stopSell ? (x.left === 0 ? 'zero' : x.left <= 1 ? 'low' : '') : ''}" data-day="${rt.id}|${x.date}" ${!x.open ? 'disabled title="Outside the selling window"' : ''}>${x.open ? x.left : '&middot;'}</button></td>`).join('')}</tr>
    <tr><td class="lab">Sold</td>${rt.days.map((x) => `<td>${x.sold || '<span class="meta">0</span>'}</td>`).join('')}</tr>
    ${rt.ratePlans.map((p) => `<tr><td class="lab">${esc(p.name)}${p.rule ? ` <small>(${esc(p.rule)})</small>` : ''}</td>${p.days.map((x, i) => `<td class="${x.stopSell ? 'cell-stop' : ''}"><button type="button" class="cell-price" data-day="${rt.id}|${x.date}" ${!rt.days[i].open ? 'disabled' : ''}>${x.price != null ? x.price.toLocaleString('en-IN') : '<span class="meta">&ndash;</span>'}${x.minLos > 1 || x.cta || x.ctd ? `<small>${[x.minLos > 1 ? `min ${x.minLos}` : '', x.cta ? 'CTA' : '', x.ctd ? 'CTD' : ''].filter(Boolean).join(' ')}</small>` : ''}</button></td>`).join('')}</tr>`).join('')}
  `).join('');
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Inventory</h1><p>Rooms left and price per night. Tap any day to change it, or use bulk update for a date range.</p></div>
      <div class="ad-actions">
        <button class="b" type="button" data-cal="-1" aria-label="Earlier">${icon('left')}</button>
        <input class="inp" type="date" value="${calFrom}" data-cal-from style="width:auto" aria-label="Start date">
        <button class="b" type="button" data-cal="1" aria-label="Later">${icon('right')}</button>
        <select class="sel" data-cal-days style="width:auto" aria-label="Days shown">${[7, 14, 30].map((n) => `<option value="${n}" ${n === calDays ? 'selected' : ''}>${n} days</option>`).join('')}</select>
        ${can('manager') ? `<button class="b b--primary" type="button" data-bulk>Bulk update</button>` : ''}
      </div></div>
    ${d.roomTypes.length ? `<div class="cal-wrap"><table class="cal"><thead><tr><th class="lab"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '<p class="empty">No room types yet.</p>'}
    <div class="legend"><span><i style="background:#f6e3dd"></i>Sold out</span><span><i style="background:#fbf0dc"></i>1 room left</span><span><i style="background:repeating-linear-gradient(-45deg,#f6e3dd,#f6e3dd 3px,#fbf3f0 3px,#fbf3f0 6px)"></i>Stop-sell (website shows unavailable)</span><span>CTA / CTD: closed to arrival / departure</span></div>`;
  $$('[data-cal]').forEach((b) => b.addEventListener('click', () => { calFrom = addDays(calFrom, Number(b.dataset.cal) * calDays); refresh(); }));
  $('[data-cal-from]').addEventListener('change', (e) => { if (e.target.value) { calFrom = e.target.value; refresh(); } });
  $('[data-cal-days]').addEventListener('change', (e) => { calDays = Number(e.target.value); refresh(); });
  $('[data-bulk]')?.addEventListener('click', () => bulkDialog());
  $$('[data-day]').forEach((b) => b.addEventListener('click', () => { const [rt, date] = b.dataset.day.split('|'); if (can('manager')) bulkDialog({ roomTypeId: Number(rt), date }); else toast('Only managers can change inventory', true); }));
};

function bulkDialog(one) {
  const rts = setup.roomTypes.filter((r) => r.isActive);
  const rtDay = one && calData.roomTypes.find((r) => r.id === one.roomTypeId);
  const dayInv = rtDay?.days.find((x) => x.date === one.date);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const triSel = (name, label, cur) => `<label class="f"><span>${label}</span><select class="sel" name="${name}"><option value="">${one ? `Keep (${cur ? 'yes' : 'no'})` : 'No change'}</option><option value="true">Yes</option><option value="false">No</option></select></label>`;
  const manualPlan = rtDay?.ratePlans.find((p) => p.rateMode === 'MANUAL');
  const pDay = manualPlan?.days.find((x) => x.date === one?.date);
  openDialog(`${dlgHead(one ? `${esc(rtDay.name)}, ${dty(one.date)}` : 'Bulk update')}
    <form data-bulk-form novalidate>
      <div class="dlg__body">
        ${one ? `<p class="meta">${dayInv.sold} sold, ${dayInv.left} left of ${rtDay.totalRooms}. Leave a field empty to keep it as it is.</p>` : `
        <div class="fgrid">
          <label class="f"><span>From</span><input class="inp" type="date" name="from" min="${iso(new Date())}" value="${calFrom}" required></label>
          <label class="f"><span>To</span><input class="inp" type="date" name="to" min="${iso(new Date())}" value="${addDays(calFrom, 29)}" required></label>
        </div>
        <div class="f"><span>Weekdays</span><div class="wds">${days.map((n, i) => `<label><input type="checkbox" name="wd" value="${i}" checked><span>${n}</span></label>`).join('')}</div></div>
        <div class="f"><span>Room types</span><div class="wds">${rts.map((r) => `<label><input type="checkbox" name="rt" value="${r.id}" checked><span>${esc(r.name)}</span></label>`).join('')}</div></div>
        <div class="f"><span>Rate plans <small class="hint">(derived plans follow their parent's price automatically)</small></span><div class="wds">${rts.flatMap((r) => r.ratePlans.filter((p) => p.isActive).map((p) => `<label><input type="checkbox" name="rp" value="${p.id}" ${p.rateMode === 'MANUAL' ? 'checked' : ''}><span>${esc(r.name)}: ${esc(p.name)}</span></label>`)).join('')}</div></div>`}
        <div class="fgrid">
          <label class="f"><span>Rooms to sell</span><input class="inp" type="number" name="rooms" min="0" max="200" placeholder="${one ? `Now ${dayInv.left}` : 'No change'}"><small class="hint">Capped at total rooms minus bookings.</small></label>
          ${triSel('stopSell', 'Stop-sell (close for sale)', dayInv?.stopSell)}
          <label class="f"><span>Price per night (INR)</span><input class="inp" type="number" name="price" min="1" step="1" placeholder="${one ? (pDay?.price != null ? `Now ${pDay.price}` : 'Not set') : 'No change'}"></label>
          <label class="f"><span>Minimum stay (nights)</span><input class="inp" type="number" name="minLos" min="1" max="30" placeholder="${one ? `Now ${pDay?.minLos ?? 1}` : 'No change'}"></label>
          <label class="f"><span>Maximum stay (nights)</span><input class="inp" type="number" name="maxLos" min="0" max="30" placeholder="${one ? `Now ${pDay?.maxLos ?? 'none'}` : 'No change'} (0 = none)"></label>
          <label class="f"><span>Extra adult per night (INR)</span><input class="inp" type="number" name="extraAdult" min="0" placeholder="${one ? `Now ${pDay?.extraAdult ?? 0}` : 'No change'}"></label>
          <label class="f"><span>Extra child per night (INR)</span><input class="inp" type="number" name="extraChild" min="0" placeholder="${one ? `Now ${pDay?.extraChild ?? 0}` : 'No change'}"></label>
          ${triSel('cta', 'Closed to arrival', pDay?.cta)}
          ${triSel('ctd', 'Closed to departure', pDay?.ctd)}
        </div>
        <p class="note-box bad" data-bulk-err hidden></p>
      </div>
      <div class="dlg__foot"><button class="b" type="button" data-close>Cancel</button><button class="b b--primary" type="submit">Save</button></div>
    </form>`, (dlg) => {
    const f = $('[data-bulk-form]', dlg);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const set = {};
      for (const k of ['rooms', 'stopSell', 'price', 'minLos', 'maxLos', 'extraAdult', 'extraChild', 'cta', 'ctd']) {
        const v = fd.get(k);
        if (v !== null && v !== '') set[k] = k === 'stopSell' || k === 'cta' || k === 'ctd' ? v === 'true' : k === 'maxLos' && Number(v) === 0 ? null : Number(v);
      }
      const body = one
        ? { from: one.date, to: one.date, roomTypeIds: [one.roomTypeId], ratePlanIds: rtDay.ratePlans.map((p) => p.id), set }
        : { from: fd.get('from'), to: fd.get('to'), weekdays: fd.getAll('wd').map(Number), roomTypeIds: fd.getAll('rt').map(Number), ratePlanIds: fd.getAll('rp').map(Number), set };
      if (!Object.keys(set).length) { dialog.close(); return; }
      try {
        const out = await api('POST', '/bulk', body);
        dialog.close();
        toast(`Saved${out.cappedDates.length ? `. Rooms capped on ${out.cappedDates.length} day(s) because of bookings` : ''}`);
        refresh();
      } catch (x) { const err = $('[data-bulk-err]', f); err.textContent = x.message; err.hidden = false; }
    });
  });
}

/* ================= Rooms and rates ================= */
RENDER.rooms = async () => {
  setup = await api('GET', '/setup');
  const s = setup.settings;
  const edit = can('manager');
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Rooms and rates</h1><p>Room types, how many rooms of each, rate plans and resort settings.</p></div>
      ${edit ? `<div class="ad-actions"><button class="b" type="button" data-reset>Reset availability</button><button class="b b--primary" type="button" data-rt-new>${icon('plus')}Add room type</button></div>` : ''}</div>
    ${setup.roomTypes.map((rt) => `
      <section class="card-w">
        <h2><span>${esc(rt.name)} <span class="meta">${esc(rt.code)}${rt.isActive ? '' : ' &middot; hidden'}</span></span>${edit ? `<button class="b b--sm" data-rt-edit="${rt.id}">Edit</button>` : ''}</h2>
        <div class="pad">
          <dl class="facts-g"><div><dt>Rooms</dt><dd><b style="font-size:1.3rem;font-family:var(--serif)">${rt.totalRooms}</b></dd></div><div><dt>Base occupancy</dt><dd>${rt.baseOccupancy}</dd></div><div><dt>Max adults / children</dt><dd>${rt.maxAdults} / ${rt.maxChildren}</dd></div><div><dt>Max guests</dt><dd>${rt.maxOccupancy}</dd></div></dl>
          <div class="tbl-wrap mt-s"><table class="tbl"><thead><tr><th>Rate plan</th><th>Meals</th><th>Pricing</th><th></th></tr></thead><tbody>
            ${rt.ratePlans.map((p) => `<tr><td>${esc(p.name)}${p.isDefault ? ' <span class="pill">Default</span>' : ''}${p.isActive ? '' : ' <span class="pill">Off</span>'}</td><td>${esc(setup.mealPlans[p.mealPlan])}</td><td>${p.rateMode === 'DERIVED' ? `${esc(p.parentName)} ${p.deriveValue >= 0 ? '+' : ''}${p.deriveType === 'PERCENT' ? `${p.deriveValue}%` : `INR ${p.deriveValue}`}${p.followParentRestrictions ? ', same restrictions' : ''}` : 'Set in the calendar'}</td><td>${edit ? `<button class="b b--sm" data-rp-edit="${p.id}">Edit</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          ${edit ? `<button class="b b--sm mt-s" data-rp-new="${rt.id}">${icon('plus')}Add rate plan</button>` : ''}
        </div>
      </section>`).join('')}
    <section class="card-w"><h2>Settings</h2><form class="pad fgrid" data-settings>
      <label class="f"><span>Selling window (days ahead)</span><input class="inp" type="number" name="horizonDays" min="0" max="730" value="${s.horizonDays}" ${edit ? '' : 'disabled'}><small class="hint">New nights open automatically every day.</small></label>
      <label class="f"><span>Admin emails <small class="hint">(comma separated)</small></span><input class="inp" name="notifyEmail" value="${esc(s.notifyEmail)}" placeholder="${esc(me.notify.join(', '))}" ${edit ? '' : 'disabled'}></label>
      <label class="f"><span>Check-in time</span><input class="inp" type="time" name="checkinTime" value="${esc(s.checkinTime)}" ${edit ? '' : 'disabled'}></label>
      <label class="f"><span>Check-out time</span><input class="inp" type="time" name="checkoutTime" value="${esc(s.checkoutTime)}" ${edit ? '' : 'disabled'}></label>
      <label class="f full"><span>Google review link <small class="hint">(guests who give 4 or 5 stars are invited to post here)</small></span><input class="inp" name="reviewUrl" value="${esc(s.reviewUrl)}" placeholder="https://g.page/r/.../review" ${edit ? '' : 'disabled'}></label>
      ${edit ? '<div class="full"><button class="b b--primary" type="submit">Save settings</button></div>' : ''}
    </form></section>`;
  if (!edit) return;
  $('[data-rt-new]').addEventListener('click', () => roomTypeDialog());
  $$('[data-rt-edit]').forEach((b) => b.addEventListener('click', () => roomTypeDialog(setup.roomTypes.find((r) => r.id === Number(b.dataset.rtEdit)))));
  $$('[data-rp-new]').forEach((b) => b.addEventListener('click', () => ratePlanDialog(setup.roomTypes.find((r) => r.id === Number(b.dataset.rpNew)))));
  $$('[data-rp-edit]').forEach((b) => b.addEventListener('click', () => { const rt = setup.roomTypes.find((r) => r.ratePlans.some((p) => p.id === Number(b.dataset.rpEdit))); ratePlanDialog(rt, rt.ratePlans.find((p) => p.id === Number(b.dataset.rpEdit))); }));
  $('[data-reset]').addEventListener('click', async () => {
    if (!confirm('Recalculate rooms left for every future night as total rooms minus bookings? Manual closures will be undone.')) return;
    try { const out = await api('POST', '/reset-availability', {}); toast(`${out.changed} night(s) corrected`); } catch (x) { toast(x.message, true); }
  });
  $('[data-settings]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { setup = await api('PUT', '/settings', Object.fromEntries(new FormData(e.target))); toast('Settings saved'); } catch (x) { toast(x.message, true); }
  });
};

function roomTypeDialog(rt) {
  const v = rt || { name: '', code: '', totalRooms: 1, baseOccupancy: 2, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, sortOrder: 0, isActive: true };
  openDialog(`${dlgHead(rt ? `Edit ${esc(rt.name)}` : 'Add room type')}
    <form data-rt-form><div class="dlg__body"><div class="fgrid">
      <label class="f"><span>Name</span><input class="inp" name="name" value="${esc(v.name)}" required></label>
      <label class="f"><span>Short code</span><input class="inp" name="code" value="${esc(v.code)}" placeholder="DLX" required></label>
      <label class="f"><span>Number of rooms</span><input class="inp" type="number" name="totalRooms" min="0" max="200" value="${v.totalRooms}"><small class="hint">Changing this shifts every future night by the difference.</small></label>
      <label class="f"><span>Base occupancy <small class="hint">(included in the price)</small></span><input class="inp" type="number" name="baseOccupancy" min="1" value="${v.baseOccupancy}"></label>
      <label class="f"><span>Max adults per room</span><input class="inp" type="number" name="maxAdults" min="1" value="${v.maxAdults}"></label>
      <label class="f"><span>Max children per room</span><input class="inp" type="number" name="maxChildren" min="0" value="${v.maxChildren}"></label>
      <label class="f"><span>Max guests per room</span><input class="inp" type="number" name="maxOccupancy" min="1" value="${v.maxOccupancy}"></label>
      <label class="f"><span>Display order</span><input class="inp" type="number" name="sortOrder" min="0" value="${v.sortOrder}"></label>
      <label class="check full"><input type="checkbox" name="isActive" ${v.isActive ? 'checked' : ''}> On sale</label>
    </div><p class="note-box bad" data-err hidden></p></div>
    <div class="dlg__foot"><button class="b" type="button" data-close>Cancel</button><button class="b b--primary" type="submit">Save</button></div></form>`, (dlg) => {
    $('[data-rt-form]', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.isActive = e.target.isActive.checked;
      try { await api(rt ? 'PUT' : 'POST', rt ? `/room-types/${rt.id}` : '/room-types', b); dialog.close(); toast('Room type saved'); refresh(); } catch (x) { const n = $('[data-err]', dlg); n.textContent = x.message; n.hidden = false; }
    });
  });
}

function ratePlanDialog(rt, p) {
  const v = p || { name: '', mealPlan: 'CP', rateMode: 'MANUAL', parentId: null, deriveType: 'PERCENT', deriveValue: 0, followParentRestrictions: true, isDefault: false, isActive: true };
  const parents = rt.ratePlans.filter((x) => x.rateMode === 'MANUAL' && x.id !== p?.id);
  openDialog(`${dlgHead(p ? `Edit ${esc(p.name)}` : `Add rate plan to ${esc(rt.name)}`)}
    <form data-rp-form><div class="dlg__body"><div class="fgrid">
      <label class="f"><span>Name</span><input class="inp" name="name" value="${esc(v.name)}" placeholder="With breakfast" required></label>
      <label class="f"><span>Meals</span><select class="sel" name="mealPlan">${Object.entries(setup.mealPlans).map(([k, l]) => `<option value="${k}" ${k === v.mealPlan ? 'selected' : ''}>${k}: ${l}</option>`).join('')}</select></label>
      <label class="f full"><span>Pricing</span><select class="sel" name="rateMode"><option value="MANUAL" ${v.rateMode === 'MANUAL' ? 'selected' : ''}>Set prices myself in the calendar</option>${parents.length ? `<option value="DERIVED" ${v.rateMode === 'DERIVED' ? 'selected' : ''}>Follow another plan with an adjustment</option>` : ''}</select></label>
      <div class="full fgrid fgrid--3" data-derived ${v.rateMode === 'DERIVED' ? '' : 'hidden'}>
        <label class="f"><span>Follows</span><select class="sel" name="parentId">${parents.map((x) => `<option value="${x.id}" ${x.id === v.parentId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Adjust by</span><select class="sel" name="deriveType"><option value="PERCENT" ${v.deriveType === 'PERCENT' ? 'selected' : ''}>Percent</option><option value="AMOUNT" ${v.deriveType === 'AMOUNT' ? 'selected' : ''}>Rupees</option></select></label>
        <label class="f"><span>Amount <small class="hint">(+ or -)</small></span><input class="inp" type="number" step="any" name="deriveValue" value="${v.deriveValue ?? 0}"></label>
        <label class="check full"><input type="checkbox" name="followParentRestrictions" ${v.followParentRestrictions ? 'checked' : ''}> Same restrictions as the plan it follows</label>
      </div>
      <label class="check"><input type="checkbox" name="isDefault" ${v.isDefault ? 'checked' : ''}> Default plan for this room</label>
      ${p ? `<label class="check"><input type="checkbox" name="isActive" ${v.isActive ? 'checked' : ''}> Active</label>` : ''}
    </div><p class="note-box bad" data-err hidden></p></div>
    <div class="dlg__foot"><button class="b" type="button" data-close>Cancel</button><button class="b b--primary" type="submit">Save</button></div></form>`, (dlg) => {
    const f = $('[data-rp-form]', dlg);
    f.rateMode.addEventListener('change', () => ($('[data-derived]', f).hidden = f.rateMode.value !== 'DERIVED'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(f));
      b.roomTypeId = rt.id;
      b.isDefault = f.isDefault.checked;
      b.followParentRestrictions = !!f.followParentRestrictions?.checked;
      if (f.isActive) b.isActive = f.isActive.checked;
      b.deriveValue = Number(b.deriveValue);
      try { await api(p ? 'PUT' : 'POST', p ? `/rate-plans/${p.id}` : '/rate-plans', b); dialog.close(); toast('Rate plan saved'); refresh(); } catch (x) { const n = $('[data-err]', dlg); n.textContent = x.message; n.hidden = false; }
    });
  });
}

/* ================= Reviews ================= */
RENDER.reviews = async () => {
  const d = await api('GET', '/reviews');
  const stars = (n) => `<span class="stars-s" aria-label="${n} of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Reviews</h1><p>Guests get a review request by email after check-out. Ratings land here.</p></div></div>
    ${!d.reviewUrl ? `<div class="banner">Add your Google review link under <a class="lnk" href="#rooms">Rooms and rates &gt; Settings</a> so happy guests are invited to post on Google too.</div>` : ''}
    <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr));max-width:420px"><div class="kpi"><b>${d.average ? d.average.toFixed(1) : '&ndash;'}</b><span>Average rating</span></div><div class="kpi"><b>${d.items.length}</b><span>Reviews</span></div></div>
    <div class="rows">${d.items.length ? d.items.map((r) => `<article class="row"><div class="row__top"><span><span class="row__name">${esc(r.guest_name)}</span> <span class="meta">${esc(r.reference)} &middot; stayed ${dt(r.check_in)} to ${dt(r.check_out)}</span></span>${stars(r.rating)}</div>${r.comment ? `<p class="msg">${esc(r.comment)}</p>` : ''}<p class="meta">${when(r.created_at)}</p></article>`).join('') : '<p class="empty">No reviews yet.</p>'}</div>`;
};

/* ================= Emails ================= */
RENDER.emails = async () => {
  const d = await api('GET', '/emails');
  viewEl.innerHTML = `
    <div class="ad-head"><div><h1>Emails</h1><p>Every email the system tried to send, newest first. Admin copies go to ${esc(me.notify.join(', '))}.</p></div>${can('owner') ? '<div class="ad-actions"><button class="b" type="button" data-run-jobs>Run scheduled emails now</button></div>' : ''}</div>
    ${!d.mailEnabled ? '<div class="banner">SMTP is not configured, so emails are logged as skipped. Add SMTP_HOST, SMTP_USER and SMTP_PASS to the server settings.</div>' : ''}
    <div class="card-w"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Email</th><th>To</th><th>Booking</th><th>Status</th></tr></thead><tbody>
      ${d.items.map((x) => `<tr><td class="meta">${when(x.created_at)}</td><td>${esc(MAIL[x.kind] || x.kind)}<br><span class="meta">${esc(x.subject)}</span></td><td>${esc(x.recipient)}</td><td>${esc(x.reference || x.lead_ref || '')}</td><td>${pill(x.status === 'sent' ? 'CHECKED_IN' : x.status === 'failed' ? 'CANCELLED' : 'CHECKED_OUT', { CHECKED_IN: 'Sent', CANCELLED: 'Failed', CHECKED_OUT: 'Skipped' })}${x.error ? `<br><span class="meta">${esc(x.error)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No emails yet.</td></tr>'}
    </tbody></table></div></div>`;
  $('[data-run-jobs]')?.addEventListener('click', async () => {
    try { const o = await api('POST', '/jobs/run', {}); toast(`Check-out reminders: ${o.preCheckout}, review requests: ${o.reviews}`); refresh(); } catch (x) { toast(x.message, true); }
  });
};

/* ================= Activity ================= */
RENDER.activity = async () => {
  const d = await api('GET', '/audit');
  viewEl.innerHTML = `<div class="ad-head"><div><h1>Activity</h1><p>Who changed what, newest first.</p></div></div>
    <div class="card-w"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
    ${d.items.map((a) => `<tr><td class="meta" style="white-space:nowrap">${when(a.created_at)}</td><td>${esc(a.staff_name || 'System')}</td><td>${esc(a.summary)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nothing yet.</td></tr>'}
    </tbody></table></div></div>`;
};

/* ================= Staff ================= */
RENDER.staff = async () => {
  const d = await api('GET', '/staff');
  const roleHelp = { owner: 'everything, including staff and settings', manager: 'inventory, rates, bookings and leads', frontdesk: 'leads and bookings only' };
  viewEl.innerHTML = `<div class="ad-head"><div><h1>Staff</h1><p>Give each person their own sign-in. Owner: ${roleHelp.owner}. Manager: ${roleHelp.manager}. Front desk: ${roleHelp.frontdesk}.</p></div>
      <div class="ad-actions"><button class="b b--primary" type="button" data-staff-new>${icon('plus')}Add staff</button></div></div>
    <div class="card-w"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${d.items.map((u) => `<tr><td>${esc(u.name)}${u.isActive ? '' : ' <span class="pill">Off</span>'}${u.invited && u.isActive ? ' <span class="pill pill--new">Invited</span>' : ''}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td class="meta">${when(u.lastLoginAt) || 'never'}</td>
      <td class="row__actions"><button class="b b--sm" data-staff-edit="${u.id}">Edit</button>${u.isActive && u.id !== me.id ? `<button class="b b--sm" data-staff-link="${u.id}">${u.invited ? 'Resend invite' : 'Send reset link'}</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('[data-staff-new]').addEventListener('click', () => staffDialog(null, d.roles, d.mailEnabled));
  $$('[data-staff-edit]').forEach((b) => b.addEventListener('click', () => staffDialog(d.items.find((u) => u.id === Number(b.dataset.staffEdit)), d.roles, d.mailEnabled)));
  $$('[data-staff-link]').forEach((b) => b.addEventListener('click', async () => {
    const u = d.items.find((x) => x.id === Number(b.dataset.staffLink));
    try {
      const out = await api('POST', `/staff/${u.id}/link`, {});
      if (out.emailed) toast(`Link emailed to ${u.email}`);
      else linkDialog(u, out.link);
    } catch (x) { toast(x.message, true); }
  }));
};

function linkDialog(u, link) {
  openDialog(`${dlgHead(`Sign-in link for ${esc(u.name)}`)}
    <div class="dlg__body">
      <p>Email is not set up yet, so send this link to ${esc(u.name)} yourself (WhatsApp is fine). It works once, lets them choose their own password, and expires in ${u.invited ? '7 days' : '30 minutes'}.</p>
      <div class="copy-row"><input class="inp" readonly value="${esc(link)}" data-link-inp aria-label="Sign-in link"><button class="b" type="button" data-copy>Copy</button></div>
    </div>
    <div class="dlg__foot"><button class="b b--primary" type="button" data-close>Done</button></div>`, (dlg) => {
    $('[data-copy]', dlg).addEventListener('click', async () => {
      const inp = $('[data-link-inp]', dlg);
      try { await navigator.clipboard.writeText(inp.value); toast('Link copied'); } catch { inp.select(); document.execCommand('copy'); toast('Link copied'); }
    });
  });
}

function staffDialog(u, roles, mailEnabled) {
  openDialog(`${dlgHead(u ? `Edit ${esc(u.name)}` : 'Add staff')}
    <form data-staff-form novalidate><div class="dlg__body"><div class="fgrid">
      ${u ? '' : '<label class="f"><span>Name</span><input class="inp" name="name" required></label><label class="f"><span>Work email</span><input class="inp" type="email" name="email" required></label>'}
      <label class="f"><span>Role</span><select class="sel" name="role">${roles.map((r) => `<option value="${r}" ${(u?.role || 'frontdesk') === r ? 'selected' : ''}>${r === 'frontdesk' ? 'Front desk' : r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></label>
      ${u ? '' : `<div class="f full"><span>How do they get their password?</span>
        <label class="check"><input type="radio" name="how" value="invite" checked> ${mailEnabled ? 'Email them an invite link to choose their own' : 'Give me an invite link to send them (they choose their own password)'}</label>
        <label class="check"><input type="radio" name="how" value="password"> I will set a password now and tell them privately</label></div>`}
      <label class="f" data-pw-field ${u ? '' : 'hidden'}><span>${u ? 'New password (optional)' : 'Password'}</span><input class="inp" type="password" name="password" minlength="10" autocomplete="new-password"><small class="hint">At least 10 characters.${u ? ' Setting one signs them out everywhere.' : ''}</small></label>
      ${u ? `<label class="check full"><input type="checkbox" name="isActive" ${u.isActive ? 'checked' : ''} ${u.id === me.id ? 'disabled' : ''}> Can sign in</label>` : ''}
    </div><p class="note-box bad" data-err hidden></p></div>
    <div class="dlg__foot"><button class="b" type="button" data-close>Cancel</button><button class="b b--primary" type="submit">${u ? 'Save' : 'Add staff'}</button></div></form>`, (dlg) => {
    const f = $('[data-staff-form]', dlg);
    $$('[name=how]', f).forEach((r) => r.addEventListener('change', () => ($('[data-pw-field]', f).hidden = f.how.value !== 'password')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(f));
      if (u) { b.isActive = f.isActive.checked; if (!b.password) delete b.password; }
      else { b.invite = b.how === 'invite'; delete b.how; if (b.invite) delete b.password; }
      try {
        const out = await api(u ? 'PATCH' : 'POST', u ? `/staff/${u.id}` : '/staff', b);
        dialog.close();
        if (out.link) linkDialog({ name: b.name, invited: true }, out.link);
        else toast(b.invite ? `Invite emailed to ${b.email}` : 'Saved');
        refresh();
      } catch (x) { const n = $('[data-err]', dlg); n.textContent = x.message; n.hidden = false; }
    });
  });
}

/* ================= My account ================= */
async function accountDialog() {
  const s = await api('GET', '/me/sessions').catch(() => ({ items: [] }));
  const device = (ua) => (/iphone|android|mobile/i.test(ua || '') ? 'Phone' : /ipad|tablet/i.test(ua || '') ? 'Tablet' : 'Computer') + (/(edg|chrome|safari|firefox)/i.exec(ua || '') ? `, ${/(edg|chrome|firefox|safari)/i.exec(ua)[1].replace(/edg/i, 'Edge')}` : '');
  openDialog(`${dlgHead('My account')}
    <div class="dlg__body">
      <p class="meta">${esc(me.name)} &middot; ${esc(me.email)} &middot; ${esc(me.role)}</p>
      <form data-pw-form class="fgrid">
        <label class="f full"><span>Current password</span><input class="inp" type="password" name="current" autocomplete="current-password" required></label>
        <label class="f"><span>New password</span><input class="inp" type="password" name="next" minlength="10" autocomplete="new-password" required></label>
        <label class="f"><span>Type it again</span><input class="inp" type="password" name="confirm" minlength="10" autocomplete="new-password" required></label>
        <div class="full"><button class="b b--primary" type="submit">Change password</button> <span class="meta">Other devices will be signed out.</span></div>
        <p class="note-box bad full" data-err hidden></p>
      </form>
      <section><h3 class="f"><span>Signed in on</span></h3>
        <div class="mini">${s.items.map((x) => `<div><span>${device(x.device)}${x.current ? ' <span class="pill pill--booked">This device</span>' : ''}</span><span class="meta">since ${when(x.created_at)}${x.remember ? ', kept signed in' : ''}</span></div>`).join('') || '<p class="meta">No sessions.</p>'}</div>
        <button class="b mt-s" type="button" data-everywhere>Sign out of all devices</button>
      </section>
    </div>`, (dlg) => {
    $('[data-pw-form]', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      const err = $('[data-err]', dlg);
      if (b.next !== b.confirm) { err.textContent = 'The two new passwords do not match.'; err.hidden = false; return; }
      try { await api('POST', '/me/password', { current: b.current, next: b.next }); dialog.close(); toast('Password changed. Other devices are signed out.'); } catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    $('[data-everywhere]', dlg).addEventListener('click', async () => {
      if (!confirm('Sign out of every device, including this one?')) return;
      dialog.close();
      signOut(true);
    });
  });
}

if (linkToken) openLink(linkToken);
else start();
