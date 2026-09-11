import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWeatherResponse, formatWeatherData, getDaylightRanges, fetchWeatherData, parseAirQuality
} from '../js/weather.js';
import { scoreHourlySeries, findBestWindow } from '../js/insights.js';
import { dayPrefix, formatClock, isNight } from '../js/time.js';
import { TimeoutError } from '../js/net.js';
import { inZone, VIEWER_ZONES } from './helpers.js';

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

describe('fetchWeatherData — what is retried', () => {
  test('requests Unix timestamps', async () => {
    const { impl, calls } = recordingFetch(json(telAvivFixture()));
    await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.match(calls[0].url, /[?&]timeformat=unixtime(&|$)/);
    assert.match(calls[0].url, /[?&]timezone=auto(&|$)/);
  });

  test('an API rejection (400) retries once with the reduced variable set', async () => {
    const { impl, calls } = recordingFetch(json({ error: true, reason: 'bad variable' }, 400), json(telAvivFixture()));
    const w = await fetchWeatherData(32.08, 34.78, { fetchImpl: impl });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /soil_moisture/);
    assert.doesNotMatch(calls[1].url, /soil_moisture/, 'second attempt uses the reduced set');
    assert.equal(w.timezone, TLV);
  });

  test('a network failure is not retried — the smaller request would fail the same way', async () => {
    const { impl, calls } = recordingFetch(new TypeError('Failed to fetch'), json(telAvivFixture()));
    await assert.rejects(fetchWeatherData(32.08, 34.78, { fetchImpl: impl }), TypeError);
    assert.equal(calls.length, 1);
  });

  test('a server error (5xx) is not retried either', async () => {
    const { impl, calls } = recordingFetch(json({}, 503), json(telAvivFixture()));
    await assert.rejects(fetchWeatherData(32.08, 34.78, { fetchImpl: impl }), /503/);
    assert.equal(calls.length, 1);
  });

  test('two rejections surface the API’s reason', async () => {
    const { impl } = recordingFetch(json({ reason: 'nope' }, 400));
    await assert.rejects(fetchWeatherData(32.08, 34.78, { fetchImpl: impl }), /400/);
  });
});

describe('fetchWeatherData — deadlines and cancellation', () => {
  test('gives up after 15 s, once, instead of waiting forever and then again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const hanging = (url, init) => new Promise((_, reject) => {
      calls.push(url);
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });

    const pending = fetchWeatherData(32.08, 34.78, { fetchImpl: hanging });
    let settled = false;
    pending.catch(() => {}).finally(() => { settled = true; });

    t.mock.timers.tick(14999);
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting just before the deadline');

    t.mock.timers.tick(1);
    await assert.rejects(pending, TimeoutError);
    assert.equal(calls.length, 1, 'a timeout is not retried with the reduced set');
  });

  test('a superseded request is cancelled with the caller’s signal', async () => {
    const controller = new AbortController();
    const hanging = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
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
});
