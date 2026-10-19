import { describe, it, expect } from 'vitest';
import { computeReminders, localClock, pushPayload } from '../../src/reminders.js';

// 2026-10-25 10:00 in Tbilisi (UTC+4) == 06:00 UTC
const at = (hm, date = '2026-10-25') => Date.parse(`${date}T${hm}:00+04:00`);
const TZ = 'Asia/Tbilisi';
const t = (id, due, dueTime = '', status = ' ', text = `task ${id}`) => ({ id, text, status, due, dueTime, project: 'Work' });

function run(tasks, nowMs, notified = new Set(), notifyAt = '10:00') {
  return computeReminders(tasks, { tz: TZ, notifyAt, nowMs, notified });
}

describe('localClock', () => {
  it('reads the wall clock in the given zone', () => {
    expect(localClock(TZ, at('23:59'))).toMatchObject({ date: '2026-10-25', minutes: 23 * 60 + 59 });
    expect(localClock('UTC', at('01:00'))).toMatchObject({ date: '2026-10-24', minutes: 21 * 60 });
    expect(localClock('Not/AZone', at('01:00')).date).toBe('2026-10-24');   // falls back to UTC
  });
});

describe('computeReminders', () => {
  const timed = t('aaaaaaaa', '2026-10-25', '14:00');

  it('warns 15 minutes before a timed deadline', () => {
    expect(run([timed], at('13:44'))).toEqual([]);
    const r = run([timed], at('13:47'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: 'In 13 min', body: 'task aaaaaaaa', keys: ['2026-10-25|soon|aaaaaaaa|14:00'] });
  });

  it('fires at the time, and late (up to 12 h) as "overdue since"', () => {
    expect(run([timed], at('14:02'))[0]).toMatchObject({ title: 'Due now' });
    expect(run([timed], at('16:00'))[0]).toMatchObject({ title: 'Overdue since 14:00' });
    expect(run([timed], at('16:00'))[0].keys).toContain('2026-10-25|soon|aaaaaaaa|14:00');
  });

  it('dedupes via notified keys', () => {
    const notified = new Set(['2026-10-25|soon|aaaaaaaa|14:00']);
    expect(run([timed], at('13:50'), notified)).toEqual([]);
    notified.add('2026-10-25|now|aaaaaaaa|14:00');
    expect(run([timed], at('14:05'), notified)).toEqual([]);
  });

  it('sends one digest at notifyAt for due-today and overdue tasks', () => {
    const tasks = [t('bbbbbbbb', '2026-10-25'), t('cccccccc', '2026-10-20'), t('dddddddd', '2026-10-24', '9:00'),
      t('eeeeeeee', '2026-10-25', '', 'x'), t('ffffffff', '2026-10-26')];
    expect(run(tasks, at('09:59'))).toEqual([]);
    const r = run(tasks, at('10:00'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: '1 due today, 2 overdue', keys: ['2026-10-25|digest'], tag: 'digest' });
    expect(r[0].body.split('\n')).toHaveLength(3);
    expect(run(tasks, at('15:00'), new Set(['2026-10-25|digest']))).toEqual([]);
  });

  it('single-task digests and "+N more"', () => {
    expect(run([t('bbbbbbbb', '2026-10-25')], at('10:30'))[0].title).toBe('Due today');
    expect(run([t('bbbbbbbb', '2026-10-01')], at('10:30'))[0].title).toBe('Overdue');
    const many = Array.from({ length: 5 }, (_, i) => t(`a000000${i}`, '2026-10-25'));
    expect(run(many, at('10:30'))[0].body.split('\n').pop()).toBe('+2 more');
  });

  it('ignores closed and postponed tasks', () => {
    for (const s of ['x', '-', '~', '>']) expect(run([t('aaaaaaaa', '2026-10-25', '14:00', s)], at('14:01'))).toEqual([]);
    for (const s of ['/', '!']) expect(run([t('aaaaaaaa', '2026-10-25', '14:00', s)], at('14:01'))).toHaveLength(1);
  });

  it('handles a deadline just after midnight from the previous evening', () => {
    const r = run([t('aaaaaaaa', '2026-10-26', '0:05')], at('23:55'));
    expect(r[0].title).toBe('In 10 min');
  });
});

describe('edge cases: late summaries, payload size', () => {
  it('a digest set after the last cron run of the day still fires that day (the Worker passes lastRun)', () => {
    const r = computeReminders([t('bbbbbbbb', '2026-10-25')], { tz: TZ, notifyAt: '23:58', nowMs: at('23:55'), notified: new Set(), lastRun: 23 * 60 + 55 });
    expect(r).toHaveLength(1);
    // callers that run every minute (the desktop apps) keep the exact time
    expect(computeReminders([t('bbbbbbbb', '2026-10-25')], { tz: TZ, notifyAt: '23:58', nowMs: at('23:55'), notified: new Set() })).toHaveLength(0);
  });
  it('payloads stay far below the Web Push size limit', () => {
    const huge = 'საქმე '.repeat(2000);
    const body = pushPayload({ title: huge, body: huge, tag: 'x', sub: huge });
    expect(new TextEncoder().encode(body).length).toBeLessThan(3000);
  });
});
