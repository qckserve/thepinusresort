// "Book this experience": a branded booking form for the activities on the Experiences page.
// Any element with data-book-activity="<code>" opens it; /activities/?book=<code> opens it on load.
// Requests go to /api/enquiries (kind "activity") and land in the admin under Leads.
import activities from '../../../data/activities.json';
import site from '../../../data/site.json';
import { enhanceForm } from './pickers.js';
import '../styles/activity.css';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nice = (v) => new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const byCode = (c) => activities.find((a) => a.code === c);

const modal = document.createElement('div');
modal.className = 'bk-modal';
modal.hidden = true;
modal.setAttribute('role', 'dialog');
modal.setAttribute('aria-modal', 'true');
modal.setAttribute('aria-labelledby', 'bk-title');
modal.innerHTML = `
  <div class="bk-backdrop" data-bk-close></div>
  <div class="bk-panel">
    <button type="button" class="bk-x" data-bk-close aria-label="Close">&times;</button>
    <div data-bk-body>
      <div class="bk-head">
        <p class="eyebrow">Book an experience</p>
        <h2 class="h3" id="bk-title" data-bk-name></h2>
        <p class="bk-where" data-bk-where></p>
        <p class="bk-note" data-bk-note></p>
      </div>
      <form class="form" data-activity-form novalidate>
        <div class="field full">
          <label for="a-act">Experience</label>
          <select id="a-act" name="activity">${activities.map((a) => `<option value="${a.code}">${esc(a.name)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="a-date">Date</label>
          <input id="a-date" name="date" type="date" required>
          <span class="field__error" data-error="date"></span>
        </div>
        <div class="field">
          <label for="a-slot">Time</label>
          <select id="a-slot" name="slot"></select>
        </div>
        <div class="field">
          <label for="a-adults">Adults</label>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="One adult fewer"><svg class="icon"><use href="#i-minus"/></svg></button>
            <input id="a-adults" name="adults" type="number" inputmode="numeric" min="1" max="40" value="2">
            <button type="button" data-step="1" aria-label="One adult more"><svg class="icon"><use href="#i-plus"/></svg></button>
          </div>
          <span class="field__error" data-error="adults"></span>
        </div>
        <div class="field">
          <label for="a-children">Children <span class="lbl-soft">(under 12)</span></label>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="One child fewer"><svg class="icon"><use href="#i-minus"/></svg></button>
            <input id="a-children" name="children" type="number" inputmode="numeric" min="0" max="20" value="0">
            <button type="button" data-step="1" aria-label="One child more"><svg class="icon"><use href="#i-plus"/></svg></button>
          </div>
        </div>
        <div class="field full">
          <label for="a-name">Full name</label>
          <input id="a-name" name="name" type="text" autocomplete="name" maxlength="120" required>
          <span class="field__error" data-error="name"></span>
        </div>
        <div class="field">
          <label for="a-phone">Mobile / WhatsApp</label>
          <input id="a-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+91 98765 43210" maxlength="30" required>
          <span class="field__error" data-error="phone"></span>
        </div>
        <div class="field">
          <label for="a-email">Email <span class="lbl-soft">(for your confirmation)</span></label>
          <input id="a-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="160" required>
          <span class="field__error" data-error="email"></span>
        </div>
        <div class="field">
          <label for="a-ref">Staying with us? <span class="lbl-soft">(booking reference, optional)</span></label>
          <input id="a-ref" name="stayRef" type="text" maxlength="20" placeholder="TPR-..." autocomplete="off">
        </div>
        <div class="field">
          <label for="a-msg">Anything we should know? <span class="lbl-soft">(optional)</span></label>
          <input id="a-msg" name="message" type="text" maxlength="500" placeholder="Pick-up time, ages, fitness...">
        </div>
        <div class="hp" aria-hidden="true"><label for="a-web">Website</label><input id="a-web" name="website" tabindex="-1" autocomplete="off"></div>
        <div class="full form-status is-error" role="alert" data-bk-status hidden></div>
        <div class="full btn-row">
          <button class="btn" type="submit" data-bk-submit>Request this experience</button>
          <p class="form-note">No payment now. We confirm the plan and price by call or WhatsApp.</p>
        </div>
      </form>
    </div>
  </div>`;
document.body.append(modal);

const form = $('[data-activity-form]', modal);
const el = form.elements;
el.date.min = iso(new Date());
enhanceForm(form);

function setActivity(code) {
  const a = byCode(code) || activities[0];
  el.activity.value = a.code;
  $('[data-bk-name]', modal).textContent = a.name;
  $('[data-bk-where]', modal).textContent = a.where;
  $('[data-bk-note]', modal).textContent = a.note;
  el.slot.innerHTML = a.slots.map((s) => `<option>${esc(s)}</option>`).join('');
  el.slot.value = a.slots[0];
  el.adults.max = a.maxPeople;
  if (+el.adults.value > a.maxPeople) el.adults.value = a.maxPeople;
}
el.activity.addEventListener('change', () => setActivity(el.activity.value));

form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const input = b.parentElement.querySelector('input');
  input.value = Math.max(+input.min, Math.min(+input.max, (parseInt(input.value, 10) || 0) + Number(b.dataset.step)));
}));

/* ---------- Open / close ---------- */
let opener = null;
function open(code, trigger) {
  // Opening again after a sent request starts with the form, not the old thank-you.
  if ($('[data-bk-body]', modal).dataset.saved) restoreForm();
  setActivity(code);
  opener = trigger || document.activeElement;
  modal.hidden = false;
  document.documentElement.classList.add('bk-lock');
  requestAnimationFrame(() => modal.classList.add('is-open'));
  setTimeout(() => $('#a-date-pk', modal)?.focus(), 50);
}
function close() {
  modal.classList.remove('is-open');
  document.documentElement.classList.remove('bk-lock');
  setTimeout(() => { modal.hidden = true; }, 200);
  opener?.focus?.();
}
modal.addEventListener('click', (e) => { if (e.target.closest('[data-bk-close]')) close(); });
addEventListener('keydown', (e) => {
  if (modal.hidden || e.defaultPrevented) return;
  if (e.key === 'Escape' && !document.querySelector('.pk-pop:not([hidden])')) close();
  if (e.key === 'Tab') {
    // Keep focus inside the dialog.
    const f = [...modal.querySelectorAll('button:not([disabled]), input:not([type=hidden]):not(.pk-native):not([tabindex="-1"]), select:not(.pk-native), textarea, a[href]')].filter((x) => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-book-activity]');
  if (!b) return;
  e.preventDefault();
  open(b.dataset.bookActivity, b);
});

/* ---------- Submit ---------- */
const status = $('[data-bk-status]', modal);
function showErrors(fields = {}) {
  form.querySelectorAll('[data-error]').forEach((n) => {
    const msg = fields[n.dataset.error] || '';
    n.textContent = msg;
    n.closest('.field')?.classList.toggle('is-invalid', Boolean(msg));
  });
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.hidden = true;
  const d = Object.fromEntries(new FormData(form));
  const f = {};
  if (!d.date) f.date = 'Please choose a date.';
  if ((d.name || '').trim().length < 2) f.name = 'Please tell us your name.';
  const digits = (d.phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) f.phone = 'Please enter a valid phone number with country code.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email || '')) f.email = 'Please add your email so we can send your confirmation.';
  showErrors(f);
  if (Object.keys(f).length) return;
  const btn = $('[data-bk-submit]', modal);
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const res = await fetch('/api/enquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...d, kind: 'activity', source: location.pathname }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 422) { showErrors(out.fields); throw new Error(out.error); }
    if (!res.ok) throw new Error(out.error || 'We could not send your request.');
    success(d, out.ref);
  } catch (err) {
    const a = byCode(d.activity);
    status.innerHTML = `${esc(err.message || 'We could not send your request.')} You can also <a href="https://wa.me/${site.whatsapp}?text=${encodeURIComponent(`Hello The Pinus Resort, I would like to book ${a?.name} on ${d.date ? nice(d.date) : 'a date to be confirmed'} for ${d.adults} people.`)}" target="_blank" rel="noopener">send it on WhatsApp</a>.`;
    status.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request this experience';
  }
});

function success(d, ref) {
  const a = byCode(d.activity);
  const body = $('[data-bk-body]', modal);
  const wa = `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(`Hello The Pinus Resort, my request reference is ${ref}: ${a.name} on ${nice(d.date)} (${d.slot}), ${d.adults} adult(s)${+d.children ? ` and ${d.children} child(ren)` : ''}. Name: ${d.name}.`)}`;
  body.dataset.saved = '1';
  body.querySelectorAll(':scope > *').forEach((n) => (n.hidden = true));
  body.insertAdjacentHTML('beforeend', `<div class="bk-done" tabindex="-1">
    <svg class="icon" aria-hidden="true"><use href="#i-check-circle"/></svg>
    <p class="eyebrow">Request received</p>
    <h2 class="h3">Thank you, ${esc(d.name.split(' ')[0])}</h2>
    <p class="bk-done-line"><b>${esc(a.name)}</b><br>${nice(d.date)} &middot; ${esc(d.slot)} &middot; ${d.adults} adult${+d.adults > 1 ? 's' : ''}${+d.children ? `, ${d.children} child${+d.children > 1 ? 'ren' : ''}` : ''}</p>
    <p>We will call or WhatsApp you on <b>${esc(d.phone)}</b> to confirm the plan and price. Your reference:</p>
    <span class="bk-ref">${esc(ref)}</span>
    <div class="btn-row"><a class="btn" href="${wa}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-whatsapp"/></svg>Continue on WhatsApp</a><button type="button" class="link-u" data-bk-another>Book another experience</button></div>
  </div>`);
  $('.bk-done', body).focus();
  $('[data-bk-another]', body).addEventListener('click', () => { restoreForm(); setTimeout(() => $('#a-act-pk', modal)?.focus(), 30); });
}
function restoreForm() {
  const body = $('[data-bk-body]', modal);
  body.querySelector('.bk-done')?.remove();
  body.querySelectorAll(':scope > *').forEach((n) => (n.hidden = false));
  delete body.dataset.saved;
  // Contact details stay filled in for a second booking.
  el.date.value = '';
  el.message.value = '';
  showErrors();
}
/* Deep link: /activities/?book=fishing */
const want = new URLSearchParams(location.search).get('book');
if (want && byCode(want)) open(want);

export { open as openActivityBooking };
