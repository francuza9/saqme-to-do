// The service worker's app shell must hold every file the app loads, or the app does not start offline.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const pub = new URL('../../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, pub), 'utf8');

describe('service worker', () => {
  it('caches every module the app imports, and the stylesheets and fonts index.html uses', () => {
    const shell = new Set([...read('sw.js').matchAll(/'([^']+\.(?:js|css|ttf|png|webmanifest|html))'/g)].map((m) => m[1]));
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, dep] of read(file).matchAll(/^import [^'"]*['"]\.\/([^'"]+)['"]/gm)) walk(`js/${dep}`);
    };
    walk('js/app.js');
    for (const f of seen) expect(shell.has(f), `${f} in sw.js`).toBe(true);
    for (const [, href] of read('index.html').matchAll(/(?:href|src)="([^"#:]+\.(?:css|js))"/g)) expect(shell.has(href.replace(/^\.\//, '')), `${href} in sw.js`).toBe(true);
    expect(readdirSync(new URL('js/', pub)).filter((f) => f.endsWith('.js')).every((f) => shell.has(`js/${f}`))).toBe(true);
    // the languages (js/i18n.js loads the one in use when the app starts: offline too)
    const langs = readdirSync(new URL('js/lang/', pub)).filter((f) => f.endsWith('.js'));
    expect(langs.length).toBe(5);
    for (const f of langs) expect(shell.has(`js/lang/${f}`), `js/lang/${f} in sw.js`).toBe(true);
  });
});

// A tap on a deadline reminder opens its task (sw.js notificationclick), run here with a stand-in for the worker scope.
describe('service worker: tapping a reminder', () => {
  function load(clients) {
    const handlers = {};
    const shown = [];
    const opened = [];
    const self = {
      location: new URL('https://saqme.example/'),
      addEventListener: (type, fn) => { handlers[type] = fn; },
      registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); } },
      clients: { matchAll: async () => clients, openWindow: async (url) => { opened.push(url); } },
    };
    new Function('self', 'caches', 'fetch', read('sw.js'))(self, {}, () => {});
    const fire = (type, event) => {
      const waits = [];
      handlers[type]({ ...event, waitUntil: (p) => waits.push(p) });
      return Promise.all(waits);
    };
    return { fire, shown, opened };
  }
  const push = (d) => ({ data: { json: () => d } });
  const tapped = (n) => ({ notification: { close() {}, data: n.data } });
  const client = (url) => ({ url, messages: [], focused: false, focus() { this.focused = true; }, postMessage(m) { this.messages.push(m); } });

  it('tells an open window which task, and brings it to the front', async () => {
    const win = client('https://saqme.example/');
    const sw = load([win]);
    await sw.fire('push', push({ title: 'In 15 min', body: 'Call the bank', tag: 'due-k3j9x2ab', task: 'k3j9x2ab', url: '/' }));
    await sw.fire('notificationclick', tapped(sw.shown[0]));
    expect(win.messages).toEqual([{ type: 'open-task', id: 'k3j9x2ab' }]);
    expect(win.focused).toBe(true);
    expect(sw.opened).toEqual([]);
  });
  it('starts the app on the task when no window is open', async () => {
    const sw = load([]);
    await sw.fire('push', push({ title: 'Due now', body: 'x', task: 'k3j9x2ab', url: '/' }));
    await sw.fire('notificationclick', tapped(sw.shown[0]));
    expect(sw.opened).toEqual(['/#task=k3j9x2ab']);
  });
  it('the daily summary just opens the app; a made-up task id is dropped', async () => {
    const win = client('https://saqme.example/');
    const sw = load([win]);
    await sw.fire('push', push({ title: 'Due today', body: 'x', url: '/' }));
    await sw.fire('push', push({ title: 'In 5 min', body: 'x', task: 'x" onclick=' }));
    expect(sw.shown.map((n) => n.data.task)).toEqual(['', '']);
    await sw.fire('notificationclick', tapped(sw.shown[0]));
    expect(win.messages).toEqual([]);
    expect(win.focused).toBe(true);
  });
  it('does not use the invite page as the app window', async () => {
    const join = client('https://saqme.example/join.html');
    const app = client('https://saqme.example/');
    const sw = load([join, app]);
    await sw.fire('push', push({ title: 'Due now', body: 'x', task: 'k3j9x2ab' }));
    await sw.fire('notificationclick', tapped(sw.shown[0]));
    expect(join.messages).toEqual([]);
    expect(app.messages).toHaveLength(1);
  });
});
