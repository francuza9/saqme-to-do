#!/usr/bin/env node
// Local development helper (run by `npm run dev` in worker/): creates worker/.dev.vars with a dev token
// and VAPID keys if missing, applies D1 migrations to the local (Miniflare) database and prints the
// pairing link for http://localhost:8787. Never touches Cloudflare.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../worker/src/push.js';

const worker = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker');
const vars = join(worker, '.dev.vars');

if (!existsSync(vars)) {
  const vapid = await generateVapidKeys();
  writeFileSync(vars, [
    `AUTH_TOKEN=${randomBytes(32).toString('base64url')}`,
    `VAPID_PUBLIC_KEY=${vapid.publicKey}`,
    `VAPID_PRIVATE_KEY=${vapid.privateKey}`,
    'VAPID_SUBJECT=mailto:dev@localhost.invalid',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log('Created worker/.dev.vars (local secrets, gitignored).');
}
const token = /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(vars, 'utf8'))?.[1];

const bin = join(worker, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const r = spawnSync(bin, ['d1', 'migrations', 'apply', 'saqme-dev', '--local', '-c', 'wrangler.dev.toml'],
  { cwd: worker, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CI: '1' } });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\nDev server pairing link: http://localhost:8787/#pair=${token}\n`);
