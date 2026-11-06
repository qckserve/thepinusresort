// Scheduled work:
//   - open new nights in the selling window (once a day)
//   - "check-out tomorrow" emails (from 10 am India time on the day before check-out)
//   - review requests after check-out
// On Vercel this runs from Vercel Cron (GET /api/cron, see vercel.json); on a normal Node host
// it also runs every 10 minutes inside the server. Emails only go out between 9 am and 9 pm
// India time. Each email is claimed with findOneAndUpdate(sent_at: null) before sending, so
// two instances never double-send.
import { col, nowIso, ready, getSettings, setSettings } from './db.js';
import { addDays, hourNow, today } from './dates.js';
import { rollHorizon } from './inventory.js';
import { sendPreCheckout, sendReviewRequest } from './mail.js';

const EVERY_MS = 10 * 60 * 1000;
const MAX_TRIES = 3;
let running = false;

async function claimAndSend(ids, field, kindPrefix, sender) {
  let sent = 0;
  for (const id of ids) {
    const fails = await col('email_log').countDocuments({ reservation_id: id, kind: { $regex: `^${kindPrefix}` }, status: 'failed' });
    if (fails >= MAX_TRIES) continue;
    const claim = await col('reservations').findOneAndUpdate({ _id: id, [field]: null }, { $set: { [field]: nowIso() } });
    if (!claim) continue; // another instance took it
    const results = await sender(id);
    // If nothing reached anyone because of an error, release the claim so the next run retries.
    if (results.length && results.every((s) => s === 'failed')) await col('reservations').updateOne({ _id: id }, { $set: { [field]: null } });
    else sent += 1;
  }
  return sent;
}

export async function runJobs({ force = false } = {}) {
  if (running) return null;
  running = true;
  try {
    await ready();
    const t = today();
    const out = { opened: 0, preCheckout: 0, reviews: 0 };
    if ((await getSettings()).last_roll !== t) {
      out.opened = await rollHorizon();
      await setSettings({ last_roll: t });
    }
    const hour = hourNow();
    if (!force && (hour < 9 || hour >= 21)) return out;

    const ids = async (filter) => (await col('reservations').find(filter, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
    if (force || hour >= 10) {
      out.preCheckout = await claimAndSend(
        await ids({ check_out: addDays(t, 1), status: { $in: ['CONFIRMED', 'CHECKED_IN'] }, precheckout_sent_at: null }),
        'precheckout_sent_at', 'precheckout', sendPreCheckout,
      );
    }
    // Checked out (marked by the desk), or the check-out date passed and nobody marked it.
    // Stays older than a week are left alone.
    out.reviews = await claimAndSend(
      await ids({
        review_sent_at: null,
        check_out: { $gte: addDays(t, -7) },
        $or: [{ status: 'CHECKED_OUT' }, { status: { $in: ['CONFIRMED', 'CHECKED_IN'] }, check_out: { $lt: t } }],
      }),
      'review_sent_at', 'review', sendReviewRequest,
    );
    if (out.opened || out.preCheckout || out.reviews) console.log('[jobs]', JSON.stringify(out));
    return out;
  } catch (e) {
    console.error('[jobs] failed:', e);
    return null;
  } finally {
    running = false;
  }
}

/** Long-running servers only (not Vercel): run every 10 minutes. */
export function startScheduler() {
  setTimeout(() => runJobs(), 5_000).unref();
  setInterval(() => runJobs(), EVERY_MS).unref();
}
