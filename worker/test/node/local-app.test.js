// The Linux/macOS app as a whole (local/saqme.mjs startApp): its HTTP server, the window's pairing, and
// the lists folder kept in step with what the window does. Plus the phone app's markdown export / import.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../../../local/saqme.mjs';
import { aiPrompt } from '../../../local/ai-prompt.mjs';
import { Store } from '../../public/js/store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; }
  return fn();
}
function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

let app;
let dir;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-app-'));
  mkdirSync(join(dir, 'lists'));
  writeFileSync(join(dir, 'lists', 'Work.md'), '# Today\n- [ ] Write the report\n- [ ] Call Anna\n');
  app = await startApp({ dataDir: dir, port: 0, interval: 200, cloudInterval: 60_000, settleMs: 0, reminders: false });
});
afterAll(async () => { await app?.stop(); rmSync(dir, { recursive: true, force: true }); });

describe('local app server', () => {
  it('answers only for its own host names (no DNS rebinding)', async () => {
    expect(await rawGet(app.port, '/api/health', `127.0.0.1:${app.port}`)).toBe(200);
    expect(await rawGet(app.port, '/api/health', `localhost:${app.port}`)).toBe(200);
    expect(await rawGet(app.port, '/api/health', 'evil.example')).toBe(403);
    expect(await rawGet(app.port, '/', `attacker.test:${app.port}`)).toBe(403);
  });

  it('serves the phone app with its security headers, and nothing outside it', async () => {
    const res = await fetch(`${app.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(await res.text()).toMatch(/<title>Saqme To Do<\/title>/);
    expect((await fetch(`${app.url}/js/markdown.js`)).status).toBe(200);
    expect((await fetch(`${app.url}/_headers`)).status).toBe(404);
    expect(await rawGet(app.port, '/../../package.json', `127.0.0.1:${app.port}`)).toBe(404);
    expect(await rawGet(app.port, '/%2e%2e/%2e%2e/package.json', `127.0.0.1:${app.port}`)).toBe(404);
  });

  it('says it is the local app, needs the token for everything else, and never sends CORS headers', async () => {
    expect(await (await fetch(`${app.url}/api/health`)).json()).toMatchObject({ ok: true, local: true });
    expect((await fetch(`${app.url}/api/config`)).status).toBe(401);
    expect((await fetch(`${app.url}/api/local/code`, { method: 'POST' })).status).toBe(401);
    const res = await fetch(`${app.url}/api/config`, { headers: { authorization: `Bearer ${app.token}` } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect((await res.json()).local.lists).toBe(join(dir, 'lists'));
    expect((await fetch(`${app.url}/api/sync`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('Backups: one made at the start; bringing one back adds what is missing and nothing else', async () => {
    const auth = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${app.url}/api/local/backups`)).status).toBe(401);
    const list = async () => (await fetch(`${app.url}/api/local/backups`, { headers: auth })).json();
    const first = await until(async () => (await list()).backups[0]);
    expect(first).toMatchObject({ reason: 'start', lists: 1 });
    expect((await list()).dir).toBe(join(dir, 'backups'));
    const restore = async (body) => (await fetch(`${app.url}/api/local/backups/restore`, { method: 'POST', headers: auth, body: JSON.stringify(body) })).json();
    expect(await restore({ name: 'nope' })).toEqual({ error: 'There is no such backup.' });
    // the list gets ids from the engine after the backup was made: take a backup with ids, then lose a line
    const work = join(dir, 'lists', 'Work.md');
    await until(() => /\^[0-9a-z]{8}/.test(readFileSync(work, 'utf8')));
    const { newBackup } = await import('../../../local/engine.mjs');
    const name = newBackup(dir, 'daily', new Date(Date.now() + 1000));
    expect(name).toMatch(/-daily$/);
    const full = readFileSync(work, 'utf8');
    writeFileSync(work, full.split('\n').filter((l) => !l.includes('Call Anna')).join('\n'));
    await sleep(1600);   // (settled)
    expect(await restore({ name, dryRun: true })).toEqual({ lists: [], tasks: 1 });
    expect(readFileSync(work, 'utf8')).not.toContain('Call Anna');   // (a dry run changes nothing)
    expect(await restore({ name })).toEqual({ lists: [], tasks: 1 });
    expect(readFileSync(work, 'utf8')).toContain('Call Anna');
    expect(await restore({ name, dryRun: true })).toEqual({ busy: true, lists: [], tasks: 0 });   // (just written: settling)
    await sleep(1600);
    expect(await restore({ name, dryRun: true })).toEqual({ lists: [], tasks: 0 });   // nothing missing any more
  });

  it('gives the window its "Use with AI" instructions, with this lists folder in them', async () => {
    expect((await fetch(`${app.url}/api/local/ai-prompt`)).status).toBe(401);
    const res = await fetch(`${app.url}/api/local/ai-prompt`, { headers: { authorization: `Bearer ${app.token}` } });
    const { text } = await res.json();
    expect(text).toBe(aiPrompt(join(dir, 'lists')));
    expect(text).toContain(`\n${join(dir, 'lists')}\n`);
  });

  it('`saqme ai-prompt` prints the same text for any data folder, spaces and Georgian letters included, without the app running', async () => {
    const cli = fileURLToPath(new URL('../../../local/saqme.mjs', import.meta.url));
    const odd = join(dir, 'ჩემი სიები ტესტი');
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'ai-prompt', '--data', odd, '--port', '1']);
    expect(stdout).toBe(aiPrompt(join(odd, 'lists')));
    expect(existsSync(odd)).toBe(false);   // (printing it creates nothing)
  });

  it('connects cloud sync from a pairing link pasted in the window', async () => {
    const post = (link) => fetch(`${app.url}/api/local/connect`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ link }) });
    expect((await post('not a link')).status).toBe(400);
    const res = await post(`https://saqme.invalid/#pair=${'k'.repeat(43)}`);
    expect(res.status).toBe(200);
    const cfg = JSON.parse(readFileSync(join(dir, 'sync', 'config.json'), 'utf8'));
    expect(cfg).toMatchObject({ url: 'https://saqme.invalid', token: 'k'.repeat(43), enabled: true });
    const info = await until(async () => (await (await fetch(`${app.url}/api/local`, { headers: { authorization: `Bearer ${app.token}` } })).json()).cloud);
    expect(info.label).toBe('saqme.invalid');
    rmSync(join(dir, 'sync', 'config.json'));
  });

  it('Pair phone: the link plus a one-time code from the cloud service; the local server makes no codes itself', async () => {
    const auth = { authorization: `Bearer ${app.token}` };
    const key = 'k'.repeat(43);
    const cloud = createServer((req, res) => {   // a stand-in for the Worker's POST /api/pair/code
      const ok = req.method === 'POST' && req.url === '/api/pair/code' && req.headers.authorization === `Bearer ${key}`;
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { code: 'ABCD-EFGH', expiresAt: 1 } : { error: 'not found' }));
    });
    await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${cloud.address().port}`;
    mkdirSync(join(dir, 'sync'), { recursive: true });
    writeFileSync(join(dir, 'sync', 'config.json'), JSON.stringify({ url, token: key, deviceId: 'pc-x', enabled: true }));
    const pairing = async () => (await fetch(`${app.url}/api/local/pairing`, { headers: auth })).json();
    try {
      expect(await pairing()).toEqual({ link: `${url}/#pair=${key}`, code: 'ABCD-EFGH' });
      cloud.close(); cloud.closeAllConnections();
      expect(await pairing()).toEqual({ link: `${url}/#pair=${key}`, code: null });   // unreachable: the link still works
    } finally {
      cloud.close(); cloud.closeAllConnections();
      rmSync(join(dir, 'sync', 'config.json'), { force: true });
    }
    expect(await pairing()).toEqual({ link: null, code: null });
    expect((await fetch(`${app.url}/api/pair/code`, { method: 'POST', headers: auth })).status).toBe(404);
    expect((await fetch(`${app.url}/api/pair/claim`, { method: 'POST', body: '{"code":"ABCD-EFGH"}' })).status).toBe(401);
  });

  it('a window opened by `saqme open` claims the token once with a one-time code', async () => {
    const auth = { authorization: `Bearer ${app.token}` };
    const { code } = await (await fetch(`${app.url}/api/local/code`, { method: 'POST', headers: auth })).json();
    const claim = () => fetch(`${app.url}/api/local/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const first = await claim();
    expect(first.status).toBe(200);
    expect((await first.json()).token).toBe(app.token);
    expect((await claim()).status).toBe(403);
  });

  it('`saqme open` hands the window its code through a private file, never on the command line', async () => {
    const out = join(dir, 'browser-args.txt');
    const fake = join(dir, 'fake-browser.sh');   // a browser that only notes what it was asked to open
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
    const cli = fileURLToPath(new URL('../../../local/saqme.mjs', import.meta.url));
    // (not spawnSync: the app answering it runs in this very process)
    await promisify(execFile)(process.execPath, [cli, 'open', '--data', dir, '--port', String(app.port)], { env: { ...process.env, SAQME_BROWSER: fake } });
    const args = await until(() => existsSync(out) && readFileSync(out, 'utf8'));
    expect(args).not.toMatch(/claim/);   // other users of the computer can read command lines (ps)
    const page = fileURLToPath(/^--app=(file:\/\/\S+)$/m.exec(args)[1]);
    if (process.platform !== 'win32') expect(statSync(page).mode & 0o777).toBe(0o600);
    const code = /#claim=([A-Za-z0-9_-]+)/.exec(readFileSync(page, 'utf8'))[1];
    const claim = () => fetch(`${app.url}/api/local/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect((await (await claim()).json()).token).toBe(app.token);
    expect((await claim()).status).toBe(403);
  });

  it('Settings > Sync > Set up sync runs the cloud setup, shows its progress and turns sync on', async () => {
    // a stand-in for scripts/cloud-setup.mjs: talks like it, writes what it would
    const fake = join(dir, 'fake-cloud-setup.mjs');
    writeFileSync(fake, `
      import { writeFileSync, mkdirSync } from 'node:fs';
      import { dirname } from 'node:path';
      const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
      console.log('[2/7] Cloudflare account');
      console.log('Open https://dash.cloudflare.com/oauth2/auth?x=1 to sign in');
      console.log('\u2588\u2588\u2580\u2580\u2584\u2584   \u2588\u2588');
      await new Promise((r) => setTimeout(r, 300));
      mkdirSync(dirname(arg('--desktop-config')), { recursive: true });
      writeFileSync(arg('--desktop-config'), JSON.stringify({ url: 'https://saqme.invalid', token: '${'k'.repeat(43)}', deviceId: 'pc-x', enabled: true }));
      writeFileSync(arg('--result'), JSON.stringify({ ok: true, url: 'https://saqme.invalid', args: process.argv.slice(2) }));
    `);
    process.env.SAQME_CLOUD_SETUP_JS = fake;
    process.env.SAQME_CLOUD_STATE = join(dir, 'setup', 'cloud.json');
    const auth = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
    try {
      const started = await (await fetch(`${app.url}/api/local/cloud-setup`, { method: 'POST', headers: auth, body: '{}' })).json();
      expect(started.running).toBe(true);
      const done = await until(async () => { const st = await (await fetch(`${app.url}/api/local/cloud-setup`, { headers: auth })).json(); return st.running ? null : st; });
      expect(done.result).toMatchObject({ ok: true, url: 'https://saqme.invalid' });
      expect(done.result.args).toEqual(expect.arrayContaining(['--yes', '--state', join(dir, 'setup', 'cloud.json'), '--desktop-config', join(dir, 'sync', 'config.json')]));
      expect(done.lines).toContain('Open https://dash.cloudflare.com/oauth2/auth?x=1 to sign in');
      expect(done.lines.some((l) => /\u2588/.test(l))).toBe(false);   // the terminal QR code is left out
      const info = await until(async () => (await (await fetch(`${app.url}/api/local`, { headers: auth })).json()).cloud);
      expect(info.label).toBe('saqme.invalid');   // the cloud engine picked it up
      await fetch(`${app.url}/api/local/disconnect`, { method: 'POST', headers: auth, body: '{}' });
      expect(JSON.parse(readFileSync(join(dir, 'sync', 'config.json'), 'utf8')).enabled).toBe(false);   // turned off; the config (and lists) stay
    } finally {
      delete process.env.SAQME_CLOUD_SETUP_JS; delete process.env.SAQME_CLOUD_STATE;
      rmSync(join(dir, 'sync', 'config.json'), { force: true });
    }
  });

  it('a cloud setup that fails says why, and changes nothing', async () => {
    const fake = join(dir, 'fake-cloud-setup-fail.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
      console.error('Setup stopped: Cloudflare login did not finish.');
      writeFileSync(arg('--result'), JSON.stringify({ ok: false, message: 'Cloudflare login did not finish.', next: 'Run setup again.' }));
      process.exit(1);
    `);
    process.env.SAQME_CLOUD_SETUP_JS = fake;
    const auth = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
    try {
      await fetch(`${app.url}/api/local/cloud-setup`, { method: 'POST', headers: auth, body: '{}' });
      const done = await until(async () => { const st = await (await fetch(`${app.url}/api/local/cloud-setup`, { headers: auth })).json(); return st.running ? null : st; });
      expect(done.result).toEqual({ ok: false, message: 'Cloudflare login did not finish.', next: 'Run setup again.' });
      expect(existsSync(join(dir, 'sync', 'config.json'))).toBe(false);
    } finally { delete process.env.SAQME_CLOUD_SETUP_JS; }
  });

  it('what the window does shows up in the markdown file, and file edits show up in the window', async () => {
    const win = new Store({ base: app.url, autoSync: false });
    await win.open();
    win.pair(app.token);
    const loaded = await until(async () => { await win.sync({ force: true }); return win.tasks().length === 2; });
    expect(loaded).toBe(true);
    const report = win.tasks().find((t) => t.fields.text.v === 'Write the report');
    win.setTask(report.id, { status: 'x', text: 'Write the Q4 report' });
    await win.sync({ force: true });
    const file = () => readFileSync(join(dir, 'lists', 'Work.md'), 'utf8');
    expect(await until(() => file().includes(`- [x] Write the Q4 report ^${report.id}`))).toBe(true);
    expect(file().startsWith('# Today\n')).toBe(true);
    writeFileSync(join(dir, 'lists', 'Work.md'), `${file()}- [ ] Added by an AI assistant\n`);
    const seen = await until(async () => { await win.sync({ force: true }); return win.tasks().some((t) => t.fields.text.v === 'Added by an AI assistant'); });
    expect(seen).toBe(true);
  });
});

describe('started from inside another app\'s sandbox (local/paths.mjs sandboxOf)', () => {
  it('names a Flatpak, a strictly confined Snap and a macOS sandbox; a classic Snap or a plain shell is none', async () => {
    const { sandboxOf } = await import('../../../local/paths.mjs');
    expect(sandboxOf({ FLATPAK_ID: 'com.visualstudio.code' }, '/home/u')).toMatch(/com\.visualstudio\.code/);
    expect(sandboxOf({ SNAP_NAME: 'claude', SNAP_USER_DATA: '/home/u/snap/claude/12' }, '/home/u/snap/claude/12')).toMatch(/claude/);
    expect(sandboxOf({ SNAP_NAME: 'code', SNAP_USER_DATA: '/home/u/snap/code/12' }, '/home/u')).toBe('');   // classic: the real HOME
    expect(sandboxOf({ APP_SANDBOX_CONTAINER_ID: 'com.example.app' }, '/Users/u/Library/Containers/com.example.app/Data')).toMatch(/com\.example\.app/);
    expect(sandboxOf({}, '/home/u')).toBe('');
  });
  it('saqme serve refuses to start on the usual data folder there, and says why; --data still works', async () => {
    const cli = fileURLToPath(new URL('../../../local/saqme.mjs', import.meta.url));
    const env = { ...process.env, FLATPAK_ID: 'org.example.Editor' };
    delete env.SAQME_DATA;
    const r = await promisify(execFile)(process.execPath, [cli, 'serve', '--port', '1'], { env }).catch((e) => e);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/org\.example\.Editor.*second, empty lists folder/s);
    const ok = await promisify(execFile)(process.execPath, [cli, 'ai-prompt', '--data', dir, '--port', '1'], { env });   // (an explicit folder is fine)
    expect(ok.stdout).toContain(join(dir, 'lists'));
  });
});

describe('export and import (phone app)', () => {
  it('exports every list in the desktop format and imports them into another device without duplicates', async () => {
    const a = new Store({ autoSync: false });
    await a.open();
    const pid = a.addProject('Work');
    const t1 = a.addTask(pid, { text: 'Parent' });
    a.addTask(pid, { parentId: t1, text: 'Child' });
    a.setTask(t1, { due: { date: '2026-10-25', time: '9:30' }, notes: 'see https://example.com' });
    a.addProject('სახლი');
    const { files, order } = a.exportLists();
    expect(order).toEqual(['Work', 'სახლი']);
    expect(files[0].text).toMatch(new RegExp(`^- \\[ \\] Parent due:2026-10-25T9:30 \\^${t1}\\n {2}> see https://example.com\\n {2}- \\[ \\] Child \\^[0-9a-z]{8}\\n$`));

    const b = new Store({ autoSync: false });
    await b.open();
    expect(b.importLists(files)).toEqual({ added: 2, skipped: 0, projects: 2 });
    expect(b.importLists(files)).toEqual({ added: 0, skipped: 2, projects: 0 });
    const parent = b.get('task', t1);
    expect(parent.fields.notes.v).toBe('see https://example.com');
    expect(b.tasks().find((t) => t.fields.text.v === 'Child').fields.place.v.parent).toBe(t1);
    // a hand-made list without ids adds its tasks; new subtasks of a known task go under it
    const r = b.importLists([{ name: 'Work.md', text: `- [ ] Parent ^${t1}\n  - [x] Second child\n- [/] Loose task\n` }]);
    expect(r).toEqual({ added: 2, skipped: 1, projects: 0 });
    expect(b.tasks().find((t) => t.fields.text.v === 'Second child').fields.place.v.parent).toBe(t1);
  });
});
