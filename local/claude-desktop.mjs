// Claude Desktop on this computer, for Settings > Use with AI > Connect Claude Desktop: whether it is installed, and
// Saqme in its settings file (claude_desktop_config.json, "mcpServers" > "saqme"), so that Claude Desktop starts
// `saqme mcp` (local/saqme.mjs) and has the lists in every chat, without sync and without anything pasted.
//
// The settings file is the user's: only the "saqme" entry is added, replaced or removed; everything else (other
// servers, preferences, the key order, the indent) stays. A file that is not plain JSON is left alone and the window
// says so. Before every change the file as it was is copied to claude_desktop_config.json.saqme-backup, and the new
// one replaces it in one step (temp file + rename). Connecting twice changes nothing the second time.
// The Windows app does the same in desktop/claude-desktop.ps1; shared/fixtures/claude-config.json holds the cases
// both must agree on.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { APP_DIR } from './paths.mjs';

export const SERVER_NAME = 'saqme';
export const BACKUP_SUFFIX = '.saqme-backup';
export const DOWNLOAD_URL = 'https://claude.ai/download';

export class ConfigError extends Error {
  constructor(message) { super(message); this.status = 409; }
}

/** Where Claude Desktop keeps claude_desktop_config.json. */
export function claudeConfigDir({ platform = osPlatform(), home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude');   // (development: the Windows app has its own)
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude');
}

/** Is Claude Desktop installed? (Linux has no official build: the community ones use ~/.config/Claude too.) */
export function claudeInstalled({ platform = osPlatform(), home = homedir(), env = process.env, exists = existsSync } = {}) {
  if (exists(join(claudeConfigDir({ platform, home, env }), 'claude_desktop_config.json'))) return true;
  if (platform === 'darwin') return [join('/Applications', 'Claude.app'), join(home, 'Applications', 'Claude.app')].some((p) => exists(p));
  if (platform === 'linux') return (env.PATH ?? '').split(delimiter).some((d) => d && exists(join(d, 'claude-desktop')));
  return exists(claudeConfigDir({ platform, home, env }));
}

/** What Claude Desktop runs: the launcher setup.sh wrote (it follows updates), else this copy's own Node and script. */
export function claudeEntry({ dataDir, launcher = process.env.SAQME_LAUNCHER, execPath = process.execPath, appDir = APP_DIR }) {
  if (launcher) return { command: launcher, args: ['mcp', '--data', dataDir] };
  return { command: execPath, args: ['--disable-warning=ExperimentalWarning', join(appDir, 'local', 'saqme.mjs'), 'mcp', '--data', dataDir] };
}

// ---------------------------------------------------------------- the settings file's text (pure)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parse(text) {
  const t = (text ?? '').replace(/^﻿/, '');
  if (!t.trim()) return {};
  let o;
  try { o = JSON.parse(t); } catch { throw new ConfigError('Claude Desktop\'s settings file is not plain JSON (it may have a comment or a typo in it), so Saqme left it alone.'); }
  if (!isObject(o)) throw new ConfigError('Claude Desktop\'s settings file does not look as expected, so Saqme left it alone.');
  if (o.mcpServers !== undefined && !isObject(o.mcpServers)) throw new ConfigError('Claude Desktop\'s settings file has an unexpected "mcpServers" part, so Saqme left it alone.');
  return o;
}

/** The file's own indent (two spaces when it has none) and line ending, so a change does not reformat it. */
function format(o, before) {
  const t = (before ?? '').replace(/^﻿/, '');
  const m = /\n([ \t]+)\S/.exec(t);
  const out = `${JSON.stringify(o, null, m ? m[1] : 2)}\n`;
  return /\r\n/.test(t) ? out.replace(/\n/g, '\r\n') : out;
}

/** -> 'none' | 'connected' (our entry, exactly) | 'other' (a "saqme" entry that runs something else); throws ConfigError. */
export function serverState(text, entry, name = SERVER_NAME) {
  const o = parse(text);
  const cur = o.mcpServers?.[name];
  if (cur === undefined) return 'none';
  return same(cur, entry) ? 'connected' : 'other';
}

/** Adds (or replaces, in its place) the entry -> { text, changed }. text null: no file yet. Throws ConfigError. */
export function addServer(text, entry, name = SERVER_NAME) {
  const o = parse(text);
  if (o.mcpServers?.[name] !== undefined && same(o.mcpServers[name], entry)) return { text, changed: false };
  o.mcpServers = { ...(o.mcpServers ?? {}), [name]: entry };
  return { text: format(o, text), changed: true };
}

/** Removes the entry, and nothing else -> { text, changed }. Throws ConfigError. */
export function removeServer(text, name = SERVER_NAME) {
  if (text === null || text === undefined) return { text, changed: false };
  const o = parse(text);
  if (!o.mcpServers || !Object.hasOwn(o.mcpServers, name)) return { text, changed: false };
  delete o.mcpServers[name];
  return { text: format(o, text), changed: true };
}

// ---------------------------------------------------------------- on disk
function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Writes text in one step, after a copy of what was there (path + BACKUP_SUFFIX). */
function replaceFile(path, text, before) {
  mkdirSync(dirname(path), { recursive: true });
  if (before !== null) copyFileSync(path, path + BACKUP_SUFFIX);
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Settings > Use with AI > Connect Claude Desktop, for the local server (local/server.mjs /api/local/claude-desktop). */
export class ClaudeDesktop {
  constructor({ entry, configDir = claudeConfigDir(), installed = () => claudeInstalled() }) {
    this.entry = entry;
    this.configPath = join(configDir, 'claude_desktop_config.json');
    this.installed = installed;
  }

  status() {
    const out = { installed: this.installed(), state: 'none', configPath: this.configPath, download: DOWNLOAD_URL };
    try { out.state = serverState(readText(this.configPath), this.entry); } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      out.state = 'unreadable';
      out.error = e.message;
    }
    return out;
  }

  connect() {
    if (!this.installed()) throw new ConfigError('Claude Desktop is not installed on this computer.');
    const before = readText(this.configPath);
    const r = addServer(before, this.entry);
    if (r.changed) replaceFile(this.configPath, r.text, before);
    return { ...this.status(), changed: r.changed };
  }

  disconnect() {
    const before = readText(this.configPath);
    const r = removeServer(before);
    if (r.changed) replaceFile(this.configPath, r.text, before);
    return { ...this.status(), changed: r.changed };
  }
}
