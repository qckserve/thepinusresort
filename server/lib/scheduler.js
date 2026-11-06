// Background jobs, run inside the web server every 10 minutes:
//   - open new nights in the selling window (once a day)
//   - "check-out tomorrow" emails (from 10 am India time on the day before check-out)
//   - review requests after check-out
// Emails only go out between 9 am and 9 pm India time. Each email is claimed with an
// UPDATE ... WHERE sent_at IS NULL before sending, so two server processes never double-send.
import { one, all, run, getSettings, setSetting } from './db.js';
import { addDays, hourNow, today, nowIso } from './dates.js';
import { rollHorizon } from './inventory.js';
import { sendPreCheckout, sendReviewRequest } from './mail.js';

const EVERY_MS = 10 * 60 * 1000;
const MAX_TRIES = 3;
let running = false;

function failedTries(reservationId, kindPrefix) {
  return Number(one("SELECT COUNT(*) AS n FROM email_log WHERE reservation_id = ? AND kind LIKE ? AND status = 'failed'", reservationId, `${kindPrefix}%`).n);
}

async function claimAndSend(rows, column, kindPrefix, sender) {
  let sent = 0;
  for (const { id } of rows) {
    if (failedTries(id, kindPrefix) >= MAX_TRIES) continue;
    const claim = run(`UPDATE reservations SET ${column} = ? WHERE id = ? AND ${column} IS NULL`, nowIso(), id);
    if (Number(claim.changes) !== 1) continue; // another process took it
    const results = await sender(id);
    // If nothing reached anyone because of an error, release the claim so the next run retries.
    if (results.length && results.every((s) => s === 'failed')) run(`UPDATE reservations SET ${column} = NULL WHERE id = ?`, id);
    else sent += 1;
  }
  return sent;
}

export async function runJobs({ force = false } = {}) {
  if (running) return null;
  running = true;
  try {
    const t = today();
    const out = { opened: 0, preCheckout: 0, reviews: 0 };
    if (getSettings().last_roll !== t) {
      out.opened = rollHorizon();
      setSetting('last_roll', t);
    }
    const hour = hourNow();
    if (!force && (hour < 9 || hour >= 21)) return out;

    if (force || hour >= 10) {
      const due = all(`SELECT id FROM reservations WHERE check_out = ? AND status IN ('CONFIRMED','CHECKED_IN') AND precheckout_sent_at IS NULL`, addDays(t, 1));
      out.preCheckout = await claimAndSend(due, 'precheckout_sent_at', 'precheckout', sendPreCheckout);
    }

    // Checked out (marked by the desk), or the check-out date has passed and nobody marked it.
    // Stays older than a week are left alone.
    const reviewDue = all(`SELECT id FROM reservations
       WHERE review_sent_at IS NULL AND check_out >= ?
         AND (status = 'CHECKED_OUT' OR (status IN ('CONFIRMED','CHECKED_IN') AND check_out < ?))`, addDays(t, -7), t);
    out.reviews = await claimAndSend(reviewDue, 'review_sent_at', 'review', sendReviewRequest);
    if (out.opened || out.preCheckout || out.reviews) console.log('[jobs]', JSON.stringify(out));
    return out;
  } catch (e) {
    console.error('[jobs] failed:', e);
    return null;
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setTimeout(() => runJobs(), 5_000).unref();
  setInterval(() => runJobs(), EVERY_MS).unref();
}
