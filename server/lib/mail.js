// Guest and admin emails for the four moments of a stay:
//   1. booking request received (website lead)       -> guest + admin
//   2. booking confirmed by the hotel                 -> guest + admin
//   3. the day before check-out                       -> guest + admin
//   4. after check-out, asking for a review           -> guest + admin copy
// Every attempt is written to email_log. Without SMTP settings, emails are logged as
// "skipped" and everything else keeps working.
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { one, run, getSettings } from './db.js';
import { niceDate, daysBetween } from './dates.js';
import { MEAL_PLANS } from './inventory.js';
import { site } from './site.js';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO, PUBLIC_URL, MAIL_PREVIEW_DIR } = process.env;
// MAIL_PREVIEW_DIR (development): write each email as an .html file instead of sending it.
export const mailEnabled = Boolean(MAIL_PREVIEW_DIR || (SMTP_HOST && SMTP_USER && SMTP_PASS));
let previewN = 0;
const transport = MAIL_PREVIEW_DIR
  ? { sendMail: async (m) => { mkdirSync(MAIL_PREVIEW_DIR, { recursive: true }); writeFileSync(`${MAIL_PREVIEW_DIR}/${String(++previewN).padStart(2, '0')}-${m.subject.replace(/[^\w]+/g, '-').slice(0, 60)}.html`, `<!-- To: ${m.to} | ${m.subject} -->\n${m.html}`); } }
  : mailEnabled
    ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 465), secure: Number(SMTP_PORT || 465) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
    : null;
const FROM = MAIL_FROM || `The Pinus Resort <${SMTP_USER || site.email}>`;
const BASE = (PUBLIC_URL || site.url).replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (minor) => (minor == null ? '' : `INR ${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const time12 = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

export function adminRecipients() {
  return (getSettings().notify_email || MAIL_TO || site.email).split(',').map((s) => s.trim()).filter(Boolean);
}

/* ---------- Layout ---------- */
function layout({ preheader, eyebrow, title, intro, rows = [], button, after = '' }) {
  const table = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:24px 0">${rows
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e4dccb;font:12px/1.4 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#5e655f;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid #e4dccb;font:16px/1.5 Georgia,serif;color:#1e2421">${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
        .join('')}</table>`
    : '';
  const btn = button
    ? `<p style="margin:28px 0 8px"><a href="${esc(button.href)}" style="display:inline-block;background:#5d6b45;color:#ffffff;text-decoration:none;font:600 12px/1 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;padding:16px 28px">${esc(button.label)}</a></p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>The Pinus Resort</title></head><body style="margin:0;background:#efe7d6">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader || '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe7d6"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf9">
<tr><td align="center" style="padding:28px 24px 8px"><img src="${BASE}/logo.png" width="96" height="96" alt="The Pinus Resort" style="display:block;width:96px;height:96px"></td></tr>
<tr><td style="padding:8px 36px 36px">
<p style="margin:0 0 8px;font:600 11px/1.4 Arial,sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#a5713a;text-align:center">${esc(eyebrow)}</p>
<h1 style="margin:0 0 20px;font:500 30px/1.15 Georgia,serif;color:#1e2421;text-align:center">${esc(title)}</h1>
<div style="font:16px/1.65 Georgia,serif;color:#3a403c">${intro}</div>
${table}${btn}${after}
</td></tr>
<tr><td style="background:#1b2723;padding:24px 36px;font:13px/1.7 Arial,sans-serif;color:#b5b7a8">
<b style="color:#efe7d6;font-weight:600">The Pinus Resort</b><br>
Nunwan, Pahalgam, opp. Yatra frisking point, ${esc(site.postalCode)}<br>
<a href="tel:${esc(site.phoneHref)}" style="color:#efe7d6">${esc(site.phone)}</a> &middot; <a href="https://wa.me/${esc(site.whatsapp)}" style="color:#efe7d6">WhatsApp</a> &middot; <a href="${esc(site.mapsUrl)}" style="color:#efe7d6">Map</a>
</td></tr></table></td></tr></table></body></html>`;
}
const textOf = (title, rows, extra = '') => [title, '', ...rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`), extra, '', `The Pinus Resort, Nunwan, Pahalgam | ${site.phone}`].join('\n');

/* ---------- Send + log ---------- */
async function send({ kind, to, subject, html, text, reservationId = null, enquiryId = null, replyTo }) {
  const recipients = Array.isArray(to) ? to : [to];
  let status = 'sent';
  let error = null;
  if (!mailEnabled) {
    status = 'skipped';
    error = 'SMTP not configured';
  } else {
    try {
      await transport.sendMail({ from: FROM, to: recipients.join(', '), subject, html, text, replyTo });
    } catch (e) {
      status = 'failed';
      error = String(e.message || e).slice(0, 500);
      console.error(`[mail] ${kind} to ${recipients.join(', ')} failed: ${error}`);
    }
  }
  run('INSERT INTO email_log (kind, reservation_id, enquiry_id, recipient, subject, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
    kind, reservationId, enquiryId, recipients.join(', '), subject, status, error);
  return status;
}

/* ---------- Booking details shared by all reservation emails ---------- */
function stayRows(r, { money = true } = {}) {
  const n = daysBetween(r.check_in, r.check_out);
  const s = getSettings();
  return [
    ['Booking reference', r.reference],
    ['Guest', r.guest_name],
    ['Check in', `${niceDate(r.check_in)}${s.checkin_time ? `, from ${time12(s.checkin_time)}` : ''}`],
    ['Check out', `${niceDate(r.check_out)}${s.checkout_time ? `, by ${time12(s.checkout_time)}` : ''}`],
    ['Nights', String(n)],
    ['Room', `${r.rooms} x ${r.room_name}${r.meal_plan ? ` (${MEAL_PLANS[r.meal_plan] || r.meal_plan})` : ''}`],
    ['Guests', `${r.adults} adult${r.adults > 1 ? 's' : ''}${r.children ? `, ${r.children} child${r.children > 1 ? 'ren' : ''}` : ''}`],
    ...(money ? [['Total', inr(r.amount_minor)], ['Advance received', inr(r.advance_minor)], ['Balance', r.amount_minor != null && r.advance_minor != null ? inr(r.amount_minor - r.advance_minor) : '']] : []),
  ];
}
function loadRes(id) {
  return one(`SELECT r.*, rt.name AS room_name, rp.meal_plan FROM reservations r JOIN room_types rt ON rt.id = r.room_type_id LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id WHERE r.id = ?`, id);
}
const firstName = (n) => String(n).split(' ')[0];

/* ---------- 1. Booking request received (website lead) ---------- */
export async function sendLeadEmails(e) {
  const isBooking = e.kind !== 'contact';
  const rows = [
    ['Request reference', e.ref],
    ['Name', e.name],
    ['Phone', e.phone],
    ['Email', e.email],
    ...(isBooking
      ? [
          ['Check in', niceDate(e.check_in)],
          ['Check out', `${niceDate(e.check_out)} (${daysBetween(e.check_in, e.check_out)} nights)`],
          ['Guests', `${e.adults} adult${e.adults > 1 ? 's' : ''}${e.children ? `, ${e.children} child${e.children > 1 ? 'ren' : ''}` : ''}`],
          ['Rooms', `${e.rooms} x ${e.room_type}`],
        ]
      : []),
    ['Message', e.message],
  ];
  const jobs = [
    send({
      kind: 'lead_admin',
      to: adminRecipients(),
      replyTo: e.email || undefined,
      enquiryId: e.id,
      subject: `New ${isBooking ? 'booking request' : 'message'} ${e.ref}: ${e.name}${isBooking ? `, ${niceDate(e.check_in, { weekday: undefined })}` : ''}`,
      html: layout({
        preheader: `${e.name} sent a ${isBooking ? 'booking request' : 'message'} from the website`,
        eyebrow: isBooking ? 'New booking request' : 'New message',
        title: e.name,
        intro: `<p>A new ${isBooking ? 'booking request' : 'message'} came in from the website. Call or WhatsApp the guest, then confirm the booking in the admin panel so their confirmation email goes out.</p>`,
        rows,
        button: { href: `${BASE}/admin/`, label: 'Open admin panel' },
        after: `<p style="font:14px Arial,sans-serif"><a href="https://wa.me/${esc(e.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'))}" style="color:#5d6b45">Reply on WhatsApp</a></p>`,
      }),
      text: textOf(`New ${isBooking ? 'booking request' : 'message'} from the website`, rows, `Admin: ${BASE}/admin/`),
    }),
  ];
  if (e.email) {
    const title = isBooking ? `Thank you, ${firstName(e.name)}` : `We have your message`;
    jobs.push(send({
      kind: 'lead_guest',
      to: e.email,
      replyTo: adminRecipients()[0],
      enquiryId: e.id,
      subject: isBooking ? `We have your booking request (${e.ref}) | The Pinus Resort` : `We have your message (${e.ref}) | The Pinus Resort`,
      html: layout({
        preheader: isBooking ? 'We are checking availability for your dates' : 'We will get back to you shortly',
        eyebrow: isBooking ? 'Booking request received' : 'Message received',
        title,
        intro: isBooking
          ? `<p>Dear ${esc(firstName(e.name))},</p><p>Thank you for choosing The Pinus Resort. We have received your booking request and are checking availability for your dates. We will call or WhatsApp you on <b>${esc(e.phone)}</b> shortly. Once the booking is confirmed, you will receive a confirmation email from us.</p>`
          : `<p>Dear ${esc(firstName(e.name))},</p><p>Thank you for writing to The Pinus Resort. We will reply on <b>${esc(e.phone)}</b> or by email shortly.</p>`,
        rows,
        button: { href: `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(`Hello, my request reference is ${e.ref}.`)}`, label: 'Chat on WhatsApp' },
      }),
      text: textOf(title, rows, 'This is a request, not yet a confirmed booking.'),
    }));
  }
  await Promise.all(jobs);
}

/* ---------- 2. Booking confirmed ---------- */
export async function sendConfirmation(reservationId) {
  const r = loadRes(reservationId);
  if (!r) return;
  const rows = stayRows(r);
  const jobs = [
    send({
      kind: 'confirm_admin', to: adminRecipients(), reservationId,
      subject: `Booking confirmed ${r.reference}: ${r.guest_name}, ${niceDate(r.check_in, { weekday: undefined })}`,
      html: layout({ preheader: `${r.rooms} x ${r.room_name} for ${r.guest_name}`, eyebrow: 'Booking confirmed', title: r.guest_name, intro: `<p>This booking is confirmed and the rooms are blocked in inventory.${r.guest_email ? ' The guest has been sent a confirmation email.' : ' <b>The guest has no email address on file</b>, so please share the confirmation by WhatsApp.'}</p>`, rows: [...rows, ['Phone', r.guest_phone], ['Email', r.guest_email], ['Notes', r.notes]], button: { href: `${BASE}/admin/`, label: 'Open admin panel' } }),
      text: textOf(`Booking confirmed: ${r.reference}`, rows),
    }),
  ];
  if (r.guest_email) {
    jobs.push(send({
      kind: 'confirm_guest', to: r.guest_email, replyTo: adminRecipients()[0], reservationId,
      subject: `Your booking is confirmed (${r.reference}) | The Pinus Resort`,
      html: layout({
        preheader: `See you on ${niceDate(r.check_in)}`,
        eyebrow: 'Booking confirmed',
        title: `See you soon, ${firstName(r.guest_name)}`,
        intro: `<p>Dear ${esc(firstName(r.guest_name))},</p><p>Your stay at The Pinus Resort is confirmed. Your cottage in the pines will be ready for you. Please keep this email and quote your booking reference if you call us.</p>`,
        rows,
        button: { href: site.mapsUrl, label: 'Directions to the resort' },
        after: `<p style="font:15px/1.6 Georgia,serif;color:#3a403c">We are on the main road into Pahalgam, opposite the Yatra frisking point at Nunwan. Share your arrival time on WhatsApp and we will guide your driver to the gate.</p>`,
      }),
      text: textOf(`Your booking is confirmed: ${r.reference}`, rows, `Directions: ${site.mapsUrl}`),
    }));
  }
  await Promise.all(jobs);
}

/* ---------- 3. Day before check-out ---------- */
export async function sendPreCheckout(reservationId) {
  const r = loadRes(reservationId);
  if (!r) return [];
  const s = getSettings();
  const rows = stayRows(r);
  const jobs = [
    send({
      kind: 'precheckout_admin', to: adminRecipients(), reservationId,
      subject: `Check-out tomorrow: ${r.guest_name} (${r.reference})`,
      html: layout({ preheader: 'Prepare the bill and room inspection', eyebrow: 'Check-out tomorrow', title: r.guest_name, intro: `<p>${esc(r.guest_name)} checks out tomorrow, ${esc(niceDate(r.check_out))}. Please have the final bill ready${r.amount_minor != null && r.advance_minor != null ? ` (balance ${esc(inr(r.amount_minor - r.advance_minor))})` : ''}.</p>`, rows: [...rows, ['Phone', r.guest_phone]] }),
      text: textOf(`Check-out tomorrow: ${r.guest_name}`, rows),
    }),
  ];
  if (r.guest_email) {
    jobs.push(send({
      kind: 'precheckout_guest', to: r.guest_email, replyTo: adminRecipients()[0], reservationId,
      subject: `Your check-out tomorrow | The Pinus Resort`,
      html: layout({
        preheader: `Check-out on ${niceDate(r.check_out)}`,
        eyebrow: 'A gentle reminder',
        title: 'Your check-out is tomorrow',
        intro: `<p>Dear ${esc(firstName(r.guest_name))},</p><p>We hope you are enjoying the pines. Your check-out is tomorrow, <b>${esc(niceDate(r.check_out))}</b>${s.checkout_time ? `, by <b>${esc(time12(s.checkout_time))}</b>` : ''}. If you need a taxi, help with your onward plans, or would like to stay another night, just tell us at the desk or on WhatsApp and we will check what we can do.</p>`,
        rows: rows.filter(([k]) => ['Booking reference', 'Check out', 'Room', 'Balance'].includes(k)),
        button: { href: `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(`Hello, this is ${r.guest_name} (${r.reference}).`)}`, label: 'Message the desk' },
      }),
      text: textOf('Your check-out is tomorrow', rows),
    }));
  }
  return Promise.all(jobs);
}

/* ---------- 4. After check-out: review request ---------- */
export async function sendReviewRequest(reservationId) {
  const r = loadRes(reservationId);
  if (!r) return [];
  const link = `${BASE}/review/?t=${encodeURIComponent(r.review_token)}`;
  const jobs = [];
  if (r.guest_email) {
    jobs.push(send({
      kind: 'review_guest', to: r.guest_email, replyTo: adminRecipients()[0], reservationId,
      subject: `How was your stay, ${firstName(r.guest_name)}? | The Pinus Resort`,
      html: layout({
        preheader: 'One minute, five stars, a few words',
        eyebrow: 'Thank you for staying with us',
        title: 'How was your stay?',
        intro: `<p>Dear ${esc(firstName(r.guest_name))},</p><p>Thank you for staying at The Pinus Resort. We hope the pines, the river and the quiet evenings stay with you for a while. Would you take a minute to tell us how it went? Every review helps us look after the next guest better.</p>`,
        button: { href: link, label: 'Rate your stay' },
        after: `<p style="font:13px/1.6 Arial,sans-serif;color:#5e655f">Booking ${esc(r.reference)}, ${esc(niceDate(r.check_in))} to ${esc(niceDate(r.check_out))}.</p>`,
      }),
      text: `Dear ${firstName(r.guest_name)},\n\nThank you for staying at The Pinus Resort. Would you take a minute to tell us how it went?\n\n${link}\n\nThe Pinus Resort, Nunwan, Pahalgam`,
    }));
  }
  jobs.push(send({
    kind: 'review_admin', to: adminRecipients(), reservationId,
    subject: `Review request ${r.guest_email ? 'sent to' : 'could not be emailed to'} ${r.guest_name} (${r.reference})`,
    html: layout({
      eyebrow: 'After check-out', title: r.guest_name,
      intro: r.guest_email
        ? `<p>A review request has been emailed to ${esc(r.guest_name)} (${esc(r.guest_email)}). Their rating will appear under Reviews in the admin panel.</p>`
        : `<p>${esc(r.guest_name)} has no email address on file. Send them the review link on WhatsApp:</p><p style="word-break:break-all"><a href="${esc(link)}">${esc(link)}</a></p>`,
      rows: [['Booking reference', r.reference], ['Stay', `${niceDate(r.check_in)} to ${niceDate(r.check_out)}`], ['Phone', r.guest_phone]],
    }),
    text: `Review request for ${r.guest_name} (${r.reference}): ${link}`,
  }));
  return Promise.all(jobs);
}
