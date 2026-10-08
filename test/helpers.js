/*
  Shared test helpers.
*/

const SYSTEM_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Run `fn` with the process in `timeZone`, as if the viewer's device were there.
 *
 * The timezone bug only exists when the viewer's zone differs from the forecast
 * location's, and CI runs in UTC — so a test that just runs "normally" can pass
 * while the app is wrong for everyone else. Node re-reads TZ on assignment.
 */
export function inZone(timeZone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    process.env.TZ = previous ?? SYSTEM_ZONE;
  }
}

/** `inZone` for async work: the zone holds until `fn`'s promise settles, not just until it returns one. */
export async function inZoneAsync(timeZone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return await fn();
  } finally {
    process.env.TZ = previous ?? SYSTEM_ZONE;
  }
}

/** Viewer zones spread around the world, including both sides of Tel Aviv. */
export const VIEWER_ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Jerusalem'];

/** A promise you can settle from outside — for driving responses out of order. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const HOUR_MS = 3600 * 1000;

/**
 * A MET Norway Locationforecast "complete" response, shaped like the real one:
 * `hourly` one-hour steps, then `sixHourly` six-hour steps, then a last step
 * that only has `next_12_hours`, as the real tail does.
 *
 * The one-hour steps also carry a `next_6_hours` block with absurd values, as
 * real ones carry an overlapping block: anything that reads it while hourly
 * data exists is double counting, and the numbers make that obvious.
 * `nordic` adds the fields MET only publishes in the Nordic area.
 */
export function metFixture({ start = '2026-09-11T03:00:00Z', hourly = 62, sixHourly = 22, nordic = false } = {}) {
  const t0 = Date.parse(start);
  const instant = {
    air_temperature: 20,
    apparent_air_temperature: 19,
    relative_humidity: 60,
    cloud_area_fraction: 10,
    wind_speed: 5,
    wind_from_direction: 270,
    ultraviolet_index_clear_sky: 3,
    ...(nordic ? { wind_speed_of_gust: 10 } : {})
  };
  const step = (ms, blocks) => ({ time: new Date(ms).toISOString().replace('.000', ''), data: { instant: { details: instant }, ...blocks } });

  const timeseries = [];
  for (let i = 0; i < hourly; i++) {
    timeseries.push(step(t0 + i * HOUR_MS, {
      next_1_hours: {
        summary: { symbol_code: 'clearsky_day' },
        details: { precipitation_amount: 0.5, ...(nordic ? { probability_of_precipitation: 40 } : {}) }
      },
      next_6_hours: {
        summary: { symbol_code: 'heavyrainandthunder' },
        details: { precipitation_amount: 99, air_temperature_max: 99, air_temperature_min: -99 }
      }
    }));
  }
  const sixStart = t0 + hourly * HOUR_MS;
  for (let j = 0; j < sixHourly; j++) {
    timeseries.push(step(sixStart + j * 6 * HOUR_MS, {
      next_6_hours: {
        summary: { symbol_code: 'lightrain' },
        details: { precipitation_amount: 6, air_temperature_max: 25, air_temperature_min: 15 }
      }
    }));
  }
  timeseries.push(step(sixStart + sixHourly * 6 * HOUR_MS, { next_12_hours: { summary: { symbol_code: 'cloudy' } } }));

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [34.78, 32.08, 16] },
    properties: { meta: { updated_at: start, units: {} }, timeseries }
  };
}
