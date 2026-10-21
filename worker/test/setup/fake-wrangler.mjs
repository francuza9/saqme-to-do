// Stand-in for wrangler used by test/node/cloud-setup.test.js: same commands and output shapes as the
// real CLI (whoami --json, d1 list --json, d1 create, migrations apply, secret list, deploy [--secrets-file]),
// backed by a JSON file instead of Cloudflare. st.worker: the deployed Worker ({ secrets: [names] }), if any;
// like Cloudflare it keeps its secrets across deploys without a secrets file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const statePath = process.env.FAKE_WRANGLER_STATE;
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { loggedIn: false, dbs: [], deploys: [], subdomain: true, calls: [] };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2));
const args = process.argv.slice(2);
st.calls.push(args.join(' '));
const [cmd, sub] = args;
const interactive = !process.env.CI;

function exit(code, out = '', err = '') { if (out) process.stdout.write(out); if (err) process.stderr.write(err); save(); process.exit(code); }

if (cmd === 'whoami') {
  if (!st.loggedIn) exit(1, '', '{"loggedIn":false}\n');
  exit(0, JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'me@example.com', accounts: st.accounts ?? [{ id: '0123456789abcdef0123456789abcdef', name: 'My Account' }] }) + '\n');
}
if (cmd === 'login' && sub === '--device') {   // the device flow's text, as wrangler 4 prints it
  st.loggedIn = true;
  exit(0, '\nTo authorize Wrangler, please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  WXYZ-2345\n\nYou have 10 minutes to approve this request.\nSuccessfully logged in.\n');
}
if (cmd === 'login') { st.loggedIn = true; exit(0, 'Successfully logged in.\n'); }
if (cmd === 'd1' && sub === 'list') exit(0, JSON.stringify(st.dbs.map((d) => ({ uuid: d.uuid, name: d.name, created_at: '2026-10-19' })), null, 2) + '\n');
if (cmd === 'd1' && sub === 'create') {
  const uuid = `uuid-${st.dbs.length + 1}-0000-0000-000000000000`;
  st.dbs.push({ name: args[2], uuid });
  exit(0, `✅ Successfully created DB '${args[2]}'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${args[2]}"\ndatabase_id = "${uuid}"\n`);
}
if (cmd === 'd1' && sub === 'migrations') {
  if (!st.dbs.find((d) => d.name === args[3])) exit(1, '', `Couldn't find DB with name '${args[3]}'\n`);
  const first = !st.migrated; st.migrated = true;
  exit(0, first ? '🚣 17 commands executed successfully.\n' : '✅ No migrations to apply!\n');
}
if (cmd === 'd1' && sub === 'execute') {
  if (!st.dbs.find((d) => d.name === args[2])) exit(1, '', `Couldn't find DB with name '${args[2]}'\n`);
  st.executed = [...(st.executed ?? []), args[args.indexOf('--command') + 1]];
  exit(0, '🚣 1 command executed successfully.\n');
}
if (cmd === 'secret' && sub === 'list') {
  if (!st.worker) exit(1, '', '✘ [ERROR] This Worker does not exist on your account. [code: 10007]\n');
  exit(0, JSON.stringify(st.worker.secrets.map((name) => ({ name, type: 'secret_text' })), null, 2) + '\n');
}
if (cmd === 'deploy') {
  const toml = readFileSync('wrangler.toml', 'utf8');
  if (!/database_id = "uuid-/.test(toml)) exit(1, '', 'wrangler.toml has no database id\n');
  const at = args.indexOf('--secrets-file');
  const secrets = at > 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : null;
  if (!st.subdomain) {
    if (!interactive) exit(1, '', '▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev\n✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.toml file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/0123/workers/onboarding\n');
    st.subdomain = true;
  }
  st.worker = { secrets: [...new Set([...(st.worker?.secrets ?? []), ...Object.keys(secrets ?? {})])] };
  st.deploys.push({ secrets, interactive });
  exit(0, 'Total Upload: 40.00 KiB / gzip: 10.00 KiB\nUploaded saqme (1.23 sec)\nDeployed saqme triggers (0.5 sec)\n  https://saqme.my-sub.workers.dev\n  schedule: */5 * * * *\nCurrent Version ID: 1234\n');
}
exit(1, '', `fake wrangler: unsupported command ${args.join(' ')}\n`);
