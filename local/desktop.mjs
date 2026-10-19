// Desktop integration for Linux and macOS: native notifications and opening the app window.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const detached = (cmd, args) => { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); };

// ---------------------------------------------------------------- notifications
const osaQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Shows a desktop notification; resolves to true if a notifier ran. */
export function notify({ title, body = '', sub = '' }, { icon } = {}) {
  const os = platform();
  if (os === 'darwin') {
    const script = `display notification ${osaQuote(body)} with title ${osaQuote(title)}${sub ? ` subtitle ${osaQuote(sub)}` : ''}`;
    return spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  }
  if (os === 'linux') {
    const text = sub ? `${body}\n${sub}` : body;
    if (has('notify-send')) {
      // '--': a task text starting with "-" is text, not an option
      const args = ['-a', 'Saqme To Do', ...(icon && existsSync(icon) ? ['-i', icon] : []), '--', title, text];
      return spawnSync('notify-send', args, { stdio: 'ignore', timeout: 10_000 }).status === 0;
    }
    if (has('gdbus')) {
      // the freedesktop notification service directly (present on GNOME, KDE, Xfce, ...)
      const r = spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.Notify', '--', 'Saqme To Do', '0', icon && existsSync(icon) ? icon : 'appointment-soon', title, text, '[]', '{}', '10000'], { stdio: 'ignore', timeout: 10_000 });
      return r.status === 0;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the app window
// Chromium-family browsers open a plain app window (--app); others get a normal tab.
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'vivaldi'];
const MAC_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi'];

/** Opens url as an app window. Returns a short description of what was used. */
export function openWindow(url) {
  const os = platform();
  const custom = process.env.SAQME_BROWSER;
  if (custom) { detached(custom, [`--app=${url}`]); return custom; }
  if (os === 'darwin') {
    for (const app of MAC_BROWSERS) {
      if ([join('/Applications', `${app}.app`), join(process.env.HOME ?? '', 'Applications', `${app}.app`)].some(existsSync)) {
        detached('open', ['-na', app, '--args', `--app=${url}`, '--new-window']);
        return app;
      }
    }
    detached('open', [url]);
    return 'the default browser (in Safari: File > Add to Dock makes it an app)';
  }
  if (os === 'linux') {
    for (const b of LINUX_BROWSERS) if (has(b)) { detached(b, [`--app=${url}`]); return b; }
    if (has('xdg-open')) { detached('xdg-open', [url]); return 'the default browser'; }
  }
  if (os === 'win32') { detached('cmd', ['/c', 'start', '', url]); return 'the default browser'; }
  return null;
}
