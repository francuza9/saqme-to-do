// One version number for the whole app: "version" in worker/package.json. Bump it with
// `npm version X.Y.Z --no-git-tag-version` in worker/ (CONTRIBUTING.md, "How to ship an update"); the Worker,
// the Linux/macOS app, the Windows app, setup and the release workflow all read it from there.
import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;

/**
 * What this Worker's API offers, so apps that are older or newer than it (while an update is under way) can
 * tell "your sync service is not updated yet" from an error. Changes are additive only: a new route or field,
 * nothing an older app uses changes meaning, and each one raises the number.
 *   1  sync, push, pairing (1.0.0; a Worker that does not say is 1)
 *   2  shared lists: invites, share keys, the relay for phones (/api/shares, /api/remotes)
 *   3  the database updates itself; `api` and `version` in /api/health, /api/config and every /api/sync answer
 */
export const API_VERSION = 3;

/** The oldest Worker API the apps of this release work with (their sync); below it, the update waits for it. */
export const MIN_WORKER_API = 1;

/** What sharing a list (and joining one through the relay) needs; an older Worker says "not updated yet" instead. */
export const SHARING_API = 2;
