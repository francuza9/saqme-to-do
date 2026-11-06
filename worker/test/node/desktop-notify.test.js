// Linux: a click on a reminder reaches the app (local/desktop.mjs notify with onClick), tried with a stand-in notify-send.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { notify } from '../../../local/desktop.mjs';

const PATH = process.env.PATH;
let dir;
afterEach(() => { process.env.PATH = PATH; if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A notify-send that logs its arguments; with `script` as its behaviour. */
function fakeNotifySend(script) {
  dir = mkdtempSync(join(tmpdir(), 'saqme-notify-'));
  const bin = join(dir, 'notify-send');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'calls')}"\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${PATH}`;
  return () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);
}
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe.skipIf(platform() !== 'linux')('desktop notifications: a click opens the task', () => {
  it('asks for a click action and calls onClick when the notification was clicked', async () => {
    const calls = fakeNotifySend('echo default');
    let clicked = 0;
    expect(notify({ title: 'In 15 min', body: 'Call the bank' },{ onClick: () => { clicked++; } })).toBe(true);
    await until(() => clicked);
    expect(clicked).toBe(1);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatch(/^--action=default=Open Saqme --wait /);
    expect(calls()[0]).toContain('In 15 min');
  });
  it('does nothing more when it is dismissed or just expires', async () => {
    const calls = fakeNotifySend('exit 0');
    let clicked = 0;
    notify({ title: 'Due now', body: 'x' }, { onClick: () => { clicked++; } });
    await until(() => calls().length);
    await new Promise((r) => setTimeout(r, 200));
    expect(clicked).toBe(0);
    expect(calls()).toHaveLength(1);
  });
  it('a notify-send without actions (it fails at once) shows it the plain way', async () => {
    const calls = fakeNotifySend('case "$*" in *--action*) echo "unknown option" >&2; exit 1;; esac');
    let clicked = 0;
    notify({ title: 'Due now', body: 'x' }, { onClick: () => { clicked++; } });
    await until(() => calls().length >= 2);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).not.toContain('--action');
    expect(clicked).toBe(0);
  });
  it('without onClick it is the same plain call as before', () => {
    const calls = fakeNotifySend('exit 0');
    expect(notify({ title: 'Due now', body: 'x' })).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).not.toContain('--action');
  });
});
