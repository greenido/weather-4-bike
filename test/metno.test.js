import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { metToOpenMeteo, symbolToWeatherCode, sunTimes, guessTimeZone, metForecastUrl } from '../js/metno.js';
import { parseWeatherResponse, formatWeatherData, getDaylightRanges } from '../js/weather.js';
import { scoreHourlySeries } from '../js/insights.js';
import { inZone, metFixture } from './helpers.js';

const TLV = 'Asia/Jerusalem';
const WHERE = { timeZone: TLV, latitude: 32.08, longitude: 34.78 };
// 06:20 on Fri 11 Sep in Tel Aviv: inside the fixture's first hourly step range.
const NOW = new Date('2026-09-11T03:20:00Z');

describe('metForecastUrl', () => {
  test('truncates to 4 decimals, as MET requires', () => {
    assert.equal(
      metForecastUrl(32.123456, -122.419999),
      'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=32.1234&lon=-122.4199'
    );
  });
});

describe('symbolToWeatherCode', () => {
  test('maps sky states, ignoring day/night', () => {
    assert.equal(symbolToWeatherCode('clearsky_day'), 0);
    assert.equal(symbolToWeatherCode('fair_night'), 1);
    assert.equal(symbolToWeatherCode('partlycloudy_polartwilight'), 2);
    assert.equal(symbolToWeatherCode('cloudy'), 3);
    assert.equal(symbolToWeatherCode('fog'), 45);
  });

  test('maps rain, showers and snow by intensity', () => {
    assert.equal(symbolToWeatherCode('lightrain'), 61);
    assert.equal(symbolToWeatherCode('heavyrain'), 65);
    assert.equal(symbolToWeatherCode('rainshowers_day'), 81);
    assert.equal(symbolToWeatherCode('heavysnowshowers_night'), 86);
    assert.equal(symbolToWeatherCode('sleet'), 73);
  });

  test('anything with thunder is a thunderstorm, MET’s misspellings included', () => {
    assert.equal(symbolToWeatherCode('rainandthunder'), 95);
    assert.equal(symbolToWeatherCode('lightssleetshowersandthunder_day'), 95);
    assert.equal(symbolToWeatherCode('lightssnowshowersandthunder_night'), 95);
  });

  test('unknown or missing → null, not "clear sky"', () => {
    assert.equal(symbolToWeatherCode('meteorshower'), null);
    assert.equal(symbolToWeatherCode(undefined), null);
  });
});

describe('sunTimes', () => {
  // Reference: Open-Meteo daily sunrise/sunset for 2026-10-08.
  const cases = [
    ['Tel Aviv', 32.08, 34.78, 1791430747, 1791472613],
    ['Oslo', 59.91, 10.75, 1791437936, 1791476939],
    ['San Francisco', 37.77, -122.42, 1791468701, 1791510115],
    ['Sydney', -33.87, 151.21, 1791401006, 1791446570]
  ];
  for (const [name, lat, lon, rise, set] of cases) {
    test(`${name} is within 3 minutes of the reference`, () => {
      const sun = sunTimes('2026-10-08', lat, lon);
      assert.ok(Math.abs(sun.sunrise - rise) <= 180, `sunrise off by ${sun.sunrise - rise} s`);
      assert.ok(Math.abs(sun.sunset - set) <= 180, `sunset off by ${sun.sunset - set} s`);
    });
  }

  test('polar night and midnight sun have no sunrise', () => {
    assert.equal(sunTimes('2026-12-20', 69.65, 18.96), null);
    assert.equal(sunTimes('2026-06-21', 69.65, 18.96), null);
  });
});

describe('guessTimeZone', () => {
  const at = new Date('2026-09-11T12:00:00Z');

  test('a place near the viewer gets the viewer’s real zone', () => {
    inZone(TLV, () => assert.equal(guessTimeZone(34.78, at), TLV));
  });

  test('a faraway place gets a fixed solar offset, with the POSIX sign', () => {
    inZone('America/Los_Angeles', () => {
      assert.equal(guessTimeZone(34.78, at), 'Etc/GMT-2');
      assert.equal(guessTimeZone(0, at), 'UTC');
    });
    inZone('Asia/Tokyo', () => assert.equal(guessTimeZone(-150, at), 'Etc/GMT+10'));
  });
});

describe('metToOpenMeteo — hourly', () => {
  const shaped = metToOpenMeteo(metFixture(), WHERE);

  test('one row per one-hour step; six-hour steps are not stretched into fake hours', () => {
    assert.equal(shaped.hourly.time.length, 62);
    assert.equal(shaped.hourly.time[0], Date.parse('2026-09-11T03:00:00Z') / 1000);
  });

  test('wind is converted from m/s to km/h', () => {
    assert.equal(shaped.hourly.windspeed_10m[0], 18);
  });

  test('values come from the one-hour block, not the overlapping six-hour one', () => {
    assert.equal(shaped.hourly.precipitation[0], 0.5);
    assert.equal(shaped.hourly.weathercode[0], 0);
  });

  test('what MET does not publish outside the Nordics is null, never 0', () => {
    assert.equal(shaped.hourly.windgusts_10m[0], null);
    assert.equal(shaped.hourly.precipitation_probability[0], null);
    assert.equal(shaped.hourly.visibility, undefined);
  });

  test('Nordic extras come through when present', () => {
    const nordic = metToOpenMeteo(metFixture({ nordic: true }), WHERE);
    assert.equal(nordic.hourly.windgusts_10m[0], 36);
    assert.equal(nordic.hourly.precipitation_probability[0], 40);
  });

  test('is marked as the backup and carries the zone it was given', () => {
    assert.equal(shaped.w4bSource, 'met.no');
    assert.equal(shaped.timezone, TLV);
  });
});

describe('metToOpenMeteo — daily', () => {
  const w = parseWeatherResponse(metToOpenMeteo(metFixture(), WHERE), NOW);
  const day = date => w.daily.find(d => d.date === date);

  test('days are the location’s calendar dates; a mostly-uncovered last day is dropped', () => {
    assert.deepEqual(w.daily.map(d => d.date), [
      '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14',
      '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'
    ]);
  });

  test('rain is summed once: hourly blocks while hourly, six-hour blocks after', () => {
    assert.equal(day('2026-09-11').precipitationSum, 9);   // 18 h × 0.5
    assert.equal(day('2026-09-12').precipitationSum, 12);  // 24 h × 0.5
    assert.equal(day('2026-09-13').precipitationSum, 16);  // 20 h × 0.5 + one 6 h block
    assert.equal(day('2026-09-14').precipitationSum, 24);  // four 6 h blocks
  });

  test('six-hour extremes count only where there is no hourly data', () => {
    assert.equal(day('2026-09-11').temperatureMax, 20);
    assert.equal(day('2026-09-11').temperatureMin, 20);
    assert.equal(day('2026-09-13').temperatureMax, 25);
    assert.equal(day('2026-09-13').temperatureMin, 15);
  });

  test('the daily code is the day’s most severe', () => {
    assert.equal(day('2026-09-11').weatherCode, 0);
    assert.equal(day('2026-09-13').weatherCode, 61);
  });

  test('sunrise and sunset are computed for each day', () => {
    const today = day('2026-09-11');
    assert.equal(today.sunrise.slice(0, 13), '2026-09-11T03');  // ~06:2x local
    assert.equal(today.sunset.slice(0, 13), '2026-09-11T15');   // ~18:5x local
  });
});

describe('a MET forecast through the rest of the app', () => {
  test('parses, formats and scores like an Open-Meteo one', () => {
    inZone('America/Los_Angeles', () => {
      const w = formatWeatherData(parseWeatherResponse(metToOpenMeteo(metFixture(), WHERE), NOW), NOW);
      assert.equal(w.current.time, '2026-09-11T03:00:00.000Z');
      assert.equal(w.current.weatherText, 'Clear sky');
      assert.equal(w.today.date, '2026-09-11');
      assert.equal(getDaylightRanges(w).length, 7);
      const scored = scoreHourlySeries(w, 'gravel', { now: NOW, hours: 24 });
      assert.equal(scored.length, 25, 'the hour we are inside, plus 24');
    });
  });

  test('with no past days, the surface is unknown rather than "dry"', () => {
    const w = formatWeatherData(parseWeatherResponse(metToOpenMeteo(metFixture(), WHERE), NOW), NOW);
    const [first] = scoreHourlySeries(w, 'mtb', { now: NOW, hours: 2 });
    assert.equal(first.surface, null);
    assert.ok(first.unknown.includes('Surface'));
  });
});
