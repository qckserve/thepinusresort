// Branded date range picker and dropdown for the public booking forms.
// They sit on top of the real <input type="date"> and <select>, which stay in the form as the
// source of truth: values, min dates, validation and the existing form scripts all keep working.
// Programmatic changes (e.g. check-out moved after check-in) update the display automatically.
import '../styles/pickers.css';

const pad = (n) => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m: m - 1, d }; };
const addDays = (iso, n) => { const { y, m, d } = parts(iso); return new Date(Date.UTC(y, m, d + n)).toISOString().slice(0, 10); };
const todayIso = () => { const t = new Date(); return toIso(t.getFullYear(), t.getMonth(), t.getDate()); };
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const nice = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', opts);
const MONTH = (y, m) => new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const fire = (el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" class="pk-ico"><path d="${d}"/></svg>`;
const ICON = {
  cal: svg('M4 6.5h16v13H4zM4 10.5h16M8.5 4v4M15.5 4v4'),
  down: svg('M6 9.5l6 6 6-6'),
  left: svg('M14.5 6l-6 6 6 6'),
  right: svg('M9.5 6l6 6-6 6'),
  check: svg('M5 12.5l4.5 4.5L19 7.5'),
};

/** Re-render a widget whenever code sets .value directly (no event fires for that). */
function watchValue(el, onChange) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); onChange(); },
  });
  el.addEventListener('change', onChange);
}

function labelFor(el) {
  const l = el.id && document.querySelector(`label[for="${el.id}"]`);
  return { node: l, text: l ? l.textContent.replace(/\s+/g, ' ').trim() : el.name };
}

/** Replace the native control with a button, keeping the native one hidden in the form. */
function makeTrigger(el, cls) {
  el.classList.add('pk-native');
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `pk-trigger ${cls}`;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  el.after(btn);
  const { node, text } = labelFor(el);
  if (node) { btn.id = `${el.id}-pk`; node.htmlFor = btn.id; }
  // Form scripts focus the native control on errors; send that focus to the button.
  el.addEventListener('focus', () => btn.focus());
  return { btn, label: text };
}

/* ---------- One shared popover ---------- */
const pop = document.createElement('div');
pop.className = 'pk-pop';
pop.hidden = true;
const scrim = document.createElement('div');
scrim.className = 'pk-scrim';
scrim.hidden = true;
let active = null; // { trigger, onClose }

function place(anchor) {
  const sheet = innerWidth < 640;
  pop.classList.toggle('pk-sheet', sheet);
  scrim.hidden = !sheet;
  document.documentElement.classList.toggle('pk-lock', sheet);
  if (sheet) { pop.style.cssText = ''; return; }
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r.left + scrollX;
  left = Math.max(scrollX + 12, Math.min(left, scrollX + innerWidth - w - 12));
  const below = r.bottom + 8;
  const top = below + h > innerHeight - 8 && r.top - h - 8 > 70 ? r.top + scrollY - h - 8 : below + scrollY;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openPop(trigger, onClose) {
  if (active && active.trigger !== trigger) closePop(false);
  if (!pop.isConnected) document.body.append(scrim, pop);
  active = { trigger, onClose };
  pop.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
}
function closePop(focusTrigger = true) {
  if (!active) return;
  const { trigger, onClose } = active;
  active = null;
  pop.hidden = true;
  scrim.hidden = true;
  pop.innerHTML = '';
  document.documentElement.classList.remove('pk-lock');
  trigger.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (focusTrigger) trigger.focus();
}
document.addEventListener('pointerdown', (e) => {
  if (active && !pop.contains(e.target) && !active.trigger.contains(e.target)) closePop(false);
});
scrim.addEventListener('click', () => closePop());
addEventListener('keydown', (e) => { if (active && e.key === 'Escape') { e.preventDefault(); closePop(); } });
addEventListener('resize', () => { if (active) place(active.anchor || active.trigger); });

/* ---------- Date range picker ---------- */
function setupDates(form) {
  const inputs = [...form.querySelectorAll('input[type="date"]')];
  if (!inputs.length) return;
  const [start, end] = inputs.length >= 2 ? inputs : [inputs[0], null];
  const fields = [start, end].filter(Boolean).map((el, i) => {
    const t = makeTrigger(el, 'pk-date');
    return { el, ...t, role: end ? (i === 0 ? 'start' : 'end') : 'single' };
  });

  const refresh = () => {
    for (const f of fields) {
      const v = f.el.value;
      f.btn.innerHTML = `<span class="pk-val ${v ? '' : 'is-empty'}">${v ? nice(v) : 'Add date'}</span>${ICON.cal}`;
      f.btn.setAttribute('aria-label', `${f.label}: ${v ? nice(v, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'not chosen'}`);
    }
  };
  fields.forEach((f) => watchValue(f.el, refresh));
  refresh();

  let mode = 'start';
  let view = null; // first visible month { y, m }
  let hover = null;

  const minFor = (m) => {
    const t = todayIso();
    if (m === 'end' && start.value) return [end.min, addDays(start.value, 1), t].filter(Boolean).sort().at(-1);
    const el = m === 'end' ? end : start;
    return [el.min, t].filter(Boolean).sort().at(-1);
  };
  const maxIso = addDays(todayIso(), 540);
  const months = () => (innerWidth >= 760 && end ? 2 : 1);

  function monthHtml(y, m, min) {
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const s = start.value;
    const e = end?.value;
    const t = todayIso();
    const previewEnd = mode === 'end' && s && hover && hover > s ? hover : null;
    const rangeEnd = previewEnd || e;
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<td></td>';
    for (let d = 1; d <= days; d++) {
      const iso = toIso(y, m, d);
      const off = iso < min || iso > maxIso;
      const cls = [
        iso === t && 'is-today',
        end && s && iso === s && 'is-start',
        end && rangeEnd && iso === rangeEnd && 'is-end',
        end && s && rangeEnd && iso > s && iso < rangeEnd && 'is-range',
        !end && iso === s && 'is-start is-end',
        previewEnd && iso === previewEnd && 'is-preview',
      ].filter(Boolean).join(' ');
      const sel = iso === s || iso === e;
      cells += `<td><button type="button" class="pk-day ${cls}" data-iso="${iso}" ${off ? 'disabled' : ''} aria-pressed="${sel}" aria-label="${nice(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${iso === t ? ', today' : ''}" tabindex="-1">${d}</button></td>`;
      if ((first + d) % 7 === 0 && d < days) cells += '</tr><tr>';
    }
    return `<div class="pk-month"><div class="pk-mtitle">${MONTH(y, m)}</div>
      <table class="pk-grid" role="grid"><thead><tr>${DOW.map((x) => `<th scope="col" abbr="${x}">${x}</th>`).join('')}</tr></thead><tbody><tr>${cells}</tr></tbody></table></div>`;
  }

  function render(focusIso) {
    const min = minFor(mode);
    const n = months();
    const s = start.value;
    const e = end?.value;
    const label = mode === 'end' ? 'Choose your check-out date' : end ? 'Choose your check-in date' : `Choose ${fields[0].label.toLowerCase()}`;
    const summary = s && e && end ? `<b>${nights(s, e)} night${nights(s, e) > 1 ? 's' : ''}</b> &middot; ${nice(s, { day: 'numeric', month: 'short' })} to ${nice(e, { day: 'numeric', month: 'short' })}` : '';
    let html = `<div class="pk-cal" role="dialog" aria-modal="false" aria-label="${label}">
      <div class="pk-top">
        ${end ? `<div class="pk-steps"><button type="button" class="pk-step ${mode === 'start' ? 'is-on' : ''}" data-mode="start"><small>Check in</small>${s ? nice(s, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Add date'}</button><span class="pk-arrow">${ICON.right}</span><button type="button" class="pk-step ${mode === 'end' ? 'is-on' : ''}" data-mode="end" ${s ? '' : 'disabled'}><small>Check out</small>${e ? nice(e, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Add date'}</button></div>` : `<p class="pk-label">${label}</p>`}
        <button type="button" class="pk-close" data-close aria-label="Close">&times;</button>
      </div>
      <div class="pk-body">
        <button type="button" class="pk-nav pk-prev" data-nav="-1" aria-label="Previous month" ${view.y * 12 + view.m <= parts(todayIso()).y * 12 + parts(todayIso()).m ? 'disabled' : ''}>${ICON.left}</button>
        <button type="button" class="pk-nav pk-next" data-nav="1" aria-label="Next month">${ICON.right}</button>
        <div class="pk-months">`;
    for (let i = 0; i < n; i++) {
      const d = new Date(view.y, view.m + i, 1);
      html += monthHtml(d.getFullYear(), d.getMonth(), min);
    }
    html += `</div></div>
      <div class="pk-foot"><span class="pk-sum" aria-live="polite">${summary || (mode === 'end' ? 'Now pick the day you leave' : end ? 'Pick the day you arrive' : 'Pick a date')}</span><button type="button" class="pk-done" data-close>Done</button></div>
    </div>`;
    pop.innerHTML = html;
    // Roving focus: one day is tabbable.
    const want = focusIso || (mode === 'end' ? e || (s && addDays(s, 1)) : s) || min;
    const target = pop.querySelector(`.pk-day[data-iso="${want}"]:not([disabled])`) || pop.querySelector('.pk-day:not([disabled])');
    if (target) target.tabIndex = 0;
    return target;
  }

  function show(m, focus = true) {
    mode = m;
    const base = (m === 'end' ? end.value || (start.value && addDays(start.value, 1)) : start.value) || minFor(m);
    const p = parts(base);
    // Keep the view if the date is already visible.
    const visible = view && (p.y * 12 + p.m) >= view.y * 12 + view.m && (p.y * 12 + p.m) < view.y * 12 + view.m + months();
    if (!visible) view = { y: p.y, m: p.m };
    const f = fields.find((x) => x.role === m || x.role === 'single');
    openPop(f.btn, () => { hover = null; });
    active.anchor = fields[0].btn;
    const t = render();
    place(fields[0].btn);
    if (focus) t?.focus();
  }

  function pick(iso) {
    if (!end) { start.value = iso; fire(start); closePop(); return; }
    if (mode === 'start' || !start.value || iso <= start.value) {
      start.value = iso;
      fire(start); // the form scripts move check-out after check-in if needed
      if (end.value && end.value <= iso) { end.value = addDays(iso, 1); fire(end); }
      mode = 'end';
      render(end.value || addDays(iso, 1))?.focus();
      return;
    }
    end.value = iso;
    fire(end);
    render(iso);
    setTimeout(() => closePop(), 180);
  }

  fields.forEach((f) => f.btn.addEventListener('click', () => (active?.trigger === f.btn ? closePop() : show(f.role === 'single' ? 'start' : f.role))));

  pop.addEventListener('click', (e) => {
    if (!active || !fields.some((f) => f.btn === active.trigger)) return;
    const day = e.target.closest('.pk-day');
    if (day && !day.disabled) return pick(day.dataset.iso);
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const d = new Date(view.y, view.m + Number(nav.dataset.nav), 1);
      view = { y: d.getFullYear(), m: d.getMonth() };
      render();
      pop.querySelector(`[data-nav="${nav.dataset.nav}"]`)?.focus();
      return;
    }
    const step = e.target.closest('[data-mode]');
    if (step && !step.disabled) { mode = step.dataset.mode; render()?.focus(); return; }
    if (e.target.closest('[data-close]')) closePop();
  });
  pop.addEventListener('pointerover', (e) => {
    if (!active || mode !== 'end' || !fields.some((f) => f.btn === active.trigger)) return;
    const day = e.target.closest('.pk-day:not([disabled])');
    const iso = day?.dataset.iso || null;
    if (iso === hover) return;
    hover = iso;
    // Repaint the range preview without moving focus.
    const s = start.value;
    pop.querySelectorAll('.pk-day').forEach((b) => {
      const v = b.dataset.iso;
      const endIso = hover && hover > s ? hover : end.value;
      b.classList.toggle('is-range', !!(s && endIso && v > s && v < endIso));
      b.classList.toggle('is-end', !!(endIso && v === endIso));
      b.classList.toggle('is-preview', !!(hover && hover > s && v === hover));
    });
  });
  pop.addEventListener('keydown', (e) => {
    if (!active || !fields.some((f) => f.btn === active.trigger)) return;
    const day = e.target.closest('.pk-day');
    if (!day) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -30, PageDown: 30 }[e.key];
    if (e.key === 'Home' || e.key === 'End' || step) {
      e.preventDefault();
      let iso = step ? addDays(day.dataset.iso, step) : addDays(day.dataset.iso, e.key === 'Home' ? -new Date(`${day.dataset.iso}T00:00:00`).getDay() : 6 - new Date(`${day.dataset.iso}T00:00:00`).getDay());
      const min = minFor(mode);
      if (iso < min) iso = min;
      if (iso > maxIso) iso = maxIso;
      let btn = pop.querySelector(`.pk-day[data-iso="${iso}"]`);
      if (!btn) {
        const p = parts(iso);
        view = step && step < 0 ? { y: p.y, m: p.m } : (() => { const d = new Date(p.y, p.m - (months() - 1), 1); return { y: d.getFullYear(), m: d.getMonth() }; })();
        render(iso);
        btn = pop.querySelector(`.pk-day[data-iso="${iso}"]`);
      }
      if (btn && !btn.disabled) {
        pop.querySelectorAll('.pk-day').forEach((b) => (b.tabIndex = -1));
        btn.tabIndex = 0;
        btn.focus();
      }
    }
  });
}

/* ---------- Dropdown ---------- */
let uid = 0;
function setupSelect(sel) {
  const { btn, label } = makeTrigger(sel, 'pk-select');
  btn.setAttribute('aria-haspopup', 'listbox');
  const id = `pk-list-${++uid}`;
  const refresh = () => {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = `<span class="pk-val">${o ? o.textContent : ''}</span>${ICON.down}`;
    btn.setAttribute('aria-label', `${label}: ${o ? o.textContent : 'none'}`);
  };
  watchValue(sel, refresh);
  refresh();

  let index = 0;
  const opts = () => [...sel.options].filter((o) => !o.disabled);
  function render() {
    const list = opts();
    pop.innerHTML = `<ul class="pk-list" role="listbox" id="${id}" tabindex="-1" aria-label="${label}" aria-activedescendant="${id}-${index}">
      ${list.map((o, i) => `<li role="option" id="${id}-${i}" class="pk-opt ${i === index ? 'is-active' : ''}" aria-selected="${o.value === sel.value}" data-i="${i}"><span>${o.textContent}</span>${o.value === sel.value ? ICON.check : ''}</li>`).join('')}
    </ul>`;
    pop.style.minWidth = `${Math.max(220, btn.offsetWidth)}px`;
    pop.querySelector('.pk-opt.is-active')?.scrollIntoView({ block: 'nearest' });
  }
  function open() {
    index = Math.max(0, opts().findIndex((o) => o.value === sel.value));
    openPop(btn, () => { pop.style.minWidth = ''; });
    active.anchor = btn;
    render();
    place(btn);
    pop.querySelector('.pk-list').focus();
  }
  function choose(i) {
    const o = opts()[i];
    if (o) { sel.value = o.value; fire(sel); }
    closePop();
  }
  btn.addEventListener('click', () => (active?.trigger === btn ? closePop() : open()));
  btn.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
  let typed = '';
  let typedAt = 0;
  pop.addEventListener('click', (e) => {
    if (active?.trigger !== btn) return;
    const li = e.target.closest('.pk-opt');
    if (li) choose(Number(li.dataset.i));
  });
  pop.addEventListener('pointermove', (e) => {
    if (active?.trigger !== btn) return;
    const li = e.target.closest('.pk-opt');
    if (li && Number(li.dataset.i) !== index) { index = Number(li.dataset.i); render(); pop.querySelector('.pk-list').focus({ preventScroll: true }); }
  });
  pop.addEventListener('keydown', (e) => {
    if (active?.trigger !== btn) return;
    const n = opts().length;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      e.preventDefault();
      index = k === 'Home' ? 0 : k === 'End' ? n - 1 : (index + (k === 'ArrowDown' ? 1 : -1) + n) % n;
      render();
      pop.querySelector('.pk-list').focus();
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      choose(index);
    } else if (k === 'Tab') {
      closePop(false);
    } else if (k.length === 1 && /\S/.test(k)) {
      const now = Date.now();
      typed = now - typedAt > 700 ? k.toLowerCase() : typed + k.toLowerCase();
      typedAt = now;
      const i = opts().findIndex((o) => o.textContent.trim().toLowerCase().startsWith(typed));
      if (i >= 0) { index = i; render(); pop.querySelector('.pk-list').focus(); }
    }
  });
}

/* ---------- Apply to the public booking forms (not the staff admin) ---------- */
/** Enhance one form's date fields and dropdowns (also used for forms added later). */
export function enhanceForm(form) {
  if (form.dataset.pk) return;
  form.dataset.pk = '1';
  if (form.querySelector('input[type="date"]')) setupDates(form);
  form.querySelectorAll('.booking__field select, .field select').forEach(setupSelect);
}
if (!document.body.classList.contains('admin')) document.querySelectorAll('form').forEach(enhanceForm);
