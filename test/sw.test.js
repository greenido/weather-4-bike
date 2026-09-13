/*
  Service worker tests.

  sw.js is a classic worker script, not a module, so it cannot be imported.
  Instead the real file is run in a VM context with stand-ins for `self`,
  `caches` and `fetch`. What is under test is the shipped code, byte for byte.
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { deferred } from './helpers.js';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const API = 'https://api.open-meteo.com/v1/forecast?latitude=32.08&longitude=34.78';

// Deadlines in sw.js are real seconds; run them 1000× faster so the suite stays quick.
const TIME_SCALE = 1000;

/** In-memory CacheStorage, enough of it for sw.js. */
function fakeCaches() {
  const stores = new Map();
  const keyOf = req => (typeof req === 'string' ? req : req.url);
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(req) { return store.get(keyOf(req))?.clone(); },
        async put(req, res) { store.set(keyOf(req), res); },
        async add(url) { store.set(url, new Response('shell')); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
}

function loadWorker(fetchImpl) {
  const listeners = {};
  const caches = fakeCaches();
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: { origin: 'https://app.example' },
    skipWaiting: () => {},
    clients: { claim: () => {} }
  };
  vm.runInContext(SOURCE, vm.createContext({
    self, caches, fetch: fetchImpl, Response, Request, URL, console,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms / TIME_SCALE, ...args),
    clearTimeout
  }));
  return { listeners, caches };
}

/** Fire a fetch event; resolve with what the worker answered. */
async function request(worker, url) {
  let answer;
  const lifetime = [];
  worker.listeners.fetch({
    request: new Request(url),
    respondWith: p => { answer = p; },
    waitUntil: p => { lifetime.push(p); }
  });
  const response = await answer;
  return { response, settled: () => Promise.all(lifetime) };
}

async function saved(worker) {
  const names = await worker.caches.keys();
  const data = names.find(n => n.startsWith('w4b-data'));
  const hit = data && await (await worker.caches.open(data)).match(API);
  return hit ? hit.json() : null;
}

const body = temp => new Response(JSON.stringify({ temp }), { headers: { 'Content-Type': 'application/json' } });

describe('sw.js — forecast requests', () => {
  test('a quick network answer is served, and saved with a fetched-at stamp', async () => {
    const worker = loadWorker(async () => body(21));
    const before = Date.now();
    const { response, settled } = await request(worker, API);
    await settled();

    assert.deepEqual(await response.json(), { temp: 21 }, 'the page gets the untouched live body');
    const copy = await saved(worker);
    assert.equal(copy.temp, 21);
    assert.ok(copy.w4bFetchedAt >= before, 'saved copy knows when it was fetched');
  });

  test('offline: the saved copy answers, carrying its original stamp', async () => {
    let online = true;
    const worker = loadWorker(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return body(21);
    });
    await (await request(worker, API)).settled();
    const stamp = (await saved(worker)).w4bFetchedAt;

    online = false;
    const { response } = await request(worker, API);
    const data = await response.json();
    assert.equal(data.temp, 21);
    assert.equal(data.w4bFetchedAt, stamp, 'the page can tell this is an old copy');
  });

  test('one bar of signal: after the deadline the saved copy answers — then the slow reply refreshes it', async () => {
    let slow = null;
    const worker = loadWorker(async () => {
      if (!slow) return body(21);
      return slow.promise;
    });
    await (await request(worker, API)).settled(); // prime the cache with 21

    slow = deferred(); // the network now stalls
    const pending = request(worker, API);
    // Scaled deadline is 6 ms; 100 ms is plenty. Fail cleanly rather than hang.
    const answered = await Promise.race([pending, new Promise(r => setTimeout(r, 100, null))]);
    if (!answered) slow.resolve(body(0));
    assert.ok(answered, 'answered from the saved copy without waiting for the network');
    const { response, settled } = answered;
    assert.equal((await response.json()).temp, 21);

    slow.resolve(body(18)); // the stalled request finally lands
    await settled();
    assert.equal((await saved(worker)).temp, 18, 'the late response still updates the cache for next time');
  });

  test('slow network with nothing saved: waits for it rather than failing early', async () => {
    const slow = deferred();
    const worker = loadWorker(() => slow.promise);
    const pending = request(worker, API);
    setTimeout(() => slow.resolve(body(25)), 20); // well past the scaled deadline
    const { response } = await pending;
    assert.equal((await response.json()).temp, 25);
  });

  test('offline with nothing saved: the failure reaches the page', async () => {
    const worker = loadWorker(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(request(worker, API), TypeError);
  });

  test('an error response is passed through, and not saved over a good copy', async () => {
    let status = 200;
    const worker = loadWorker(async () => (status === 200 ? body(21) : new Response('{}', { status })));
    await (await request(worker, API)).settled();

    status = 503;
    const { response, settled } = await request(worker, API);
    await settled();
    assert.equal(response.status, 503);
    assert.equal((await saved(worker)).temp, 21);
  });
});

describe('sw.js — deploys do not wipe offline data', () => {
  test('activate drops old shell caches and old versioned data caches, keeps the data cache', async () => {
    const worker = loadWorker(async () => body(21));
    for (const name of ['w4b-shell-oldversion', 'w4b-data-oldversion', 'w4b-data-v1', 'someone-elses-cache']) {
      await worker.caches.open(name);
    }
    const lifetime = [];
    worker.listeners.activate({ waitUntil: p => lifetime.push(p) });
    await Promise.all(lifetime);

    const left = await worker.caches.keys();
    assert.ok(left.includes('w4b-data-v1'), 'the rider’s offline forecast survives');
    assert.ok(!left.includes('w4b-shell-oldversion'));
    assert.ok(!left.includes('w4b-data-oldversion'), 'the pre-fix per-version data cache is cleaned up');
    assert.ok(left.includes('someone-elses-cache'), 'only our own caches are touched');
  });

  test('the data cache name does not change when the app version does', () => {
    const version = SOURCE.match(/const VERSION = '([^']*)'/)[1];
    const bumped = SOURCE.replace(/const VERSION = '[^']*'/, "const VERSION = 'something-else'");
    const dataCacheOf = src => {
      const ctx = vm.createContext({ self: { addEventListener() {} } });
      vm.runInContext(`${src}\nthis.__data = DATA_CACHE;`, ctx);
      return ctx.__data;
    };
    assert.ok(version);
    assert.equal(dataCacheOf(SOURCE), dataCacheOf(bumped));
  });
});

describe('sw.js — shell', () => {
  test('precaches the new modules, so the offline app can start', () => {
    for (const file of ['js/time.js', 'js/net.js', 'js/routes.js']) {
      assert.ok(SOURCE.includes(`'${file}'`), `${file} is in SHELL_ASSETS`);
    }
  });
});
