// Reminder rules shared with the desktop widget (Get-Reminders in desktop/rules.ps1; both are checked against
// shared/fixtures/reminders.json):
//   timed deadline        -> "In N min" 15 minutes before, then "Due now" / "Overdue since H:MM" at the time
//                            (still sent up to 12 h late if nothing ran in between)
//   date-only due today   -> one daily digest at notifyAt
//   anything overdue      -> (date before today, timed or not) same daily digest
// Only open tasks count (to do, in progress, blocked). Times are wall-clock in the user's time zone.

import { sendPush } from './push.js';

const ACTIVE = new Set([' ', '/', '!']);
const DAY = 1440;

function dayNumber(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/** 'H:MM' -> minutes after midnight, or null when it is not a valid time of day. */
function minutesOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}

/** Wall clock in `tz`: { date: 'YYYY-MM-DD', minutes, abs } where abs = local minutes since epoch. */
export function localClock(tz, nowMs) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
  } catch {
    return localClock('UTC', nowMs);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = (+get('hour') % 24) * 60 + +get('minute');
  return { date, minutes, abs: dayNumber(date) * DAY + minutes };
}

/**
 * tasks: [{ id, text, status, due: 'YYYY-MM-DD', dueTime: 'H:MM' | '', project }]
 * Returns [{ keys: [...dedupe keys to record], title, body, tag, sub }] for keys not yet in `notified`.
 * lastRun: minute of the day of the caller's last run, when it does not run every minute (the Worker's cron
 * runs every 5 minutes, last at 23:55): a daily summary time after it is moved to it.
 */
export function computeReminders(tasks, { tz, notifyAt, nowMs, notified, lastRun = 1439 }) {
  const now = localClock(tz, nowMs);
  const out = [];
  const digest = [];
  for (const t of tasks) {
    if (!ACTIVE.has(t.status) || !t.due) continue;
    if (t.due < now.date) { digest.push({ ...t, over: true }); continue; }
    const tm = minutesOf(t.dueTime);
    if (tm === null) { if (t.due === now.date) digest.push({ ...t, over: false }); continue; }
    const at = dayNumber(t.due) * DAY + tm;
    const kSoon = `${t.due}|soon|${t.id}|${t.dueTime}`;
    const kNow = `${t.due}|now|${t.id}|${t.dueTime}`;
    if (now.abs >= at - 15 && now.abs < at && !notified.has(kSoon)) {
      out.push({ keys: [kSoon], title: `In ${at - now.abs} min`, body: t.text, tag: `due-${t.id}`, sub: `${t.project} · ${t.dueTime}` });
    } else if (now.abs >= at && now.abs < at + 12 * 60 && !notified.has(kNow)) {
      const title = now.abs - at < 5 ? 'Due now' : `Overdue since ${t.dueTime}`;
      out.push({ keys: [kNow, kSoon], title, body: t.text, tag: `due-${t.id}`, sub: t.project });
    }
  }
  const kDig = `${now.date}|digest`;
  const at = Math.min(minutesOf(notifyAt) ?? 600, lastRun);
  if (digest.length && now.minutes >= at && !notified.has(kDig)) {
    const over = digest.filter((d) => d.over).length;
    const due = digest.length - over;
    let title;
    if (digest.length === 1) title = over ? 'Overdue' : 'Due today';
    else title = [due && `${due} due today`, over && `${over} overdue`].filter(Boolean).join(', ');
    const lines = digest.slice(0, 3).map((d) => d.text);
    if (digest.length > 3) lines.push(`+${digest.length - 3} more`);
    out.push({ keys: [kDig], title, body: lines.join('\n'), tag: 'digest', sub: digest.length === 1 ? digest[0].project : 'Saqme To Do' });
  }
  return out;
}

async function loadVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const origin = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'origin'`).first('value');
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || origin || 'mailto:saqme@users.noreply.github.com',
  };
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Keeps a payload far below the 3993-byte Web Push limit, whatever the task texts are. */
export function pushPayload({ title, body, tag, sub, url = '/' }) {
  return JSON.stringify({ title: clip(title, 120), body: clip(body, 600), tag, sub: clip(sub, 120), url });
}

/**
 * Sends one payload to the given subscriptions (loaded once per run by the caller). Returns per-run stats
 * and the D1 statements to record the outcome, so a cron run stays within the per-invocation query limit.
 */
async function sendToAll(vapid, subs, payload) {
  let sent = 0;
  let failed = 0;
  const now = Date.now();
  const updates = [];
  const body = pushPayload(payload);
  for (const s of subs) {
    let res;
    try {
      res = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, vapid,
        { topic: payload.tag, ttl: 6 * 3600 });
    } catch (e) {
      res = { ok: false, status: 0, gone: false, text: String(e?.message ?? e) };
    }
    if (res.ok) { sent++; updates.push(['ok', s.endpoint, now]); }
    else {
      failed++;
      updates.push([res.gone ? 'gone' : 'fail', s.endpoint, now]);
      console.log(`push failed: ${res.status} ${res.text?.slice(0, 200) ?? ''}`);
    }
  }
  return { sent, failed, updates };
}

function outcomeStatements(db, updates) {
  return updates.map(([kind, endpoint, now]) => {
    if (kind === 'ok') return db.prepare('UPDATE push_subscriptions SET last_ok = ?1, failures = 0 WHERE endpoint = ?2').bind(now, endpoint);
    if (kind === 'gone') return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint);
    // a subscription that has failed for ~2 days of runs in a row is dead: drop it
    return db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?1').bind(endpoint);
  });
}

async function loadSubs(env, only) {
  const q = 'SELECT endpoint, p256dh, auth FROM push_subscriptions';
  return only
    ? (await env.DB.prepare(`${q} WHERE endpoint = ?1`).bind(only).all()).results
    : (await env.DB.prepare(q).all()).results;
}

/** One-off push (the "Send test" button). */
export async function pushToAll(env, payload, { only } = {}) {
  const vapid = await loadVapid(env);
  if (!vapid) return { sent: 0, failed: 0, error: 'VAPID keys are not configured' };
  const subs = await loadSubs(env, only);
  const r = await sendToAll(vapid, subs, payload);
  const stmts = outcomeStatements(env.DB, r.updates);
  if (stmts.length) await env.DB.batch(stmts);
  return { sent: r.sent, failed: r.failed, subscriptions: subs.length };
}

/** Cron entry point. Cheap when nobody subscribed. */
export async function runReminders(env, nowMs = Date.now()) {
  const db = env.DB;
  const subsCount = await db.prepare('SELECT count(*) AS n FROM push_subscriptions').first('n');
  if (!subsCount) return { reminders: 0 };
  const vapid = await loadVapid(env);
  if (!vapid) return { reminders: 0 };
  const [settingsRes, notifiedRes, subsRes] = await db.batch([
    db.prepare('SELECT key, value FROM settings'),
    db.prepare('SELECT key FROM notified WHERE at > ?1').bind(nowMs - 8 * 86_400_000),
    db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions'),
  ]);
  const settings = Object.fromEntries(settingsRes.results.map((r) => [r.key, r.value]));
  const tz = settings.tz || 'UTC';
  const today = localClock(tz, nowMs);
  const horizon = new Date((dayNumber(today.date) + 1) * 86_400_000).toISOString().slice(0, 10);
  const { results } = await db.prepare(
    `SELECT t.id, t.text, t.status, t.due, t.due_time, p.name AS project
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.due IS NOT NULL AND t.deleted = 0 AND p.deleted = 0 AND t.status IN (' ', '/', '!') AND t.due <= ?1`,
  ).bind(horizon).all();
  const tasks = results.map((r) => ({ id: r.id, text: r.text, status: r.status, due: r.due, dueTime: r.due_time, project: r.project }));
  const notified = new Set(notifiedRes.results.map((r) => r.key));
  const due = computeReminders(tasks, { tz, notifyAt: settings.notifyAt || '10:00', nowMs, notified, lastRun: 23 * 60 + 55 });   // the */5 cron's last run
  let count = 0;
  const after = [];
  // a handful per run keeps the cron inside the free plan's per-invocation limits; the rest go 5 minutes later
  for (const r of due.slice(0, 8)) {
    // claim the keys first, so overlapping runs can never notify twice
    const claimed = await db.prepare(
      `INSERT INTO notified (key, at) SELECT value, ?2 FROM json_each(?1) WHERE true ON CONFLICT(key) DO NOTHING RETURNING key`,
    ).bind(JSON.stringify(r.keys), nowMs).all();
    if (!claimed.results.some((x) => x.key === r.keys[0])) continue;
    const res = await sendToAll(vapid, subsRes.results, { title: r.title, body: r.body, tag: r.tag, sub: r.sub, url: '/' });
    after.push(...outcomeStatements(db, res.updates));
    if (!res.sent && res.failed) {
      // nothing got through: give the keys back so the next run tries again
      after.push(db.prepare('DELETE FROM notified WHERE key IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(claimed.results.map((x) => x.key))));
    } else count++;
  }
  after.push(db.prepare('DELETE FROM notified WHERE at < ?1').bind(nowMs - 8 * 86_400_000));
  after.push(db.prepare('DELETE FROM push_subscriptions WHERE failures >= 500'));
  await db.batch(after);
  return { reminders: count };
}
