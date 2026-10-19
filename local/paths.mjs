// Where the Linux/macOS app keeps things. The data folder has the same layout as on Windows
// (%APPDATA%\SaqmeToDo): lists/*.md, sync/config.json + state.json (cloud sync), plus local/ for this app.
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');   // holds local/ and worker/
export const DEFAULT_PORT = 47613;

export function defaultDataDir() {
  if (process.env.SAQME_DATA) return resolve(process.env.SAQME_DATA);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Saqme To Do');
  if (platform() === 'win32') return join(process.env.APPDATA || homedir(), 'SaqmeToDo-local');   // development only
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'saqme');
}

export function dataPaths(dataDir = defaultDataDir()) {
  return {
    data: dataDir,
    lists: join(dataDir, 'lists'),
    local: join(dataDir, 'local'),
    db: join(dataDir, 'local', 'store.db'),
    token: join(dataDir, 'local', 'token'),
    server: join(dataDir, 'local', 'server.json'),      // { port, pid } of the running server
    filesState: join(dataDir, 'local', 'files-state.json'),
    log: join(dataDir, 'local', 'saqme.log'),
    sync: join(dataDir, 'sync'),
    cloudConfig: join(dataDir, 'sync', 'config.json'),   // written by setup.sh --cloud (cloud-setup.mjs)
    cloudState: join(dataDir, 'sync', 'state.json'),
  };
}

/**
 * What the cloud setup generated (token, push keys, database id): setup.sh's setup folder, the same one
 * whether sync was set up from the app or with setup.sh --cloud. SAQME_CLOUD_STATE: tests.
 */
export function cloudSetupStatePath() {
  if (process.env.SAQME_CLOUD_STATE) return resolve(process.env.SAQME_CLOUD_STATE);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Saqme To Do', 'setup', 'cloud.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'saqme', 'cloud.json');
}

export const appPaths = {
  public: join(APP_DIR, 'worker', 'public'),
  migrations: join(APP_DIR, 'worker', 'migrations'),
  icon: join(APP_DIR, 'worker', 'public', 'icons', 'icon-192.png'),
  get cloudSetup() { return process.env.SAQME_CLOUD_SETUP_JS || join(APP_DIR, 'scripts', 'cloud-setup.mjs'); },   // env: tests
};
