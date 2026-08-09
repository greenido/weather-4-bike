/*
  Weather 4 Bike – Service Worker

  Goal: Make the app usable at a trailhead with one bar of signal.

  Why: This is an app you check outdoors, on the move, on bad connections. A
  static page that only works online is the wrong shape for that.

  How:
  - App shell (HTML/CSS/JS/icons): cache-first, refreshed in the background.
  - Forecast API calls: network-first with a cache fallback, so you get fresh
    data when you can and yesterday's answer rather than an error when you can't.
  - Everything else (CDN scripts, photos): passes straight through.
*/

const VERSION = 'a5ae11a6e83d';
const SHELL_CACHE = `w4b-shell-${VERSION}`;
const DATA_CACHE = `w4b-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  'index.html',
  'styles/output.css',
  'js/app.js',
  'js/weather.js',
  'js/insights.js',
  'js/location.js',
  'js/units.js',
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
    event.respondWith(networkFirst(request));
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

/** Fresh data when the network allows; the last good response when it does not. */
async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}
