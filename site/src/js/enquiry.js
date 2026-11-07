// Booking and contact enquiry forms: validate, send to /api/enquiries, then offer WhatsApp.
import site from '../../../data/site.json';

const $ = (s, el = document) => el.querySelector(s);
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nice = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function waLink(text) {
  return `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(text)}`;
}

function bookingText(d, ref) {
  const lines = [`Hello The Pinus Resort, I would like to check availability.`];
  if (ref) lines.push(`Reference: ${ref}`);
  if (d.checkIn) lines.push(`Check in: ${nice(d.checkIn)}`);
  if (d.checkOut) lines.push(`Check out: ${nice(d.checkOut)}`);
  if (d.adults) lines.push(`Guests: ${plural(+d.adults, 'adult', 'adults')}${+d.children ? `, ${plural(+d.children, 'child', 'children')} (5+)` : ''}${+d.infants ? `, ${d.infants} under 5` : ''}`);
  if (d.rooms) lines.push(`Rooms: ${d.rooms}${d.roomType && d.roomType !== 'Not sure yet' ? ` (${d.roomType})` : ''}`);
  if (d.name) lines.push(`Name: ${d.name}`);
  return lines.join('\n');
}

document.querySelectorAll('form[data-enquiry]').forEach((form) => {
  const kind = form.dataset.enquiry;
  const el = form.elements;
  const status = $('[data-status]', form);
  const submit = $('[data-submit]', form);

  /* Dates: sensible limits and hand-over from the home page booking bar */
  if (kind === 'booking') {
    const today = new Date();
    el.checkIn.min = iso(today);
    el.checkOut.min = iso(new Date(today.getTime() + 864e5));
    const params = new URLSearchParams(location.search);
    const map = { checkin: 'checkIn', checkout: 'checkOut', adults: 'adults', children: 'children', infants: 'infants', rooms: 'rooms', room: 'roomType' };
    for (const [q, name] of Object.entries(map)) {
      const v = params.get(q);
      if (v && el[name]) el[name].value = v;
    }
    el.checkIn.addEventListener('change', () => {
      if (!el.checkIn.value) return;
      const next = new Date(`${el.checkIn.value}T00:00:00`);
      next.setDate(next.getDate() + 1);
      el.checkOut.min = iso(next);
      if (!el.checkOut.value || el.checkOut.value <= el.checkIn.value) el.checkOut.value = iso(next);
      updateSummary();
    });
  }

  /* +/- steppers */
  form.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      const v = (parseInt(input.value, 10) || 0) + Number(b.dataset.step);
      input.value = Math.max(+input.min, Math.min(+input.max, v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  );

  /* Live summary panel */
  const sum = (k, v) => { const n = document.querySelector(`[data-sum="${k}"]`); if (n) n.textContent = v; };
  function updateSummary() {
    if (kind !== 'booking') return;
    sum('in', nice(el.checkIn.value) || 'Choose a date');
    sum('out', nice(el.checkOut.value) || 'Choose a date');
    const n = el.checkIn.value && el.checkOut.value ? Math.round((Date.parse(el.checkOut.value) - Date.parse(el.checkIn.value)) / 864e5) : 0;
    sum('nights', n > 0 ? String(n) : '–');
    const a = +el.adults.value || 0;
    const c = +el.children.value || 0;
    const i = +(el.infants?.value || 0);
    sum('guests', `${plural(a, 'adult', 'adults')}${c ? `, ${plural(c, 'child', 'children')} (5+)` : ''}${i ? `, ${i} under 5` : ''}`);
    sum('rooms', `${el.rooms.value || 1}${el.roomType.value !== 'Not sure yet' ? ` · ${el.roomType.value}` : ''}`);
  }
  form.addEventListener('input', updateSummary);
  form.addEventListener('change', updateSummary);
  updateSummary();

  /* Errors */
  function showErrors(fields = {}) {
    form.querySelectorAll('[data-error]').forEach((n) => {
      const msg = fields[n.dataset.error] || '';
      n.textContent = msg;
      const field = n.closest('.field');
      field?.classList.toggle('is-invalid', Boolean(msg));
      field?.querySelector('input, select, textarea')?.setAttribute('aria-invalid', String(Boolean(msg)));
    });
    const first = Object.keys(fields)[0];
    if (first && el[first]) el[first].focus();
  }

  function clientCheck(d) {
    const f = {};
    if (!d.name || d.name.trim().length < 2) f.name = 'Please tell us your name.';
    const digits = (d.phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) f.phone = 'Please enter a valid phone number with country code.';
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) f.email = 'Please check your email address.';
    if (kind === 'booking' && !d.email) f.email = 'Please add your email so we can send your confirmation.';
    if (kind === 'booking') {
      if (!d.checkIn) f.checkIn = 'Please choose your check-in date.';
      if (!d.checkOut) f.checkOut = 'Please choose your check-out date.';
      else if (d.checkIn && d.checkOut <= d.checkIn) f.checkOut = 'Check-out must be after check-in.';
    } else if (!d.message || d.message.trim().length < 5) f.message = 'Please write a short message.';
    return f;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.hidden = true;
    const d = Object.fromEntries(new FormData(form));
    d.kind = kind;
    d.source = location.pathname;
    const errs = clientCheck(d);
    showErrors(errs);
    if (Object.keys(errs).length) return;

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Sending...';
    try {
      const res = await fetch('/api/enquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 422) {
        showErrors(out.fields);
        throw new Error(out.error || 'Please check the highlighted fields.');
      }
      if (!res.ok) throw new Error(out.error || 'We could not send your enquiry.');
      success(d, out.ref);
    } catch (err) {
      status.classList.add('is-error');
      status.innerHTML = '';
      status.append(`${err.message} You can also reach us directly: `);
      const a = document.createElement('a');
      a.href = waLink(kind === 'booking' ? bookingText(d) : `Hello The Pinus Resort, ${d.message || ''}`);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'send it on WhatsApp';
      a.style.textDecoration = 'underline';
      status.append(a, '.');
      status.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  function success(d, ref) {
    const tpl = document.getElementById('tpl-success');
    const wrap = form.closest('[data-enquiry-wrap]') || form.parentElement;
    if (!tpl) { form.reset(); status.classList.remove('is-error'); status.textContent = `Thank you. Your reference is ${ref}.`; status.hidden = false; return; }
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('[data-s="name"]').textContent = d.name.split(' ')[0];
    node.querySelector('[data-s="phone"]').textContent = d.phone;
    node.querySelector('[data-s="ref"]').textContent = ref;
    node.querySelector('[data-s="wa"]').href = waLink(kind === 'booking' ? bookingText(d, ref) : `Hello The Pinus Resort, my reference is ${ref}. ${d.message}`);
    wrap.replaceChildren(node);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    node.focus({ preventScroll: true });
  }
});
