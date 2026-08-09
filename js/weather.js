/*
  Weather 4 Bike – Weather Data Provider (Open‑Meteo)

  Goal: Fetch forecast + air quality and shape them into a UI-friendly structure
  with current, hourly, and daily slices plus useful derived values.

  Why: Separating data access from UI keeps rendering simple and makes the data
  source swappable.

  How:
  - Call Open‑Meteo with a full variable set, degrading to a reduced set only if
    the API rejects it. Missing variables stay `null` — never 0 — so the scorer
    can tell "unknown" from "zero".
  - Cache responses in sessionStorage with a short TTL so a reload or a units
    toggle does not re-hit the network.
  - Air quality is fetched best-effort and never blocks the forecast.
*/

const DEBUG = (() => {
  try {
    return typeof location !== 'undefined' && /[?&]debug=1/.test(location.search);
  } catch {
    return false;
  }
})();

const log = {
  info: (...a) => { if (DEBUG) console.info(...a); },
  warn: (...a) => { if (DEBUG) console.warn(...a); },
  error: (...a) => console.error(...a) // real failures always surface
};

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const HOURLY_PARAMS = [
  'temperature_2m',
  'apparent_temperature',
  'relativehumidity_2m',
  'precipitation_probability',
  'precipitation',
  'weathercode',
  'surface_pressure',
  'cloudcover',
  'visibility',
  'windspeed_10m',
  'winddirection_10m',
  'windgusts_10m',
  'uv_index',
  // Surface condition for gravel/MTB. Volumetric water content of the top layer
  // is a far better mud signal than summing rainfall, because the model has
  // already accounted for drying via sun, wind and evapotranspiration.
  'soil_moisture_0_to_1cm',
  'soil_moisture_1_to_3cm',
  'et0_fao_evapotranspiration'
].join(',');

// Fallback set: only variables Open‑Meteo has supported on every model.
const HOURLY_PARAMS_FALLBACK = [
  'temperature_2m',
  'relativehumidity_2m',
  'precipitation_probability',
  'precipitation',
  'weathercode',
  'cloudcover',
  'windspeed_10m',
  'winddirection_10m'
].join(',');

const DAILY_PARAMS = [
  'weathercode',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_probability_max',
  'precipitation_sum',
  'windspeed_10m_max',
  'windgusts_10m_max',
  'uv_index_max',
  'sunrise',
  'sunset'
].join(',');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// Bump when the requested variable set changes, so cached responses from an
// older shape are not reused without the new fields.
const CACHE_PREFIX = 'w4b:cache:v3:';
const FORECAST_TTL_MS = 10 * 60 * 1000;
const AIR_TTL_MS = 30 * 60 * 1000;

function cacheKey(kind, latitude, longitude) {
  // ~100 m precision is far finer than a weather model cell, and keeps the key stable
  // across the tiny jitter that geolocation returns between calls.
  return `${CACHE_PREFIX}${kind}:${Number(latitude).toFixed(3)},${Number(longitude).toFixed(3)}`;
}

function readCache(key, ttlMs) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.at !== 'number') return null;
    if (Date.now() - entry.at > ttlMs) {
      sessionStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota or private mode — caching is an optimisation, not a requirement.
  }
}

/** Clear cached responses (used by the manual refresh button). */
export function clearWeatherCache() {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => sessionStorage.removeItem(k));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Goal: Fetch a 7‑day forecast for coordinates and return a normalized object.
 * Why: The UI expects consistent shapes and derived text across views.
 * How: Serve from cache when fresh, otherwise try the full hourly variable set
 *      and fall back to a reduced one, then parse and format.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {{force?: boolean}} options - `force` bypasses the cache.
 */
export async function fetchWeatherData(latitude, longitude, options = {}) {
  const key = cacheKey('forecast', latitude, longitude);
  if (!options.force) {
    const cached = readCache(key, FORECAST_TTL_MS);
    if (cached) {
      log.info('[weather] cache hit', key);
      // Re-parse so "nearest hour" and the daily filter track the current clock.
      return formatWeatherData(parseWeatherResponse(cached));
    }
  }

  const buildUrl = hourly =>
    `${FORECAST_URL}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
    `&hourly=${hourly}&daily=${DAILY_PARAMS}&timezone=auto&forecast_days=7&past_days=3`;

  let lastError;
  for (const hourly of [HOURLY_PARAMS, HOURLY_PARAMS_FALLBACK]) {
    try {
      log.info('[weather] requesting hourly set', hourly);
      const response = await fetch(buildUrl(hourly));
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new Error(`Weather API error ${response.status}: ${body}`);
      }
      const data = await response.json();
      writeCache(key, data);
      return formatWeatherData(parseWeatherResponse(data));
    } catch (e) {
      log.warn('[weather] hourly set failed, trying next', e);
      lastError = e;
    }
  }
  throw lastError || new Error('Weather API error');
}

/**
 * Goal: Fetch current air quality, best effort.
 * Why: Riders breathe hard for hours; AQI belongs next to wind and temperature.
 * How: Separate Open‑Meteo endpoint; any failure resolves to `null` so a bad
 *      air-quality response can never take the forecast down with it.
 */
export async function fetchAirQuality(latitude, longitude, options = {}) {
  const key = cacheKey('air', latitude, longitude);
  if (!options.force) {
    const cached = readCache(key, AIR_TTL_MS);
    if (cached) return parseAirQuality(cached);
  }

  try {
    const url =
      `${AIR_QUALITY_URL}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
      `&hourly=pm2_5,pm10,us_aqi,european_aqi&timezone=auto&forecast_days=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Air quality API error ${response.status}`);
    const data = await response.json();
    writeCache(key, data);
    return parseAirQuality(data);
  } catch (e) {
    log.warn('[weather] air quality unavailable', e);
    return null;
  }
}

function parseAirQuality(data) {
  const times = data?.hourly?.time || [];
  if (!times.length) return null;
  const idx = findNearestHourIndex(times, new Date());
  const aqi = getSafe(data.hourly?.us_aqi, idx) ?? getSafe(data.hourly?.european_aqi, idx);
  if (aqi === null) return null;
  return {
    aqi,
    scale: data.hourly?.us_aqi ? 'US AQI' : 'EU AQI',
    pm25: getSafe(data.hourly?.pm2_5, idx),
    pm10: getSafe(data.hourly?.pm10, idx),
    category: aqiCategory(aqi)
  };
}

/** Standard US AQI bands, used for the colour and the wording. */
export function aqiCategory(aqi) {
  const v = Number(aqi);
  if (!Number.isFinite(v)) return { label: 'Unknown', tone: 'gray' };
  if (v <= 50) return { label: 'Good', tone: 'green' };
  if (v <= 100) return { label: 'Moderate', tone: 'yellow' };
  if (v <= 150) return { label: 'Unhealthy for sensitive groups', tone: 'orange' };
  if (v <= 200) return { label: 'Unhealthy', tone: 'red' };
  return { label: 'Very unhealthy', tone: 'red' };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Goal: Transform raw Open‑Meteo JSON into structured current/hourly/daily arrays.
 * Why: Downstream code needs aligned indices and easy access to the nearest hour.
 * How: Locate the hour closest to now, assemble null-safe objects, and precompute
 *      `next24FromNearest` for the hourly view.
 */
export function parseWeatherResponse(data) {
  const now = new Date();
  const times = data.hourly?.time || [];
  const nearestIndex = findNearestHourIndex(times, now);

  const hourly = times.map((iso, idx) => ({
    time: iso,
    temperature: getSafe(data.hourly?.temperature_2m, idx),
    apparentTemperature: getSafe(data.hourly?.apparent_temperature, idx),
    humidity: getSafe(data.hourly?.relativehumidity_2m, idx),
    precipitation: getSafe(data.hourly?.precipitation, idx),
    precipitationProbability: getSafe(data.hourly?.precipitation_probability, idx),
    weatherCode: getSafe(data.hourly?.weathercode, idx),
    windSpeed: getSafe(data.hourly?.windspeed_10m, idx),
    windDirection: getSafe(data.hourly?.winddirection_10m, idx),
    windGusts: getSafe(data.hourly?.windgusts_10m, idx),
    visibility: getSafe(data.hourly?.visibility, idx),
    cloudCover: getSafe(data.hourly?.cloudcover, idx),
    uvIndex: getSafe(data.hourly?.uv_index, idx),
    pressure: getSafe(data.hourly?.surface_pressure, idx),
    // Prefer the very top layer — that is what tyres touch. Fall back to the
    // next band down, which some models publish when the shallowest is absent.
    soilMoisture: getSafe(data.hourly?.soil_moisture_0_to_1cm, idx)
      ?? getSafe(data.hourly?.soil_moisture_1_to_3cm, idx),
    evapotranspiration: getSafe(data.hourly?.et0_fao_evapotranspiration, idx)
  }));

  const current = hourly[nearestIndex] ? { ...hourly[nearestIndex] } : emptyCurrent();

  const daily = (data.daily?.time || []).map((iso, idx) => ({
    date: iso,
    temperatureMax: getSafe(data.daily?.temperature_2m_max, idx),
    temperatureMin: getSafe(data.daily?.temperature_2m_min, idx),
    apparentMax: getSafe(data.daily?.apparent_temperature_max, idx),
    apparentMin: getSafe(data.daily?.apparent_temperature_min, idx),
    precipitationProbabilityMax: getSafe(data.daily?.precipitation_probability_max, idx),
    precipitationSum: getSafe(data.daily?.precipitation_sum, idx),
    weatherCode: getSafe(data.daily?.weathercode, idx),
    windSpeedMax: getSafe(data.daily?.windspeed_10m_max, idx),
    windGustsMax: getSafe(data.daily?.windgusts_10m_max, idx),
    uvIndexMax: getSafe(data.daily?.uv_index_max, idx),
    sunrise: getSafe(data.daily?.sunrise, idx),
    sunset: getSafe(data.daily?.sunset, idx)
  }));

  const next24FromNearest = hourly.slice(nearestIndex, nearestIndex + 24);

  return {
    current,
    hourly,
    daily,
    nearestIndex,
    next24FromNearest,
    timezone: data.timezone || null
  };
}

function emptyCurrent() {
  return {
    time: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    precipitationProbability: null,
    weatherCode: null,
    windSpeed: null,
    windDirection: null,
    windGusts: null,
    visibility: null,
    cloudCover: null,
    uvIndex: null,
    pressure: null,
    soilMoisture: null,
    evapotranspiration: null
  };
}

/**
 * Goal: Add human text for weather codes and trim daily data to today onward.
 * Why: Readability, and the 7‑day view must not show days already gone.
 * How: Map codes to text everywhere, filter daily by local date, keep 7 entries.
 *      `past_days` data stays in `hourly` — the mud/surface factor needs it.
 */
export function formatWeatherData(raw) {
  const now = new Date();
  const todayStr = toLocalDateString(now);

  const next7Daily = Array.isArray(raw.daily)
    ? raw.daily.filter(d => String(d.date) >= todayStr).slice(0, 7)
    : [];

  return {
    ...raw,
    current: {
      ...raw.current,
      weatherText: mapWeatherCodeToText(raw.current.weatherCode)
    },
    hourly: raw.hourly.map(h => ({ ...h, weatherText: mapWeatherCodeToText(h.weatherCode) })),
    daily: next7Daily.map(d => ({ ...d, weatherText: mapWeatherCodeToText(d.weatherCode) })),
    today: next7Daily[0] || null
  };
}

function toLocalDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Goal: Extract sunrise/sunset pairs as Date objects for daylight-aware planning.
 * Why: Daylight is a hard constraint on a ride; the best window must respect it.
 */
export function getDaylightRanges(weatherData) {
  if (!Array.isArray(weatherData?.daily)) return [];
  return weatherData.daily
    .filter(d => d.sunrise && d.sunset)
    .map(d => ({ sunrise: new Date(d.sunrise), sunset: new Date(d.sunset) }))
    .filter(r => !Number.isNaN(r.sunrise.getTime()) && !Number.isNaN(r.sunset.getTime()));
}

function getSafe(arr, idx) {
  if (!Array.isArray(arr)) return null;
  const v = arr[idx];
  return v === undefined ? null : v;
}

/**
 * Goal: Find the index of the hourly time closest to `now`.
 * Why: Aligns "current" conditions with the nearest forecast hour.
 */
function findNearestHourIndex(times, now) {
  if (!Array.isArray(times) || times.length === 0) return 0;
  const nowMs = now.getTime();
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i++) {
    const delta = Math.abs(new Date(times[i]).getTime() - nowMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Goal: Convert Open‑Meteo weather codes to human-readable text.
 * Why: Users should see condition names, not numeric codes.
 */
export function mapWeatherCodeToText(code) {
  const lookup = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  return lookup[code] ?? 'Unknown';
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
