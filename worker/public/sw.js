// Saqme To Do service worker: offline app shell + push notifications.
// Assets are network-first with a short timeout, falling back to the cache, so a deploy shows up on the
// next launch without version bumps and the app still opens with no connection. /api is never cached.
// Paths are relative to this file, so the app also works from a sub-folder (e.g. GitHub Pages).

const CACHE = 'saqme-shell-v5';
const SHELL = [
  './', 'css/tokens.css', 'css/app.css', 'fonts/FiraGO-Regular.ttf', 'fonts/FiraGO-Italic.ttf', 'fonts/FiraGO-Medium.ttf',
  'fonts/FiraGO-SemiBold.ttf', 'js/app.js', 'js/store.js', 'js/model.js', 'js/keys.js', 'js/dates.js', 'js/icons.js',
  'js/markdown.js', 'js/pairing.js', 'js/zip.js', 'js/qr.js', 'js/theme.js', 'js/join.js', 'js/ai.js', 'js/i18n.js',
  'js/lang/en.js', 'js/lang/ka.js', 'js/lang/fr.js', 'js/lang/es.js', 'js/lang/de.js', 'manifest.webmanifest', 'icons/glyph.png', 'icons/apple-touch-icon.png',
  'icons/icon-192.png', 'icons/favicon-64.png',
];
const SCOPE = new URL('./', self.location).pathname;
const TIMEOUT_MS = 3500;
const TASK_ID = /^[0-9a-z]{8,32}$/;   // (a task's id, as in the app)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const network = fetch(request, { cache: 'no-cache' }).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(cacheKey, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline */ }
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  if (cached) return cached;
  return network;   // nothing cached yet: wait for the network after all
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(`${SCOPE}api/`)) return;
  // the invite page of a shared list (join.html) is a page of its own, never the app shell
  if (/^\/join(\.html|\/)?$/.test(url.pathname.slice(SCOPE.length - 1))) return;
  const key = event.request.mode === 'navigate' ? SCOPE : url.pathname;
  event.respondWith(networkFirst(event.request, key));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data?.text() }; }
  const body = [d.body, d.sub && d.sub !== 'Saqme To Do' ? d.sub : null].filter(Boolean).join('\n');
  event.waitUntil(self.registration.showNotification(d.title || 'Saqme To Do', {
    body, tag: d.tag || undefined, renotify: !!d.tag, icon: 'icons/icon-192.png', badge: 'icons/favicon-64.png',
    data: { url: d.url && d.url !== '/' ? d.url : SCOPE, task: typeof d.task === 'string' && TASK_ID.test(d.task) ? d.task : '' },
  }));
});

// A tap on a deadline reminder opens its task: an open window is brought to the front and told which one; else the
// app starts with #task=<id> (app.js reads it). The summary has no task: it just opens the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const task = event.notification.data?.task || '';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = all.find((c) => !/\/join(\.html|\/)?$/.test(new URL(c.url).pathname)) || all[0];
    if (app && 'focus' in app) {
      if (task) app.postMessage({ type: 'open-task', id: task });
      return app.focus();
    }
    return self.clients.openWindow(task ? `${SCOPE}#task=${task}` : event.notification.data?.url || SCOPE);
  })());
});
