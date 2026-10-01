import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planPlace, rankPlans, scoreWindowAt, shareHash, parseShareHash } from '../js/plan.js';
import { scoreHourlySeries } from '../js/insights.js';

const HOUR = 3600 * 1000;
// Midnight UTC; the fixture's location is on UTC too, so its days are UTC days.
const NOW = new Date('2026-10-01T00:00:00Z');
const BAD = { windSpeed: 65, precipitationProbability: 100, precipitation: 6 };

/** Three days, daylight 06:00–18:00 UTC, with `good(hourIndex)` deciding each hour. */
function threeDays(good) {
  const hourly = Array.from({ length: 72 }, (_, i) => ({
    time: new Date(NOW.getTime() + i * HOUR).toISOString(),
    temperature: 18, humidity: 50, windSpeed: 5, windDirection: 180,
    precipitation: 0, precipitationProbability: 0, visibility: 20000, uvIndex: 2, weatherCode: 0,
    ...(good(i) ? {} : BAD)
  }));
  const daily = [0, 1, 2].map(d => ({
    date: new Date(NOW.getTime() + d * 24 * HOUR).toISOString().slice(0, 10),
    sunrise: new Date(NOW.getTime() + (d * 24 + 6) * HOUR).toISOString(),
    sunset: new Date(NOW.getTime() + (d * 24 + 18) * HOUR).toISOString()
  }));
  return { timezone: 'UTC', hourly, daily };
}

describe('planPlace', () => {
  test('finds the best window of the week and the best one on each day', () => {
    // Only day 2 (index 1), 08:00–11:00, is rideable.
    const weather = threeDays(i => i >= 32 && i < 35);
    const plan = planPlace(weather, 'road', { rideHours: 2, now: NOW });

    assert.ok(plan.best);
    assert.equal(plan.best.start.toISOString(), '2026-10-02T08:00:00.000Z');
    assert.equal(plan.days.length, 3);
    assert.deepEqual(plan.days.map(d => d.dateKey), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.ok(plan.days[1].window.score > plan.days[0].window.score);
    assert.equal(plan.days[1].window.start.toISOString(), plan.best.start.toISOString());
  });

  test('keeps to daylight, and to the ride length asked for', () => {
    const plan = planPlace(threeDays(() => true), 'road', { rideHours: 3, now: NOW });
    for (const { window } of plan.days) {
      assert.equal(window.hours, 3);
      assert.ok(window.start.getUTCHours() >= 6 && window.end.getUTCHours() <= 18);
    }
  });

  test('a forecast with no hours has no plan, rather than throwing', () => {
    assert.deepEqual(planPlace({ hourly: [], daily: [] }, 'road', { now: NOW }), { best: null, days: [] });
  });
});

describe('rankPlans', () => {
  const at = (h, score) => ({ plan: { best: { start: new Date(NOW.getTime() + h * HOUR), score } } });

  test('best score first, then the sooner ride, then places with no window', () => {
    const none = { plan: { best: null } };
    const later = at(30, 9);
    const sooner = at(10, 9);
    const worse = at(5, 7);
    assert.deepEqual(rankPlans([none, worse, later, sooner]), [sooner, later, worse, none]);
  });
});

describe('scoreWindowAt', () => {
  const scored = scoreHourlySeries(threeDays(i => i < 10), 'road', { now: NOW, hours: 72 });

  test('scores exactly the proposed hours', () => {
    const w = scoreWindowAt(scored, new Date(NOW.getTime() + 2 * HOUR), 2);
    assert.equal(w.hours, 2);
    assert.equal(w.end.getTime() - w.start.getTime(), 2 * HOUR);
    assert.ok(w.score >= 8, `a calm dry window scores well, got ${w.score}`);
    assert.ok(scoreWindowAt(scored, new Date(NOW.getTime() + 20 * HOUR), 2).score < w.score);
  });

  test('null when the forecast does not cover the whole ride, or the input is junk', () => {
    assert.equal(scoreWindowAt(scored, new Date(NOW.getTime() + 71 * HOUR), 3), null);
    assert.equal(scoreWindowAt(scored, new Date(NOW.getTime() - 5 * HOUR), 2), null);
    assert.equal(scoreWindowAt(scored, new Date('nope'), 2), null);
    assert.equal(scoreWindowAt(scored, NOW, 0), null);
  });
});

describe('share links', () => {
  const place = { name: 'Ada’s Loop', latitude: 37.774929, longitude: -122.419416 };
  const start = new Date('2026-10-03T15:00:00Z');

  test('round-trip a ride through the fragment', () => {
    const hash = shareHash({ place, activity: 'gravel', hours: 3, start });
    assert.ok(hash.startsWith('#'));
    const back = parseShareHash(hash);
    assert.equal(back.place.name, 'Ada’s Loop');
    assert.equal(back.activity, 'gravel');
    assert.equal(back.hours, 3);
    assert.equal(back.start.toISOString(), start.toISOString());
  });

  test('coordinates are rounded to ~1 km, so a link does not pinpoint a home', () => {
    const back = parseShareHash(shareHash({ place }));
    assert.equal(back.place.latitude, 37.77);
    assert.equal(back.place.longitude, -122.42);
  });

  test('drops what it cannot trust, and needs a place to mean anything', () => {
    assert.equal(parseShareHash(''), null);
    assert.equal(parseShareHash('#a=road'), null);
    assert.equal(parseShareHash('#lat=95&lon=0'), null);
    assert.equal(parseShareHash('#lat=abc&lon=0'), null);

    const odd = parseShareHash('#lat=1&lon=2&a=unicycle&h=12&start=whenever');
    assert.equal(odd.activity, null);
    assert.equal(odd.hours, null);
    assert.equal(odd.start, null);
    assert.equal(odd.place.name, 'Shared location');
  });
});
