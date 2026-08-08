/*
  Weather 4 Bike – Units & Formatting

  Goal: One place that decides how a number becomes text.

  Why: The app used to show temperature in the user's chosen unit while wind was
  always km/h in one card and always mph in another, and visibility was km here
  and miles there — on the same screen. Worse, recommendation thresholds compared
  Celsius values against Fahrenheit numbers whenever °F was selected.

  How:
  - The toggle picks a *system* (metric or imperial), not just a temperature unit.
    Everything derived — wind, gusts, distance, visibility — follows it.
  - All internal values stay in Open‑Meteo's units (°C, km/h, metres). Conversion
    happens only at the formatting boundary, once, so nothing is double-rounded.
  - `null` formats as an em dash, never as 0.
*/

export const SYSTEMS = {
  metric: {
    key: 'metric',
    temp: '°C',
    speed: 'km/h',
    distance: 'km',
    /** Comfortable riding band, in this system's temperature unit. */
    comfortBand: [13, 24]
  },
  imperial: {
    key: 'imperial',
    temp: '°F',
    speed: 'mph',
    distance: 'mi',
    // 55–76°F is the Fahrenheit image of 13–24°C: both bands classify every
    // whole-degree Celsius temperature identically. See units.test.js.
    comfortBand: [55, 76]
  }
};

const DASH = '—';

export function systemFor(key) {
  return SYSTEMS[key] || SYSTEMS.metric;
}

// --- Raw conversions --------------------------------------------------------

export function cToF(c) {
  return c * 9 / 5 + 32;
}

export function kmhToMph(kmh) {
  return kmh * 0.621371;
}

export function kmToMi(km) {
  return km * 0.621371;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// --- Value conversions (number in, number out, no rounding) -----------------

/** Convert a Celsius value into the given system's temperature unit. */
export function convertTemp(celsius, systemKey) {
  const c = finite(celsius);
  if (c === null) return null;
  return systemFor(systemKey).key === 'imperial' ? cToF(c) : c;
}

/** Convert a km/h value into the given system's speed unit. */
export function convertSpeed(kmh, systemKey) {
  const v = finite(kmh);
  if (v === null) return null;
  return systemFor(systemKey).key === 'imperial' ? kmhToMph(v) : v;
}

/** Convert a kilometre value into the given system's distance unit. */
export function convertDistance(km, systemKey) {
  const v = finite(km);
  if (v === null) return null;
  return systemFor(systemKey).key === 'imperial' ? kmToMi(v) : v;
}

// --- Formatters (number in, display string out) -----------------------------

/**
 * Convert first, then round once. Rounding to whole Celsius before converting
 * (the old behaviour) introduced up to ~1°F of avoidable error.
 */
export function formatTemp(celsius, systemKey, { unit = true } = {}) {
  const v = convertTemp(celsius, systemKey);
  if (v === null) return DASH;
  const s = systemFor(systemKey);
  return `${Math.round(v)}${unit ? s.temp : '°'}`;
}

export function formatSpeed(kmh, systemKey, { unit = true } = {}) {
  const v = convertSpeed(kmh, systemKey);
  if (v === null) return DASH;
  const s = systemFor(systemKey);
  return `${Math.round(v)}${unit ? ` ${s.speed}` : ''}`;
}

/** Visibility arrives from Open‑Meteo in metres. */
export function formatVisibility(metres, systemKey) {
  const m = finite(metres);
  if (m === null) return DASH;
  const v = convertDistance(m / 1000, systemKey);
  const s = systemFor(systemKey);
  // Below 10 units, a whole number hides the difference between 1.2 and 1.9.
  const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${rounded} ${s.distance}`;
}

export function formatPercent(value) {
  const v = finite(value);
  return v === null ? DASH : `${Math.round(v)}%`;
}

export function formatNumber(value, digits = 0) {
  const v = finite(value);
  return v === null ? DASH : v.toFixed(digits);
}

/** Precipitation depth: mm in metric, inches in imperial. */
export function formatPrecip(mm, systemKey) {
  const v = finite(mm);
  if (v === null) return DASH;
  if (systemFor(systemKey).key === 'imperial') {
    const inches = v / 25.4;
    return `${inches < 1 ? inches.toFixed(2) : inches.toFixed(1)}"`;
  }
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} mm`;
}

export function degToCardinal(deg) {
  const d = finite(deg);
  if (d === null) return DASH;
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const ix = Math.round(((d % 360) + 360) % 360 / 22.5) % 16;
  return dirs[ix];
}

/**
 * Goal: Answer "is this a comfortable riding temperature?" in the active system.
 * Why: This is exactly where the old code went wrong — it branched on the
 *      selected unit but kept comparing the raw Celsius value.
 * How: Convert the Celsius input into the active system, then compare against
 *      that system's own band. Both paths now agree.
 */
export function temperatureComfort(celsius, systemKey) {
  const v = convertTemp(celsius, systemKey);
  if (v === null) return 'unknown';
  const [lo, hi] = systemFor(systemKey).comfortBand;
  if (v < lo) return 'cold';
  if (v > hi) return 'hot';
  return 'ideal';
}

/** Human wind descriptor used in the conditions summary line. */
export function windDescriptor(kmh) {
  const v = finite(kmh);
  if (v === null) return 'unknown wind';
  if (v <= 10) return 'light winds';
  if (v <= 20) return 'a moderate breeze';
  if (v <= 30) return 'breezy conditions';
  if (v <= 40) return 'strong winds';
  return 'very strong winds';
}
