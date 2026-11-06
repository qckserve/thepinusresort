// Server-side checks for the enquiry form. The browser checks too, but never trust it.
const clean = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const int = (v, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export const ROOM_TYPES = ['Deluxe Room', 'Not sure yet'];

export function validateEnquiry(body = {}) {
  const errors = {};
  const kind = body.kind === 'contact' ? 'contact' : 'booking';
  const name = clean(body.name, 120);
  const phone = clean(body.phone, 30);
  const email = clean(body.email, 160).toLowerCase();
  const message = typeof body.message === 'string'
    ? body.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000)
    : '';

  if (name.length < 2) errors.name = 'Please tell us your name.';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) errors.phone = 'Please enter a valid phone number with country code.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Please check your email address.';
  if (kind === 'booking' && !email) errors.email = 'Please add your email so we can send your confirmation.';

  const out = { kind, name, phone, email: email || null, message: message || null, source: clean(body.source, 120) || null };

  if (kind === 'booking') {
    const checkIn = clean(body.checkIn, 10);
    const checkOut = clean(body.checkOut, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (!isDate(checkIn)) errors.checkIn = 'Please choose your check-in date.';
    else if (checkIn < today) errors.checkIn = 'Check-in cannot be in the past.';
    if (!isDate(checkOut)) errors.checkOut = 'Please choose your check-out date.';
    else if (isDate(checkIn) && checkOut <= checkIn) errors.checkOut = 'Check-out must be after check-in.';
    const adults = int(body.adults, 1, 40);
    const children = int(body.children ?? 0, 0, 20);
    const rooms = int(body.rooms, 1, 20);
    if (adults === null) errors.adults = 'Number of adults should be between 1 and 40.';
    if (children === null) errors.children = 'Number of children should be between 0 and 20.';
    if (rooms === null) errors.rooms = 'Number of rooms should be between 1 and 20.';
    const roomType = ROOM_TYPES.includes(body.roomType) ? body.roomType : 'Not sure yet';
    Object.assign(out, { check_in: checkIn, check_out: checkOut, adults, children, rooms, room_type: roomType });
  } else {
    if (!message || message.length < 5) errors.message = 'Please write a short message.';
    Object.assign(out, { check_in: null, check_out: null, adults: null, children: null, rooms: null, room_type: null });
  }

  return { ok: Object.keys(errors).length === 0, errors, data: out };
}

export function nights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  return Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 864e5);
}
