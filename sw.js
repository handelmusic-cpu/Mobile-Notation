/* MōdScore service worker.
 *
 * The app was already set up to be installed — manifest, Apple meta tags,
 * standalone display, VexFlow and Tone vendored into lib/ after a CDN outage
 * once rendered a blank sheet — but none of that survives airplane mode
 * without a worker, because the document itself still came off the network.
 * A music stand in a rehearsal room is exactly where that matters.
 *
 * Two caches, deliberately kept apart:
 *   SHELL   the app itself. Precached on install, replaced wholesale on
 *           version bump, and always served from cache first — an installed
 *           app should not wait on a network round trip to open.
 *   SAMPLES the recorded instruments, which stream from tonejs.github.io and
 *           nbrosowsky.github.io. Cached as they are played, so the second
 *           time you play a piano part offline it still sounds like a piano
 *           instead of falling back to the oscillator voice.
 */
const VERSION = 'v1';
const SHELL = 'modscore-shell-' + VERSION;
const SAMPLES = 'modscore-samples-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './lib/vexflow.js',
  './lib/Tone.js',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

// Hosts whose responses are worth keeping. Opaque cross-origin responses are
// cacheable and replayable even though we cannot read their status.
const SAMPLE_HOSTS = ['tonejs.github.io', 'nbrosowsky.github.io'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Individually, so one 404 cannot fail the whole install and leave the
    // app with no worker at all.
    await Promise.all(SHELL_FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, SAMPLES]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (SAMPLE_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheThenNetwork(req, SAMPLES));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navigations: cache first so the app opens instantly and offline, with a
  // background refresh so a deploy is picked up by the next launch.
  if (req.mode === 'navigate') {
    e.respondWith(cacheThenNetwork(new Request('./index.html'), SHELL, req));
    return;
  }
  e.respondWith(cacheThenNetwork(req, SHELL));
});

async function cacheThenNetwork(req, cacheName, fallbackReq) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) {
    // Refresh in the background; never block the response on it.
    fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); }).catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(fallbackReq || req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const shell = await caches.match('./index.html');
    if (shell && (fallbackReq || req).mode === 'navigate') return shell;
    throw err;
  }
}
