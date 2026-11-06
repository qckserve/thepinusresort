// Shared behaviour for every page. No framework: small, fast, progressive.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Header shadow once the page scrolls */
const header = $('[data-header]');
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* Mobile drawer */
const drawer = $('[data-drawer]');
const openBtn = $('[data-menu-open]');
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  openBtn?.setAttribute('aria-expanded', String(open));
  if (open) $('[data-menu-close]', drawer)?.focus();
  else openBtn?.focus();
}
openBtn?.addEventListener('click', () => setMenu(true));
$('[data-menu-close]')?.addEventListener('click', () => setMenu(false));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) setMenu(false);
});

/* Hero crossfade slider */
$$('[data-hero]').forEach((hero) => {
  const slides = $$('.hero__slide', hero);
  const dots = $$('[data-hero-dot]', hero);
  if (slides.length < 2) return;
  let i = 0;
  let timer;
  const show = (n) => {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle('is-active', k === i));
    dots.forEach((d, k) => d.setAttribute('aria-current', String(k === i)));
    // Load the next slide's image ahead of time.
    const next = slides[(i + 1) % slides.length]?.querySelector('img');
    if (next) next.loading = 'eager';
  };
  const play = () => {
    if (reduceMotion) return;
    clearInterval(timer);
    timer = setInterval(() => show(i + 1), 6500);
  };
  dots.forEach((d, k) => d.addEventListener('click', () => { show(k); play(); }));
  show(0);
  play();
});

/* Scroll-snap sliders with arrows and dots */
$$('[data-slider]').forEach((slider) => {
  const track = $('.slider__track', slider);
  const items = [...track.children];
  const dotsWrap = slider.parentElement.querySelector('[data-slider-dots]') || $('[data-slider-dots]', slider);
  const go = (n) => {
    const left = items[Math.max(0, Math.min(items.length - 1, n))].offsetLeft - track.offsetLeft;
    const from = track.scrollLeft;
    track.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
    // Some browsers skip smooth scrolling (power saving, background tabs): jump instead.
    setTimeout(() => { if (track.scrollLeft === from && from !== left) track.scrollTo({ left, behavior: 'auto' }); }, 500);
  };
  const current = () => Math.round(track.scrollLeft / track.clientWidth);
  $('.slider__btn--prev', slider)?.addEventListener('click', () => go(current() - 1));
  $('.slider__btn--next', slider)?.addEventListener('click', () => go(current() + 1));
  if (dotsWrap) {
    dotsWrap.innerHTML = items.map((_, k) => `<button type="button" aria-label="Show photo ${k + 1}"></button>`).join('');
    const dots = [...dotsWrap.children];
    const sync = () => dots.forEach((d, k) => d.setAttribute('aria-current', String(k === current())));
    dots.forEach((d, k) => d.addEventListener('click', () => go(k)));
    track.addEventListener('scroll', sync, { passive: true });
    track.addEventListener('scrollend', sync);
    sync();
  }
});

/* Tabs (with optional matching images) */
$$('[data-tabs]').forEach((wrap) => {
  const tabs = $$('[role="tab"]', wrap);
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const pics = $$('[data-tab-img]', wrap);
  const select = (k, focus) => {
    tabs.forEach((t, j) => {
      const on = j === k;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panels[j].hidden = !on;
    });
    pics.forEach((p, j) => p.classList.toggle('is-active', j === k));
    if (focus) tabs[k].focus();
  };
  tabs.forEach((t, k) => {
    t.addEventListener('click', () => select(k));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') select((k + 1) % tabs.length, true);
      if (e.key === 'ArrowLeft') select((k - 1 + tabs.length) % tabs.length, true);
    });
  });
});

/* Booking bar: hand the dates over to the reservation page */
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$$('[data-booking]').forEach((form) => {
  const inEl = form.elements.checkin;
  const outEl = form.elements.checkout;
  const today = new Date();
  inEl.min = iso(today);
  const sync = () => {
    if (!inEl.value) return;
    const next = new Date(inEl.value);
    next.setDate(next.getDate() + 1);
    outEl.min = iso(next);
    if (!outEl.value || outEl.value <= inEl.value) outEl.value = iso(next);
  };
  inEl.addEventListener('change', sync);
  outEl.min = iso(new Date(today.getTime() + 864e5));
});

/* Gallery filters */
$$('[data-filters]').forEach((bar) => {
  const grid = document.getElementById(bar.dataset.filters);
  $$('button', bar).forEach((b) =>
    b.addEventListener('click', () => {
      $$('button', bar).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const f = b.dataset.filter;
      $$('figure', grid).forEach((fig) => (fig.hidden = f !== 'all' && fig.dataset.cat !== f));
    }),
  );
});

/* Lightbox for any [data-lightbox-group] */
const lb = $('[data-lightbox]');
if (lb) {
  const img = $('[data-lb-img]', lb);
  const cap = $('[data-lb-cap]', lb);
  let list = [];
  let idx = 0;
  let opener = null;
  const render = () => {
    const el = list[idx];
    const src = el.querySelector('img');
    img.src = el.dataset.full || src.currentSrc || src.src;
    img.alt = src.alt;
    cap.textContent = el.dataset.caption || src.alt;
  };
  const open = (group, el) => {
    list = $$(`[data-lightbox-group="${group}"]`).filter((x) => !x.closest('[hidden]'));
    idx = list.indexOf(el);
    opener = document.activeElement;
    render();
    lb.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    $('[data-lb-close]', lb).focus();
  };
  const close = () => {
    lb.classList.remove('is-open');
    document.body.style.overflow = '';
    opener?.focus();
  };
  const step = (d) => { idx = (idx + d + list.length) % list.length; render(); };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-lightbox-group]');
    if (!el) return;
    e.preventDefault();
    open(el.dataset.lightboxGroup, el);
  });
  $('[data-lb-close]', lb).addEventListener('click', close);
  $('[data-lb-prev]', lb).addEventListener('click', () => step(-1));
  $('[data-lb-next]', lb).addEventListener('click', () => step(1));
  lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
  addEventListener('keydown', (e) => {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

/* Click-to-load map (keeps Google's heavy embed off the first paint) */
$$('[data-map]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const f = document.createElement('iframe');
    f.src = btn.dataset.map;
    f.title = 'Map showing The Pinus Resort in Nunwan, Pahalgam';
    f.loading = 'lazy';
    f.referrerPolicy = 'no-referrer-when-downgrade';
    btn.replaceWith(f);
  }),
);

/* Reveal on scroll. Falls back to showing everything if the observer never fires. */
const revealEls = $$('[data-reveal]');
if (revealEls.length && 'IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver(
    (entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
    }),
    { rootMargin: '0px 0px -8% 0px' },
  );
  revealEls.forEach((el) => io.observe(el));
  setTimeout(() => revealEls.forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight) el.classList.add('is-in');
  }), 1500);
} else {
  revealEls.forEach((el) => el.classList.add('is-in'));
}
