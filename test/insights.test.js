/*
  Tests for the scoring engine.

  These are the rules that decide whether someone rides today, and they are pure
  functions with no dependencies — so there was never a good reason for them to
  be untested. Several cases below are regressions for bugs that shipped.
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreConditions, scoreTier, scoreHourlySeries, findBestWindow, findRainTiming,
  recentPrecipSum, mudFactorFromRain, generateSafetyAlerts, generateRecommendations,
  DISCIPLINES, num
} from '../js/insights.js';

/** A calm, mild, dry, clear day — the baseline that should score 10. */
const PERFECT = {
  temperatureC: 18,
  humidityPct: 50,
  windKmh: 5,
  precipitationProbabilityPct: 0,
  precipitationMm: 0,
  visibilityKm: 20,
  uvIndex: 2,
  weatherCode: 0
};

describe('num()', () => {
  test('treats missing values as unknown, not zero', () => {
    assert.equal(num(null), null);
    assert.equal(num(undefined), null);
    assert.equal(num(''), null);
    assert.equal(num(NaN), null);
    assert.equal(num('12.5'), 12.5);
    assert.equal(num(0), 0);
  });
});

describe('scoreConditions – baseline', () => {
  test('perfect conditions score 10', () => {
    const r = scoreConditions(PERFECT, { discipline: 'road' });
    assert.equal(r.score, 10);
    assert.equal(r.tier.key, 'excellent');
  });

  test('score never leaves the 1–10 range', () => {
    const awful = {
      temperatureC: 45, humidityPct: 100, windKmh: 80, windGustKmh: 120,
      precipitationProbabilityPct: 100, precipitationMm: 20,
      visibilityKm: 0.1, uvIndex: 12, weatherCode: 95
    };
    const r = scoreConditions(awful, { discipline: 'road' });
    assert.equal(r.score, 1);
    assert.ok(r.score >= 1 && r.score <= 10);
  });
});

describe('precipitation (regression: rain was not scored at all)', () => {
  test('a certain downpour cannot score 10', () => {
    const r = scoreConditions(
      { ...PERFECT, precipitationProbabilityPct: 100, precipitationMm: 5 },
      { discipline: 'road' }
    );
    // 5 raw precipitation penalty x 1.2 road weight = 6 points off a perfect 10.
    assert.equal(r.score, 4);
    assert.notEqual(r.tier.key, 'excellent');
    assert.ok(r.breakdown.some(b => b.name === 'Precipitation'));
  });

  test('probability alone is enough to cost points', () => {
    const r = scoreConditions({ ...PERFECT, precipitationProbabilityPct: 80 }, { discipline: 'road' });
    assert.ok(r.score < 10, 'an 80% chance of rain should not be a perfect day');
  });

  test('rain hurts road more than MTB', () => {
    const wet = { ...PERFECT, precipitationProbabilityPct: 100, precipitationMm: 2 };
    const road = scoreConditions(wet, { discipline: 'road' });
    const mtb = scoreConditions(wet, { discipline: 'mtb' });
    assert.ok(road.score < mtb.score);
  });
});

describe('unknown inputs (regression: null was scored as zero)', () => {
  test('a missing visibility reading is skipped, not penalised', () => {
    const withoutVisibility = { ...PERFECT };
    delete withoutVisibility.visibilityKm;

    const r = scoreConditions(withoutVisibility, { discipline: 'road' });
    assert.equal(r.score, 10, 'unknown visibility must not cost points');
    assert.ok(r.unknown.includes('Visibility'));
  });

  test('an actual zero-visibility reading still costs the full penalty', () => {
    const r = scoreConditions({ ...PERFECT, visibilityKm: 0 }, { discipline: 'road' });
    assert.equal(r.score, 7);
    assert.ok(!r.unknown.includes('Visibility'));
  });

  test('missing UV and humidity are reported as unknown', () => {
    const r = scoreConditions(
      { temperatureC: 18, windKmh: 5, precipitationProbabilityPct: 0, visibilityKm: 20 },
      { discipline: 'road' }
    );
    assert.ok(r.unknown.includes('UV'));
    assert.ok(r.unknown.includes('Humidity'));
    assert.equal(r.score, 10);
  });
});

describe('feels-like temperature', () => {
  test('apparent temperature drives the comfort penalty when present', () => {
    const withApparent = scoreConditions(
      { ...PERFECT, temperatureC: 30, apparentTemperatureC: 38 },
      { discipline: 'road' }
    );
    const withoutApparent = scoreConditions(
      { ...PERFECT, temperatureC: 30 },
      { discipline: 'road' }
    );
    assert.ok(withApparent.score < withoutApparent.score,
      'a 30°C day that feels like 38°C must score worse than one that feels like 30°C');
  });
});

describe('gusts', () => {
  test('gust spread costs points beyond the mean wind', () => {
    const steady = scoreConditions({ ...PERFECT, windKmh: 25, windGustKmh: 27 }, { discipline: 'road' });
    const gusty = scoreConditions({ ...PERFECT, windKmh: 25, windGustKmh: 60 }, { discipline: 'road' });
    assert.ok(gusty.score < steady.score);
  });

  test('unknown gusts are not penalised', () => {
    const r = scoreConditions({ ...PERFECT, windKmh: 5 }, { discipline: 'road' });
    assert.ok(r.unknown.includes('Gusts'));
  });
});

describe('wind direction', () => {
  test('headwind is worse than tailwind at the same speed', () => {
    const head = scoreConditions({ ...PERFECT, windKmh: 35 }, { discipline: 'road', windRelation: 'headwind' });
    const cross = scoreConditions({ ...PERFECT, windKmh: 35 }, { discipline: 'road', windRelation: 'crosswind' });
    const tail = scoreConditions({ ...PERFECT, windKmh: 35 }, { discipline: 'road', windRelation: 'tailwind' });
    assert.ok(head.score < cross.score);
    assert.ok(cross.score < tail.score);
  });
});

describe('hard ceilings', () => {
  test('thunderstorms cap the score regardless of everything else', () => {
    const r = scoreConditions({ ...PERFECT, weatherCode: 95 }, { discipline: 'road' });
    assert.ok(r.score <= 1.5);
    assert.equal(r.tier.key, 'skip');
    assert.match(r.message, /Thunderstorm/i);
  });

  test('extreme heat caps the score', () => {
    const r = scoreConditions({ ...PERFECT, temperatureC: 40 }, { discipline: 'road' });
    assert.ok(r.score <= 2);
  });

  test('freezing rain caps the score', () => {
    const r = scoreConditions({ ...PERFECT, temperatureC: 1, weatherCode: 66 }, { discipline: 'road' });
    assert.ok(r.score <= 1.5);
  });

  test('near-freezing with rain flags ice risk', () => {
    const r = scoreConditions(
      { ...PERFECT, temperatureC: 0.5, precipitationProbabilityPct: 70, weatherCode: 61 },
      { discipline: 'road' }
    );
    assert.ok(r.score <= 2.5);
    assert.ok(r.ceilings.length > 0);
  });

  test('snow is harsher on the road than off it', () => {
    const snowy = { ...PERFECT, temperatureC: -2, weatherCode: 73 };
    const road = scoreConditions(snowy, { discipline: 'road' });
    const mtb = scoreConditions(snowy, { discipline: 'mtb' });
    assert.ok(road.score <= 2);
    assert.ok(mtb.score <= 3);
  });
});

describe('disciplines differ in more than a wind multiplier', () => {
  test('gravel suffers most in wind, MTB least', () => {
    const windy = { ...PERFECT, windKmh: 35 };
    const road = scoreConditions(windy, { discipline: 'road' }).score;
    const gravel = scoreConditions(windy, { discipline: 'gravel' }).score;
    const mtb = scoreConditions(windy, { discipline: 'mtb' }).score;
    assert.ok(gravel < road, 'gravel is more exposed than road');
    assert.ok(road < mtb, 'MTB is sheltered by terrain');
  });

  test('recent rain only affects the off-road disciplines', () => {
    const opts = { recentRainMm: 25 };
    const road = scoreConditions(PERFECT, { ...opts, discipline: 'road' });
    const gravel = scoreConditions(PERFECT, { ...opts, discipline: 'gravel' });
    const mtb = scoreConditions(PERFECT, { ...opts, discipline: 'mtb' });

    assert.equal(road.score, 10, 'tarmac drains; 25 mm two days ago is irrelevant');
    assert.ok(gravel.score < 10, 'gravel should carry a mud penalty');
    assert.ok(mtb.score < 10, 'trails should carry a mud penalty');
    assert.ok(gravel.breakdown.some(b => b.name === 'Surface / mud'));
  });

  test('every discipline has a complete profile', () => {
    for (const [key, p] of Object.entries(DISCIPLINES)) {
      assert.equal(p.key, key);
      assert.ok(p.label);
      assert.ok(typeof p.windWeight === 'number');
      for (const tier of ['excellent', 'good', 'fair', 'poor', 'skip']) {
        assert.ok(p.messages[tier], `${key} is missing a "${tier}" message`);
      }
    }
  });
});

describe('mudFactorFromRain', () => {
  test('scales the thresholds with the length of the memory window', () => {
    assert.equal(mudFactorFromRain(25, 48), 3);
    assert.equal(mudFactorFromRain(25, 72), 2); // 72 h needs proportionally more rain
    assert.equal(mudFactorFromRain(0, 48), 0);
    assert.equal(mudFactorFromRain(null, 48), null);
  });
});

describe('scoreTier (regression: badge and message disagreed)', () => {
  test('bands are contiguous and ordered', () => {
    assert.equal(scoreTier(10).key, 'excellent');
    assert.equal(scoreTier(8).key, 'excellent');
    assert.equal(scoreTier(7.9).key, 'good');
    assert.equal(scoreTier(6).key, 'good');
    assert.equal(scoreTier(5.9).key, 'fair');
    assert.equal(scoreTier(4).key, 'fair');
    assert.equal(scoreTier(3.9).key, 'poor');
    assert.equal(scoreTier(2.5).key, 'poor');
    assert.equal(scoreTier(2.4).key, 'skip');
    assert.equal(scoreTier(1).key, 'skip');
  });

  test('the message always comes from the same tier as the label', () => {
    // Sweep a range of conditions and confirm badge text and prose never diverge.
    for (let wind = 0; wind <= 60; wind += 5) {
      for (const temp of [-5, 2, 8, 18, 28, 33]) {
        const r = scoreConditions({ ...PERFECT, windKmh: wind, temperatureC: temp }, { discipline: 'road' });
        const expected = DISCIPLINES.road.messages[r.tier.key];
        assert.ok(
          r.message.includes(expected),
          `score ${r.score} labelled "${r.tier.label}" but said "${r.message}"`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Hourly planning
// ---------------------------------------------------------------------------

/** Build an hourly series relative to a fixed, on-the-hour base time. */
function buildHourly(base, specs) {
  return specs.map((spec, i) => ({
    time: new Date(base.getTime() + i * 3600 * 1000).toISOString(),
    temperature: 18,
    humidity: 50,
    windSpeed: 5,
    windDirection: 180,
    precipitation: 0,
    precipitationProbability: 0,
    visibility: 20000,
    uvIndex: 2,
    weatherCode: 0,
    ...spec
  }));
}

function onTheHour(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

describe('scoreHourlySeries', () => {
  test('scores each upcoming hour', () => {
    const base = onTheHour();
    const weather = { hourly: buildHourly(base, Array.from({ length: 12 }, () => ({}))) };
    const scored = scoreHourlySeries(weather, 'road', { now: base, hours: 12 });

    assert.ok(scored.length >= 12);
    assert.ok(scored.every(h => h.score >= 1 && h.score <= 10));
    assert.ok(scored[0].date instanceof Date);
  });

  test('reflects hour-by-hour differences', () => {
    const base = onTheHour();
    const weather = {
      hourly: buildHourly(base, [
        {}, {}, { windSpeed: 70, precipitationProbability: 100, precipitation: 8 }, {}
      ])
    };
    const scored = scoreHourlySeries(weather, 'road', { now: base, hours: 6 });
    assert.ok(scored[2].score < scored[0].score);
  });
});

describe('findBestWindow', () => {
  test('picks the good stretch out of a bad day', () => {
    const base = onTheHour();
    const bad = { windSpeed: 65, precipitationProbability: 100, precipitation: 6 };
    const specs = [bad, bad, bad, {}, {}, {}, bad, bad, bad, bad, bad, bad];
    const weather = { hourly: buildHourly(base, specs) };

    const scored = scoreHourlySeries(weather, 'road', { now: base, hours: 12 });
    const best = findBestWindow(scored, { now: base, withinHours: 12, minHours: 2, maxHours: 4 });

    assert.ok(best, 'expected a window to be found');
    assert.equal(best.hours, 3, 'the three good hours are the whole window');
    assert.equal(best.start.getHours(), new Date(base.getTime() + 3 * 3600 * 1000).getHours());
    assert.ok(best.score >= 8);
    assert.equal(best.tier.key, 'excellent');
  });

  test('respects daylight when sunrise/sunset are known', () => {
    const base = onTheHour();
    const weather = { hourly: buildHourly(base, Array.from({ length: 12 }, () => ({}))) };
    const scored = scoreHourlySeries(weather, 'road', { now: base, hours: 12 });

    // A daylight range that excludes everything must yield no window.
    const impossible = [{
      sunrise: new Date(base.getTime() + 100 * 3600 * 1000),
      sunset: new Date(base.getTime() + 101 * 3600 * 1000)
    }];
    assert.equal(findBestWindow(scored, { now: base, daylight: impossible }), null);

    // A generous range must yield one.
    const generous = [{
      sunrise: new Date(base.getTime() - 3600 * 1000),
      sunset: new Date(base.getTime() + 20 * 3600 * 1000)
    }];
    assert.ok(findBestWindow(scored, { now: base, daylight: generous }));
  });

  test('returns null when there is not enough data', () => {
    assert.equal(findBestWindow([], {}), null);
    assert.equal(findBestWindow(null, {}), null);
  });

  test('rejects a window whose average hides one terrible hour', () => {
    const base = onTheHour();
    const specs = [{}, {}, { windSpeed: 90, precipitation: 15, precipitationProbability: 100 }, {}];
    const weather = { hourly: buildHourly(base, specs) };
    const scored = scoreHourlySeries(weather, 'road', { now: base, hours: 6 });
    const best = findBestWindow(scored, { now: base, withinHours: 6, minHours: 2, maxHours: 4 });

    assert.ok(best);
    assert.ok(
      best.start.getTime() + best.hours * 3600 * 1000 <= base.getTime() + 2 * 3600 * 1000 ||
      best.start.getTime() >= base.getTime() + 3 * 3600 * 1000,
      'the window must not straddle the unrideable hour'
    );
  });
});

describe('findRainTiming', () => {
  test('reports when rain starts on a dry day', () => {
    const base = onTheHour();
    const hourly = buildHourly(base, [
      {}, {}, {}, { precipitationProbability: 90, precipitation: 2 }, {}
    ]);
    const timing = findRainTiming(hourly, { now: base, hours: 12 });
    assert.equal(timing.state, 'dry');
    assert.equal(timing.startsAt.getTime(), base.getTime() + 3 * 3600 * 1000);
  });

  test('reports when rain clears if it is already wet', () => {
    const base = onTheHour();
    const wet = { precipitationProbability: 95, precipitation: 3 };
    const hourly = buildHourly(base, [wet, wet, {}, {}]);
    const timing = findRainTiming(hourly, { now: base, hours: 12 });
    assert.equal(timing.state, 'wet');
    assert.equal(timing.clearsAt.getTime(), base.getTime() + 2 * 3600 * 1000);
  });

  test('reports a fully dry outlook', () => {
    const base = onTheHour();
    const timing = findRainTiming(buildHourly(base, [{}, {}, {}]), { now: base, hours: 12 });
    assert.equal(timing.state, 'dry');
    assert.equal(timing.startsAt, null);
  });
});

describe('recentPrecipSum', () => {
  test('totals only the requested window', () => {
    const base = onTheHour();
    const hourly = [-5, -4, -3, -2, -1, 0].map(offset => ({
      time: new Date(base.getTime() + offset * 3600 * 1000).toISOString(),
      precipitation: 1
    }));
    assert.equal(recentPrecipSum(hourly, 3, base), 4); // hours -3, -2, -1, 0
    assert.equal(recentPrecipSum(hourly, 5, base), 6);
  });

  test('returns null when no data covers the window', () => {
    assert.equal(recentPrecipSum([], 48), null);
    assert.equal(recentPrecipSum(null, 48), null);
  });
});

// ---------------------------------------------------------------------------
// Alerts and recommendations
// ---------------------------------------------------------------------------

describe('generateSafetyAlerts', () => {
  test('flags a large gust spread separately from mean wind', () => {
    const alerts = generateSafetyAlerts({ current: { windSpeed: 20, windGusts: 55 } });
    assert.ok(alerts.some(a => /Gusting/i.test(a.message)));
  });

  test('flags freezing temperatures as high severity', () => {
    const alerts = generateSafetyAlerts({ current: { temperature: -2 } });
    const cold = alerts.find(a => a.type === 'cold');
    assert.equal(cold.severity, 'high');
  });

  test('flags poor air quality', () => {
    const alerts = generateSafetyAlerts({ current: {}, airQuality: { aqi: 160 } });
    assert.ok(alerts.some(a => a.type === 'air' && a.severity === 'high'));
  });

  test('stays quiet on a benign day', () => {
    const alerts = generateSafetyAlerts({
      current: { windSpeed: 8, windGusts: 10, temperature: 18, visibility: 20000, precipitation: 0, precipitationProbability: 5, uvIndex: 3, weatherCode: 0 }
    });
    assert.equal(alerts.length, 0);
  });

  test('does not invent alerts from missing data', () => {
    const alerts = generateSafetyAlerts({ current: {} });
    assert.equal(alerts.length, 0, 'an empty forecast must not produce a freezing-temperature warning');
  });
});

describe('generateRecommendations', () => {
  test('advises layers when it is cold and hydration when it is hot', () => {
    const cold = generateRecommendations({ current: { temperature: 3, windSpeed: 5, uvIndex: 1 } });
    assert.ok(cold.some(r => /thermal|Layer/i.test(r.text)));

    const hot = generateRecommendations({ current: { temperature: 33, windSpeed: 5, uvIndex: 9 } });
    assert.ok(hot.some(r => /fluids|bottle/i.test(r.text)));
  });

  test('gives MTB-specific trail advice in the wet', () => {
    const recs = generateRecommendations(
      { current: { temperature: 12, windSpeed: 5, precipitation: 2, precipitationProbability: 90, uvIndex: 2 } },
      'mtb'
    );
    assert.ok(recs.some(r => /trail/i.test(r.text)));
  });
});
