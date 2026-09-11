/*
  Weather 4 Bike – Service Worker

  Goal: Make the app usable at a trailhead with one bar of signal.

  Why: This is an app you check outdoors, on the move, on bad connections. A
  static page that only works online is the wrong shape for that.

  How:
  - App shell (HTML/CSS/JS/icons): cache-first, refreshed in the background.
  - Forecast API calls: network-first with a cache fallback, so you get fresh
    data when you can and yesterday's answer rather than an error when you can't.
    "When you can't" includes a network that is merely too slow: after a short
    deadline the saved copy answers, and the slow response still lands in the
    cache for next time. Saved copies carry the time they were fetched, so the
    page can say how old they are instead of passing them off as fresh.
  - Everything else (CDN scripts, photos): passes straight through.
*/

const VERSION = '0231bf90cb79';
const SHELL_CACHE = `w4b-shell-${VERSION}`;
// Deliberately not tied to VERSION: shipping new app code must not throw away
// the rider's offline forecast. Bump by hand only if the saved shape changes.
const DATA_CACHE = 'w4b-data-v1';

// How long the network gets before a saved copy answers instead. Shorter than
// the page's own request timeout (js/weather.js), so the saved copy wins.
const NETWORK_DEADLINE_MS = 6000;

// Written into saved copies; js/weather.js reads it. Keep the two in step.
const FETCHED_AT_FIELD = 'w4bFetchedAt';

const SHELL_ASSETS = [
  './',
  'index.html',
  'styles/output.css',
  'js/app.js',
  'js/weather.js',
  'js/insights.js',
  'js/location.js',
  'js/units.js',
  'js/time.js',
  'js/net.js',
  'manifest.json',
  'assets/icons/bike.svg',
  'assets/favicon_io/favicon-32x32.png',
  'assets/favicon_io/android-chrome-192x192.png'
];

const API_HOSTS = [
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'geocoding-api.open-meteo.com'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is atomic: one missing file would reject the whole install, so
      // add individually and tolerate misses.
      .then(cache => Promise.allSettled(SHELL_ASSETS.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('w4b-') && k !== SHELL_CACHE && k !== DATA_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(event));
    return;
  }

  // Only manage our own origin's assets; let CDN and photo requests go direct.
  if (url.origin !== self.location.origin) return;

  event.respondWith(cacheFirst(request));
});

/** Serve from cache immediately, then quietly refresh the entry for next time. */
async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const network = fetch(request)
    .then(response => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await network;
  if (fresh) return fresh;

  // Navigations fall back to the cached shell so the app still opens offline.
  if (request.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

const TIMED_OUT = Symbol('timed out');

/**
 * Fresh data when the network allows; the last good response when it does not.
 *
 * "Does not" used to mean only an outright failure — which on one bar of signal
 * can take a minute to arrive. Now the network gets NETWORK_DEADLINE_MS, then a
 * saved copy answers. With nothing saved, waiting is the only option left.
 */
async function networkFirst(event) {
  const { request } = event;

  // Start the request before any await, and keep the worker alive until it
  // settles, so a response that loses the race still refreshes the cache.
  const network = fetch(request).then(async response => {
    if (response && response.ok) {
      const copy = await stamped(response.clone());
      if (copy) await (await caches.open(DATA_CACHE)).put(request, copy);
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  let deadline;
  const timeout = new Promise(resolve => { deadline = setTimeout(resolve, NETWORK_DEADLINE_MS, TIMED_OUT); });

  try {
    const first = await Promise.race([network, timeout]);
    if (first !== TIMED_OUT) return first;
  } catch {
    // Failed outright; fall through to the saved copy.
  } finally {
    clearTimeout(deadline);
  }

  const cached = await (await caches.open(DATA_CACHE)).match(request);
  if (cached) return cached;
  return network; // nothing saved — keep waiting (and reject if it fails)
}

/** A copy of a JSON response, tagged with when it was fetched. */
async function stamped(response) {
  try {
    const data = await response.json();
    data[FETCHED_AT_FIELD] = Date.now();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    return null; // not JSON — not worth saving
  }
}
