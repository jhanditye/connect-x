/* Mimic Vocal Coach service worker. Generated into dist/sw.js by scripts/pwa-plugin.ts: do not edit dist/sw.js.
 *
 * Strategy
 *  - Precache every file of the build (app shell, JS, CSS, fonts, icons) in one versioned cache.
 *  - Serve the app offline-first: navigations get the cached index.html, assets come from the cache.
 *  - Never touch cross-origin requests (the optional Claude coach talks to api.anthropic.com) or non-GET requests.
 *  - Updates are safe: a new worker installs in the background and WAITS. The page shows "Update ready"; the
 *    user taps it, the page posts SKIP_WAITING, and the app reloads on controllerchange. A running recording
 *    or analysis is never reloaded behind the user's back.
 */
const VERSION = '__MIMIC_VERSION__';
const PRECACHE = __MIMIC_PRECACHE__;

const CACHE_PREFIX = 'mimic-precache-';
const CACHE = CACHE_PREFIX + VERSION;
const SCOPE = self.registration.scope; // e.g. https://user.github.io/connect-x/
const toUrl = (path) => new URL(path, SCOPE).href;
const SHELL = toUrl('index.html');

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

async function precache() {
  const cache = await caches.open(CACHE);
  const others = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE);

  async function fromOlderCaches(url) {
    for (const name of others) {
      const hit = await (await caches.open(name)).match(url);
      if (hit) return hit;
    }
    return null;
  }

  for (const entry of PRECACHE) {
    const url = toUrl(entry.url);
    if (await cache.match(url)) continue; // install retried after a partial failure
    // Immutable (content-hashed) files are copied, not downloaded again.
    let response = entry.revision === null ? await fromOlderCaches(url) : null;
    if (!response) {
      // cache: 'reload' skips the HTTP cache (GitHub Pages sends max-age=600), so a fresh deploy is never half-stale.
      response = await fetch(new Request(url, { cache: 'reload' }));
    }
    if (!response.ok) throw new Error('Precache failed for ' + entry.url + ' (' + response.status + ')');
    await cache.put(url, response);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  else if (data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Anthropic API and anything else cross-origin: straight to the network
  if (!url.href.startsWith(SCOPE)) return; // other projects on the same github.io origin
  event.respondWith(respond(request));
});

async function respond(request) {
  const cache = await caches.open(CACHE);
  if (request.mode === 'navigate') {
    // Single-page app with hash routes: every navigation inside the scope is the shell.
    const shell = await cache.match(SHELL);
    return shell || fetch(request);
  }
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}
