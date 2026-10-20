// Lists shared with this computer (docs/sync.md, "Shared lists"). Each is one file in lists/, synced with its
// owner's sync server by an engine of its own (engine.mjs with a scope), while the engine for this computer's own
// cloud leaves it out. Where things are:
//   lists/.remotes.json   the bindings, no secrets: { version: 1, remotes: [{ id, file, server, project, access,
//                         name, joinedAt, left? }] } (next to .order: it belongs with the files)
//   sync/remotes.json     the keys and this computer's device id for them (private, like sync/config.json)
//   sync/shares/<id>.json each engine's state (the same format as sync/state.json)
// Nothing of this goes to this computer's own sync server. The same files as on Windows (desktop/sync-worker.ps1).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseInviteLink, serverLabel } from '../worker/public/js/pairing.js';
import { parseItems } from '../worker/public/js/markdown.js';
import { projectFileNames, readText, uniqueFileName, withNewIds, writeAtomic } from './engine.mjs';

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export class Shares {
  /** lists, sync: the folders; fetchImpl: tests. */
  constructor({ lists, sync, log = () => {}, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { lists, sync, log, fetchImpl });
    this.bindingsPath = join(lists, '.remotes.json');
    this.keysPath = join(sync, 'remotes.json');
    this.ended = [];   // shares that ended this run, for the window ({ id, name, kept, at })
  }

  all() {
    const d = readJson(this.bindingsPath);
    return Array.isArray(d?.remotes) ? d.remotes.filter((r) => r && typeof r.id === 'string' && typeof r.file === 'string') : [];
  }
  get(id) { return this.all().find((r) => r.id === id) ?? null; }
  /** The files the engines of one's own server leave out (also those being left). */
  names() { return new Set(this.all().map((r) => r.file)); }
  save(list) { writeAtomic(this.bindingsPath, `${JSON.stringify({ version: 1, remotes: list }, null, 2)}\n`); }
  update(id, values) { this.save(this.all().map((r) => (r.id === id ? { ...r, ...values } : r))); }

  keys() { const k = readJson(this.keysPath); return k && typeof k === 'object' ? k : {}; }
  token(id) { return this.keys().tokens?.[id] ?? null; }
  /** The device id this computer uses on other people's servers (one, made on first use). */
  deviceId() {
    const k = this.keys();
    if (k.deviceId) return k.deviceId;
    k.deviceId = `${process.platform === 'darwin' ? 'mac' : 'pc'}-${randomBytes(8).toString('hex').slice(0, 10)}`;
    writePrivate(this.keysPath, JSON.stringify(k, null, 2));
    return k.deviceId;
  }
  setToken(id, token) {
    const k = this.keys();
    k.tokens = { ...(k.tokens ?? {}) };
    if (token) k.tokens[id] = token; else delete k.tokens[id];
    writePrivate(this.keysPath, JSON.stringify(k, null, 2));
  }
  statePath(id) { return join(this.sync, 'shares', `${id}.json`); }

  /**
   * A file name for a list joined now: its name, made unique among the lists and the other bindings; one another
   * list has already gets whose it is: "Groceries (from nuca)" (server: the list's owner's).
   */
  freeName(name, server = '') {
    const taken = new Set([...projectFileNames(this.lists), ...this.names()].map((n) => n.toLowerCase()));
    return uniqueFileName(this.lists, name, taken, '', server ? serverLabel(server) : '');
  }

  /**
   * Joins a list from its invite link: trades the one-time code for a key of this computer's own, then binds a new
   * file to it (the share's engine creates the file on its first sync). -> the binding. Throws with a message.
   */
  async join(link) {
    const inv = parseInviteLink(link);
    if (!inv) throw new Error('That is not an invite link (it looks like https://…/join#code=…).');
    let res;
    try {
      res = await this.fetchImpl(`${inv.server}/api/shares/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error(`Could not reach ${new URL(inv.server).host}. Try again when you are online.`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.token !== 'string' || !/^[0-9a-z]{8,32}$/.test(data.projectId ?? '')) throw new Error(data.error || `The invite did not work (${res.status}).`);
    const known = this.all().find((r) => r.project === data.projectId && r.server === inv.server && !r.left);
    if (known && data.kind === 'move') {
      // moved here (from the browser) onto the list this computer has: one key for it, the new one
      const old = this.token(known.id);
      this.setToken(known.id, data.token);
      if (old && old !== data.token) this.leaveRemote(inv.server, old);
      this.update(known.id, { access: data.access === 'edit' ? 'edit' : 'view' });
      this.log(`shares: ${known.file} moved here from another app`);
      return this.get(known.id);
    }
    if (known) {
      this.leaveRemote(inv.server, data.token);
      throw new Error(`“${data.projectName}” is already here.`);
    }
    const id = `s${randomBytes(6).toString('hex')}`;
    const binding = {
      id, file: this.freeName(String(data.projectName || 'Shared list'), inv.server), server: inv.server, project: data.projectId,
      access: data.access === 'edit' ? 'edit' : 'view', name: String(data.projectName ?? ''), joinedAt: Date.now(),
    };
    this.setToken(id, data.token);   // the key first: a binding without one is never synced
    this.save([...this.all(), binding]);
    this.log(`shares: joined ${binding.file} from ${new URL(inv.server).host} (${binding.access})`);
    return binding;
  }

  leaveRemote(server, token) {
    this.fetchImpl(`${server}/api/shares/leave`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => {});
  }

  /** Forgets a binding: its key, its engine's state. */
  forget(id) {
    this.save(this.all().filter((r) => r.id !== id));
    this.setToken(id, null);
    try { unlinkSync(this.statePath(id)); } catch { /* none */ }
  }

  /**
   * Leave: the file goes to lists/.trash (never erased), the binding and the key go. Nothing changes on the
   * owner's server except that this key ends. Marked as left first, so no engine syncs the file meanwhile.
   */
  leave(id) {
    const b = this.get(id);
    if (!b) throw new Error('not a list shared with this computer');
    const token = this.token(id);
    this.update(id, { left: true });
    const path = join(this.lists, `${b.file}.md`);
    if (existsSync(path)) {
      mkdirSync(join(this.lists, '.trash'), { recursive: true });
      renameSync(path, join(this.lists, '.trash', `${b.file}-${stamp()}.md`));
    }
    this.forget(id);
    if (token) this.leaveRemote(b.server, token);
    this.log(`shares: left ${b.file}`);
    return b;
  }

  /**
   * Its owner stopped sharing it (the key got 401): the file stays as one of this computer's own lists, with new
   * ids so it never gets mixed up with the owner's copy (should it be shared again). -> the old task ids.
   */
  end(id) {
    const b = this.get(id);
    if (!b) return [];
    const path = join(this.lists, `${b.file}.md`);
    const text = readText(path);
    const old = text == null ? [] : parseItems(text).filter((it) => it.kind === 'task' && it.id).map((it) => it.id);
    if (text != null) writeAtomic(path, withNewIds(text));   // still bound while this runs: no engine takes it for its own yet
    this.forget(id);
    this.ended.push({ id, name: b.file, kept: text != null, at: Date.now() });
    this.log(`shares: ${b.file} is no longer shared with this computer (the owner ended it); kept as an own list`);
    return old;
  }
}
