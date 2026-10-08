import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWeatherResponse, formatWeatherData, getDaylightRanges, fetchWeatherData, parseAirQuality
} from '../js/weather.js';
import { scoreHourlySeries, findBestWindow } from '../js/insights.js';
import { dayPrefix, formatClock, isNight } from '../js/time.js';
import { TimeoutError } from '../js/net.js';
import { inZone, inZoneAsync, VIEWER_ZONES, metFixture } from './helpers.js';

const TLV = 'Asia/Jerusalem';
const HOUR = 3600;
const DAY = 24 * HOUR;

// Tel Aviv, local midnight Wed 2026-09-09 (UTC+3 → 21:00Z the evening before).
const START = Date.parse('2026-09-08T21:00:00Z') / 1000;

// The moment from the bug report: Thu 19:59 in California, Fri 05:59 in Tel Aviv.
const NOW = new Date('2026-09-11T02:59:00Z');

/**
 * An Open-Meteo response shaped exactly like the real one for
 * `timezone=auto&timeformat=unixtime`. The temperature is the local hour of
 * day, so "which hour did the app pick as now?" can be read off the reading.
 */
function telAvivFixture({ days = 5 } = {}) {
  const hours = days * 24;
  const time = Array.from({ length: hours }, (_, i) => START + i * HOUR);
  const fill = v => Array(hours).fill(v);
  return {
    latitude: 32.08,
    longitude: 34.78,
    timezone: TLV,
    timezone_abbreviation: 'GMT+3',
    utc_offset_seconds: 3 * HOUR,
    hourly: {
      time,
      temperature_2m: time.map((_, i) => i % 24),
      apparent_temperature: time.map((_, i) => i % 24),
      relativehumidity_2m: fill(50),
      precipitation_probability: fill(0),
      precipitation: fill(0),
      weathercode: fill(0),
      windspeed_10m: fill(5),
      winddirection_10m: fill(270),
      windgusts_10m: fill(8),
      visibility: fill(20000),
      uv_index: fill(2),
      cloudcover: fill(10)
    },
    daily: {
      time: Array.from({ length: days }, (_, d) => START + d * DAY),
      sunrise: Array.from({ length: days }, (_, d) => START + d * DAY + 6 * HOUR + 20 * 60), // 06:20
      sunset: Array.from({ length: days }, (_, d) => START + d * DAY + 19 * HOUR),           // 19:00
      temperature_2m_max: Array(days).fill(23),
      temperature_2m_min: Array(days).fill(0),
      weathercode: Array(days).fill(0)
    }
  };
}

const load = (data = telAvivFixture(), now = NOW) => formatWeatherData(parseWeatherResponse(data, now), now);

describe('parseWeatherResponse — "now" is the location’s now', () => {
  test('current conditions are for 06:00 in Tel Aviv, from any viewer zone', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        const w = load();
        assert.equal(w.current.time, '2026-09-11T03:00:00.000Z', `viewer in ${zone}`);
        // The bug showed 19:00 the previous evening from California: 19, not 6.
        assert.equal(w.current.temperature, 6, `viewer in ${zone}`);
      });
    }
  });

  test('every hourly time is an exact instant', () => {
    const w = load();
    for (const h of w.hourly) assert.match(h.time, /Z$/);
    assert.equal(w.hourly[0].time, '2026-09-08T21:00:00.000Z');
  });

  test('the hourly strip starts at the current hour', () => {
    inZone('America/Los_Angeles', () => {
      const w = load();
      assert.equal(w.next24FromNearest[0].time, '2026-09-11T03:00:00.000Z');
      assert.equal(formatClock(w.next24FromNearest[0].time, w.timezone, 'en-US'), '06:00 AM');
    });
  });
});

describe('formatWeatherData — "today" is the location’s today', () => {
  test('the 7-day list starts on Friday in Tel Aviv, even where it is still Thursday', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        const w = load();
        assert.equal(w.daily[0].date, '2026-09-11', `viewer in ${zone}`);
        assert.equal(w.today.date, '2026-09-11', `viewer in ${zone}`);
      });
    }
  });

  test('daily dates are calendar dates, even though the API stamps them the evening before in UTC', () => {
    const w = parseWeatherResponse(telAvivFixture(), NOW);
    assert.deepEqual(w.daily.map(d => d.date), ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
  });

  test('sunrise and sunset are exact instants', () => {
    const w = load();
    assert.equal(w.today.sunrise, '2026-09-11T03:20:00.000Z');
    assert.equal(w.today.sunset, '2026-09-11T16:00:00.000Z');
  });
});

describe('end to end: the labels from the bug report', () => {
  test('it is night at 05:59 in Tel Aviv', () => {
    inZone('America/Los_Angeles', () => {
      const w = load();
      assert.equal(isNight(NOW, getDaylightRanges(w)), true);
    });
  });

  test('the best window falls in Friday’s daylight and is labelled today, not "Tomorrow"', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        const w = load();
        const scored = scoreHourlySeries(w, 'road', { now: NOW, hours: 48 });
        const best = findBestWindow(scored, { now: NOW, daylight: getDaylightRanges(w), minHours: 2, maxHours: 2, withinHours: 24 });
        assert.ok(best, `a window exists (viewer in ${zone})`);
        assert.ok(best.start >= new Date(w.today.sunrise) && best.end <= new Date(w.today.sunset),
          `inside Friday's daylight (viewer in ${zone})`);
        assert.equal(dayPrefix(best.start, NOW, w.timezone, 'en-US'), '', `viewer in ${zone}`);
      });
    }
  });

  test('scoring starts from the real current hour, not eleven hours ago', () => {
    inZone('America/Los_Angeles', () => {
      const scored = scoreHourlySeries(load(), 'road', { now: NOW, hours: 24 });
      // First entry is the hour we are inside (05:00–06:00 local).
      assert.equal(scored[0].time, '2026-09-11T02:00:00.000Z');
    });
  });
});

describe('an old forecast does not pretend to cover the present', () => {
  test('beyond the forecast’s last hour there is no "current" at all', () => {
    const later = new Date(NOW.getTime() + 30 * DAY * 1000);
    const w = load(telAvivFixture(), later);
    assert.equal(w.current.time, null);
    assert.equal(w.current.temperature, null, 'unknown, not the last hour dressed up as now');
    assert.deepEqual(w.next24FromNearest, []);
  });

  test('within the forecast, an old copy still finds the right hour', () => {
    const later = new Date(NOW.getTime() + DAY * 1000); // a day later, still covered
    assert.equal(load(telAvivFixture(), later).current.time, '2026-09-12T03:00:00.000Z');
  });
});

describe('parseAirQuality', () => {
  test('uses the hour nearest the real now', () => {
    const data = {
      timezone: TLV,
      hourly: {
        time: [0, 1, 2, 3].map(i => Date.parse('2026-09-11T01:00:00Z') / 1000 + i * HOUR),
        us_aqi: [10, 20, 30, 40],
        pm2_5: [1, 2, 3, 4]
      }
    };
    const air = parseAirQuality(data, NOW); // 02:59Z → the 03:00Z reading
    assert.equal(air.aqi, 30);
    assert.equal(air.pm25, 3);
  });

  test('nothing near now → no reading', () => {
    const data = { hourly: { time: [Date.parse('2026-01-01T00:00:00Z') / 1000], us_aqi: [99] } };
    assert.equal(parseAirQuality(data, NOW), null);
  });
});

// ---------------------------------------------------------------------------
// Fetch policy
// ---------------------------------------------------------------------------

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data)
});

function recordingFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

/**
 * A fetch that answers Open-Meteo and MET Norway from separate queues, so a
 * test can say what each provider does and then check who was asked.
 */
function providers({ openMeteo = [], met = [] }) {
  const calls = { openMeteo: [], met: [] };
  const impl = async (url, init) => {
    const name = url.startsWith('https://api.met.no/') ? 'met' : 'openMeteo';
    const queue = name === 'met' ? met : openMeteo;
    calls[name].push({ url, init });
    const next = queue[Math.min(calls[name].length - 1, queue.length - 1)];
    if (next === undefined) throw new Error(`unexpected ${name} request`);
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

const hanging = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

const opts = impl => ({ fetchImpl: impl, retryDelayMs: 0 });

describe('fetchWeatherData — what is retried', () => {
  test('requests Unix timestamps', async () => {
    const { impl, calls } = recordingFetch(json(telAvivFixture()));
    await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.match(calls[0].url, /[?&]timeformat=unixtime(&|$)/);
    assert.match(calls[0].url, /[?&]timezone=auto(&|$)/);
  });

  test('does not ask for variables nothing reads — each one costs rate-limit quota', async () => {
    const { impl, calls } = recordingFetch(json(telAvivFixture()));
    await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    for (const unused of ['surface_pressure', 'apparent_temperature_max', 'uv_index_max', 'windgusts_10m_max']) {
      assert.doesNotMatch(calls[0].url, new RegExp(unused), unused);
    }
  });

  test('an API rejection (400) retries once with the reduced variable set', async () => {
    const { impl, calls } = recordingFetch(json({ error: true, reason: 'bad variable' }, 400), json(telAvivFixture()));
    const w = await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /soil_moisture/);
    assert.doesNotMatch(calls[1].url, /soil_moisture/, 'second attempt uses the reduced set');
    assert.equal(w.timezone, TLV);
    assert.equal(w.source, 'open-meteo');
  });

  test('a server error (5xx) is retried once, and a recovery stays on Open-Meteo', async () => {
    const { impl, calls } = providers({ openMeteo: [json({}, 503), json(telAvivFixture())] });
    const w = await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(calls.openMeteo.length, 2);
    assert.equal(calls.met.length, 0);
    assert.equal(w.source, 'open-meteo');
  });

  test('a network failure does not retry the reduced set — it would fail the same way', async () => {
    const { impl, calls } = providers({ openMeteo: [new TypeError('Failed to fetch')], met: [json(metFixture())] });
    await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(calls.openMeteo.length, 1);
  });
});

describe('fetchWeatherData — MET Norway as the backup', () => {
  test('a rate limit (429) goes straight to MET, without retrying a limit that resets by the minute', async () => {
    const { impl, calls } = providers({ openMeteo: [json({ reason: 'Daily API request limit exceeded' }, 429)], met: [json(metFixture())] });
    const w = await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(calls.openMeteo.length, 1);
    assert.equal(calls.met.length, 1);
    assert.match(calls.met[0].url, /complete\?lat=32\.08&lon=34\.78$/);
    assert.equal(w.source, 'met.no');
    assert.equal(w.offline, false);
    assert.equal(w.hourly.length, 62);
  });

  test('a server error that persists past the retry goes to MET', async () => {
    const { impl, calls } = providers({ openMeteo: [json({}, 503)], met: [json(metFixture())] });
    const w = await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(calls.openMeteo.length, 2);
    assert.equal(w.source, 'met.no');
  });

  test('Open-Meteo unreachable goes to MET', async () => {
    const { impl } = providers({ openMeteo: [new TypeError('Failed to fetch')], met: [json(metFixture())] });
    assert.equal((await fetchWeatherData(32.08, 34.78, opts(impl))).source, 'met.no');
  });

  test('two rejections (400) go to MET after trying the reduced set', async () => {
    const { impl, calls } = providers({ openMeteo: [json({ reason: 'nope' }, 400)], met: [json(metFixture())] });
    const w = await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(calls.openMeteo.length, 2);
    assert.equal(w.source, 'met.no');
  });

  test('when both fail, Open-Meteo’s error is the one reported', async () => {
    const { impl } = providers({ openMeteo: [json({ reason: 'nope' }, 429)], met: [json({}, 500)] });
    await assert.rejects(fetchWeatherData(32.08, 34.78, opts(impl)), /429/);
  });

  test('an empty MET answer counts as a failure, not as a blank forecast', async () => {
    const empty = { properties: { timeseries: [] } };
    const { impl } = providers({ openMeteo: [json({}, 429)], met: [json(empty)] });
    await assert.rejects(fetchWeatherData(32.08, 34.78, opts(impl)), /429/);
  });

  test('a cancelled request never moves on to MET', async () => {
    const controller = new AbortController();
    const { impl, calls } = providers({ openMeteo: [hanging], met: [json(metFixture())] });
    const pending = fetchWeatherData(32.08, 34.78, { ...opts(impl), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, err => err.name === 'AbortError');
    assert.equal(calls.met.length, 0);
  });

  test('a cancel during the 5xx retry wait stops there', async () => {
    const controller = new AbortController();
    const { impl, calls } = providers({ openMeteo: [json({}, 503)], met: [json(metFixture())] });
    const pending = fetchWeatherData(32.08, 34.78, { fetchImpl: impl, retryDelayMs: 60000, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, err => err.name === 'AbortError');
    assert.equal(calls.openMeteo.length, 1);
    assert.equal(calls.met.length, 0);
  });

  test('uses the time zone Open-Meteo reported for this place earlier, not a guess', async (t) => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    };
    t.after(() => { delete globalThis.localStorage; });

    await inZoneAsync('America/Los_Angeles', async () => {
      const first = providers({ openMeteo: [json(telAvivFixture())] });
      await fetchWeatherData(32.08, 34.78, opts(first.impl));

      const later = providers({ openMeteo: [json({}, 429)], met: [json(metFixture())] });
      const w = await fetchWeatherData(32.08, 34.78, { ...opts(later.impl), force: true });
      assert.equal(w.source, 'met.no');
      assert.equal(w.timezone, TLV);
    });
  });

  test('without a remembered zone, a faraway place gets a solar-offset zone', async () => {
    await inZoneAsync('America/Los_Angeles', async () => {
      const { impl } = providers({ openMeteo: [json({}, 429)], met: [json(metFixture())] });
      const w = await fetchWeatherData(32.08, 34.78, opts(impl));
      assert.equal(w.timezone, 'Etc/GMT-2');
    });
  });
});

describe('fetchWeatherData — deadlines and cancellation', () => {
  test('Open-Meteo gets 15 s, then MET a shorter 8 s; the reduced set is never tried', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { impl, calls } = providers({ openMeteo: [hanging], met: [hanging] });
    const flush = () => new Promise(resolve => setImmediate(resolve));

    const pending = fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    let settled = false;
    pending.catch(() => {}).finally(() => { settled = true; });

    t.mock.timers.tick(14999);
    await flush();
    assert.equal(calls.met.length, 0, 'still waiting on Open-Meteo just before its deadline');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls.met.length, 1, 'MET asked once Open-Meteo timed out');

    t.mock.timers.tick(7999);
    await flush();
    assert.equal(settled, false, 'still waiting on MET just before its deadline');

    t.mock.timers.tick(1);
    await assert.rejects(pending, TimeoutError);
    assert.equal(calls.openMeteo.length, 1, 'a timeout is not retried with the reduced set');
  });

  test('a superseded request is cancelled with the caller’s signal', async () => {
    const controller = new AbortController();
    const pending = fetchWeatherData(32.08, 34.78, { fetchImpl: hanging, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, err => err.name === 'AbortError');
  });
});

describe('fetchWeatherData — how old is this data?', () => {
  test('a live response is fresh as of now', async () => {
    const before = Date.now();
    const { impl } = recordingFetch(json(telAvivFixture()));
    const w = await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.equal(w.offline, false);
    assert.ok(w.fetchedAt >= before && w.fetchedAt <= Date.now());
  });

  test('the service worker’s saved copy reports its real age and is marked offline', async () => {
    const savedAt = Date.parse('2026-09-09T10:00:00Z');
    const { impl } = recordingFetch(json({ ...telAvivFixture(), w4bFetchedAt: savedAt }));
    const w = await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.equal(w.offline, true);
    assert.equal(w.fetchedAt, savedAt, 'not the time it happened to be rendered');
  });

  test('a saved MET copy keeps its stamp too', async () => {
    const savedAt = Date.parse('2026-09-09T10:00:00Z');
    const { impl } = providers({ openMeteo: [json({}, 429)], met: [json({ ...metFixture(), w4bFetchedAt: savedAt })] });
    const w = await fetchWeatherData(32.08, 34.78, opts(impl));
    assert.equal(w.source, 'met.no');
    assert.equal(w.offline, true);
    assert.equal(w.fetchedAt, savedAt);
  });
});
