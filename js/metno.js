/*
  Weather 4 Bike – Backup forecast (MET Norway)

  Goal: Keep the app answering "should I ride?" when Open‑Meteo is unavailable.

  Why: Open‑Meteo's free tier is rate-limited per IP address, and riders behind
  a shared address (an office, a VPN, a mobile carrier) can hit that limit
  without doing anything wrong. MET Norway's Locationforecast is free, global,
  needs no key, and accepts simple cross-origin requests from a browser — the
  only other provider that fits a static page with no server.

  How: Translate a Locationforecast "complete" response into the shape of an
  Open‑Meteo response requested with `timeformat=unixtime`, so the cache, the
  parser and the scorer in js/weather.js work on it unchanged. What MET does
  not publish stays absent, and so `null` downstream — never 0:
  - no visibility, soil moisture or past days;
  - gusts and chance of rain only in the Nordic area;
  - hourly steps for about 2.5 days, then 6-hourly. Only the hourly part becomes
    hourly rows; the 6-hourly part still feeds the daily summary. Inventing
    hours between 6-hour steps would hand the best-window search fake detail.
  - UV is the clear-sky index, an upper bound on cloudy days.
  - no time zone and no sunrise/sunset: the caller supplies the zone, and the
    sun times are computed here.

  Pure and DOM-free, like js/insights.js.
*/

import { localDateKey } from './time.js';

export const MET_FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

// Marks a shaped response, so the UI can say the forecast came from the backup.
export const MET_SOURCE = 'met.no';

const MS_TO_KMH = 3.6;

/** MET's terms: at most 4 decimals, or newer endpoints answer 403. */
export function metForecastUrl(latitude, longitude) {
  const trunc = v => Math.trunc(Number(v) * 1e4) / 1e4;
  return `${MET_FORECAST_URL}?lat=${trunc(latitude)}&lon=${trunc(longitude)}`;
}

/**
 * Goal: Map a MET symbol code ("lightrainshowers_day") to a WMO weather code.
 * Why: Icons, labels and the scorer all speak WMO codes, as Open‑Meteo does.
 * How: Drop the _day/_night/_polartwilight suffix, then match by name. Anything
 *      with thunder is checked first, which also covers MET's long-standing
 *      "lightssleet…"/"lightssnow…" misspellings of the thunder variants.
 *      Sleet has no WMO code the app knows, so it reads as snow: equally
 *      slippery, and it gets the cold-and-wet warning.
 */
export function symbolToWeatherCode(symbol) {
  if (typeof symbol !== 'string' || !symbol) return null;
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (s.includes('thunder')) return 95;

  const table = {
    clearsky: 0,
    fair: 1,
    partlycloudy: 2,
    cloudy: 3,
    fog: 45,
    lightrain: 61,
    rain: 63,
    heavyrain: 65,
    lightrainshowers: 80,
    rainshowers: 81,
    heavyrainshowers: 82,
    lightsnow: 71,
    snow: 73,
    heavysnow: 75,
    lightsleet: 71,
    sleet: 73,
    heavysleet: 75,
    lightsnowshowers: 85,
    snowshowers: 85,
    heavysnowshowers: 86,
    lightsleetshowers: 85,
    sleetshowers: 85,
    heavysleetshowers: 86
  };
  return table[s] ?? null;
}

const RAD = Math.PI / 180;
const J2000 = 2451545.0;
const UNIX_EPOCH_JD = 2440587.5;

/**
 * Goal: Sunrise and sunset for a calendar date at a place, as Unix seconds.
 * Why: Daylight bounds the best-window search, and MET does not publish it.
 *      Computing it costs nothing; asking another API costs a request per day.
 * How: The standard sunrise equation (solar transit ± the hour angle at which
 *      the sun's centre sits 0.833° below the horizon). Good to a minute or two,
 *      which is far finer than an hourly forecast.
 *
 * @param {string} dateKey - "YYYY-MM-DD", the location's calendar date
 * @returns {{sunrise: number, sunset: number}|null} null in polar day or night
 */
export function sunTimes(dateKey, latitude, longitude) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (!y || !m || !d) return null;

  const jdMidnight = Date.UTC(y, m - 1, d) / 86400000 + UNIX_EPOCH_JD;
  const n = Math.ceil(jdMidnight - J2000 + 0.0008);
  const meanNoon = n - longitude / 360;
  const anomaly = (357.5291 + 0.98560028 * meanNoon) % 360;
  const mRad = anomaly * RAD;
  const centre = 1.9148 * Math.sin(mRad) + 0.02 * Math.sin(2 * mRad) + 0.0003 * Math.sin(3 * mRad);
  const eclipticLong = ((anomaly + centre + 180 + 102.9372) % 360) * RAD;
  const transit = J2000 + meanNoon + 0.0053 * Math.sin(mRad) - 0.0069 * Math.sin(2 * eclipticLong);

  const sinDecl = Math.sin(eclipticLong) * Math.sin(23.4397 * RAD);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const lat = latitude * RAD;
  const cosHour = (Math.sin(-0.833 * RAD) - Math.sin(lat) * sinDecl) / (Math.cos(lat) * cosDecl);
  if (cosHour < -1 || cosHour > 1) return null;

  const halfDay = Math.acos(cosHour) / RAD / 360;
  const toUnix = jd => Math.round((jd - UNIX_EPOCH_JD) * 86400);
  return { sunrise: toUnix(transit - halfDay), sunset: toUnix(transit + halfDay) };
}

/**
 * Goal: A reasonable time zone for a place when nothing better is known.
 * Why: MET answers in UTC only, and every "today" and every clock in the app is
 *      read in the location's zone.
 * How: Longitude gives the solar offset. If the viewer's own zone is within
 *      two hours of it, the rider is most likely looking at where they are, and
 *      their zone gets daylight saving and political borders right. Otherwise
 *      a fixed-offset zone (note the POSIX sign: Etc/GMT-3 is UTC+3).
 */
export function guessTimeZone(longitude, now = new Date()) {
  const solarH = Math.max(-12, Math.min(12, Math.round(Number(longitude) / 15)));
  try {
    const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const viewerH = -now.getTimezoneOffset() / 60;
    if (viewer && Math.abs(viewerH - solarH) <= 2) return viewer;
  } catch {
    // fall through to the fixed offset
  }
  if (solarH === 0) return 'UTC';
  return `Etc/GMT${solarH > 0 ? '-' : '+'}${Math.abs(solarH)}`;
}

const toSeconds = iso => Math.round(Date.parse(iso) / 1000);
const kmh = v => (typeof v === 'number' ? Math.round(v * MS_TO_KMH * 10) / 10 : null);
const val = v => (typeof v === 'number' ? v : null);
const maxOf = values => {
  const known = values.filter(v => typeof v === 'number');
  return known.length ? Math.max(...known) : null;
};
const minOf = values => {
  const known = values.filter(v => typeof v === 'number');
  return known.length ? Math.min(...known) : null;
};

// A day is listed only if the forecast covers most of it. The first day is the
// exception: it starts now, and today must always be there.
const MIN_DAY_COVERAGE_H = 18;

/**
 * Goal: Shape a Locationforecast response like an Open‑Meteo one.
 * How: Hourly rows from steps that carry `next_1_hours`. Daily rows from every
 *      step, grouped by the location's calendar date, each step contributing
 *      the period it describes (1 h while hourly, 6 h after) so rainfall is
 *      summed once. The daily weather code is the most severe of the day,
 *      which is what Open‑Meteo reports too.
 *
 * @param {object} data - raw Locationforecast 2.0 "complete" JSON
 * @param {{timeZone: string, latitude: number, longitude: number}} where
 */
export function metToOpenMeteo(data, { timeZone, latitude, longitude }) {
  const steps = Array.isArray(data?.properties?.timeseries) ? data.properties.timeseries : [];

  const hourly = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    relativehumidity_2m: [],
    precipitation_probability: [],
    precipitation: [],
    weathercode: [],
    cloudcover: [],
    windspeed_10m: [],
    winddirection_10m: [],
    windgusts_10m: [],
    uv_index: []
  };

  const days = new Map();

  for (const step of steps) {
    const seconds = toSeconds(step?.time);
    if (!Number.isFinite(seconds)) continue;
    const now = step.data?.instant?.details || {};
    const oneHour = step.data?.next_1_hours;
    const sixHours = step.data?.next_6_hours;
    const period = oneHour || sixHours;
    const periodH = oneHour ? 1 : sixHours ? 6 : 0;
    const code = symbolToWeatherCode(period?.summary?.symbol_code);

    if (oneHour) {
      hourly.time.push(seconds);
      hourly.temperature_2m.push(val(now.air_temperature));
      hourly.apparent_temperature.push(val(now.apparent_air_temperature));
      hourly.relativehumidity_2m.push(val(now.relative_humidity));
      hourly.precipitation_probability.push(val(oneHour.details?.probability_of_precipitation));
      hourly.precipitation.push(val(oneHour.details?.precipitation_amount));
      hourly.weathercode.push(code);
      hourly.cloudcover.push(val(now.cloud_area_fraction));
      hourly.windspeed_10m.push(kmh(now.wind_speed));
      hourly.winddirection_10m.push(val(now.wind_from_direction));
      hourly.windgusts_10m.push(kmh(now.wind_speed_of_gust));
      hourly.uv_index.push(val(now.ultraviolet_index_clear_sky));
    }

    const key = localDateKey(new Date(seconds * 1000), timeZone);
    if (!days.has(key)) days.set(key, { first: seconds, coverageH: 0, temps: [], precip: [], prob: [], codes: [], wind: [] });
    const day = days.get(key);
    day.coverageH += periodH;
    day.temps.push(now.air_temperature, sixHours && !oneHour ? sixHours.details?.air_temperature_max : null,
      sixHours && !oneHour ? sixHours.details?.air_temperature_min : null);
    day.precip.push(period?.details?.precipitation_amount);
    day.prob.push(period?.details?.probability_of_precipitation);
    day.codes.push(code);
    day.wind.push(kmh(now.wind_speed));
  }

  const daily = {
    time: [],
    weathercode: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_probability_max: [],
    precipitation_sum: [],
    windspeed_10m_max: [],
    sunrise: [],
    sunset: []
  };

  [...days.entries()].forEach(([key, day], i) => {
    if (i > 0 && day.coverageH < MIN_DAY_COVERAGE_H) return;
    const sun = sunTimes(key, latitude, longitude);
    const precip = day.precip.filter(v => typeof v === 'number');
    daily.time.push(day.first);
    daily.weathercode.push(maxOf(day.codes));
    daily.temperature_2m_max.push(maxOf(day.temps));
    daily.temperature_2m_min.push(minOf(day.temps));
    daily.precipitation_probability_max.push(maxOf(day.prob));
    daily.precipitation_sum.push(precip.length ? Math.round(precip.reduce((a, b) => a + b, 0) * 10) / 10 : null);
    daily.windspeed_10m_max.push(maxOf(day.wind));
    daily.sunrise.push(sun ? sun.sunrise : null);
    daily.sunset.push(sun ? sun.sunset : null);
  });

  return { latitude, longitude, timezone: timeZone, hourly, daily, w4bSource: MET_SOURCE };
}
