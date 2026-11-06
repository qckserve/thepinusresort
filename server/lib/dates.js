// Date helpers on whole UTC days (ported from hotelinventorysystem/src/lib/dates.ts).
// Stay dates are plain YYYY-MM-DD strings; the resort runs on India time.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const TZ = 'Asia/Kolkata';
export const MAX_NIGHTS = 30;

export function isIsoDate(v) {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** Nights a guest occupies: check-in inclusive, check-out exclusive. */
export const stayNights = (checkIn, checkOut) => Array.from({ length: daysBetween(checkIn, checkOut) }, (_, i) => addDays(checkIn, i));
/** 0 = Sunday ... 6 = Saturday */
export const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function hourNow(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
}
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export function niceDate(iso, opts = {}) {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts });
}
