/*
  Weather 4 Bike – Cycling Insights (Domain Logic)

  Goal: Convert raw weather into cycling decisions: a 1–10 rideability score per
  discipline, safety alerts, and the best window to actually go out.

  Why: Riders need decisions, not numbers. Keeping the heuristics here (pure,
  DOM-free, storage-free) means the UI stays declarative and the rules stay testable.

  How:
  - One table-driven scorer. Each discipline is a set of weights over the same
    penalty model, so "road vs gravel vs MTB" is data, not duplicated code.
  - Every penalty returns `null` when its input is unknown. Unknown is NOT zero:
    a missing visibility reading must not silently cost 3 points.
  - The same tier function drives the badge, the message, and the colour, so the
    UI can never contradict itself.
*/

// ---------------------------------------------------------------------------
// Discipline profiles
// ---------------------------------------------------------------------------

/**
 * Weights over the shared penalty model.
 * - windWeight:   exposure to steady wind (gravel is the most exposed).
 * - gustWeight:   sensitivity to gust spread (deep road wheels suffer most).
 * - precipWeight: how much active/likely rain hurts the ride.
 * - mudWeight:    how much *recent* rain hurts the surface.
 * - mudWindowH:   how far back surface memory reaches.
 */
export const DISCIPLINES = {
  road: {
    key: 'road',
    label: 'Road',
    windWeight: 1.0,
    gustWeight: 1.0,
    precipWeight: 1.2, // wet tarmac + traffic is the worst combination
    mudWeight: 0,      // road surfaces drain; only current rain matters
    mudWindowH: 0,
    heatCeiling: 35,
    messages: {
      excellent: 'Perfect conditions. Go for that long ride! 🚴',
      good: 'Good conditions for cycling. Enjoy your ride.',
      fair: 'Decent conditions, but be prepared for some challenges.',
      poor: "Challenging conditions. Only go if you're experienced.",
      skip: 'Poor conditions. Consider indoor training.'
    }
  },
  gravel: {
    key: 'gravel',
    label: 'Gravel',
    windWeight: 1.5, // exposed, open terrain
    gustWeight: 1.0,
    precipWeight: 1.0,
    mudWeight: 0.8,
    mudWindowH: 48,
    heatCeiling: 34,
    messages: {
      excellent: 'Great day for gravel! Tyres up, get out there.',
      good: 'Good gravel conditions.',
      fair: 'Manageable gravel — expect some challenges.',
      poor: 'Challenging gravel conditions.',
      skip: 'Poor gravel conditions.'
    }
  },
  mtb: {
    key: 'mtb',
    label: 'MTB',
    windWeight: 0.7, // trees and terrain shelter you
    gustWeight: 0.6,
    precipWeight: 0.9,
    mudWeight: 1.0,  // trail damage is the dominant concern
    mudWindowH: 72,
    heatCeiling: 34,
    messages: {
      excellent: 'Trails are prime!',
      good: 'Good day to ride.',
      fair: 'Rideable with caution.',
      poor: 'Challenging trail conditions.',
      skip: 'Not recommended today — let the trails dry.'
    }
  }
};

// Weather code groups we treat as hard hazards.
const CODES_THUNDER = new Set([95, 96, 99]);
const CODES_FREEZING = new Set([56, 57, 66, 67]);
const CODES_SNOW = new Set([71, 73, 75, 77, 85, 86]);
const CODES_FOG = new Set([45, 48]);

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/**
 * Goal: Coerce a value to a finite number, or `null` if it is genuinely unknown.
 * Why: `Number(null)` is 0, which previously turned "no visibility reading" into
 *      "zero metres of visibility" and cost the rider 3 points for nothing.
 */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------------------
// Individual penalties — each returns a number, or null when input is unknown
// ---------------------------------------------------------------------------

function windPenalty(windKmh) {
  const w = num(windKmh);
  if (w === null) return null;
  if (w <= 10) return 0;
  if (w <= 20) return 1;
  if (w <= 30) return 2;
  if (w <= 40) return 3;
  return 4;
}

function directionMultiplier(relation) {
  switch (String(relation || 'crosswind').toLowerCase()) {
    case 'headwind': return 1.3;
    case 'tailwind': return 0.7;
    default: return 1.0; // crosswind / unknown route direction
  }
}

/**
 * Gusts matter more than mean wind for bike handling: it is the *spread* between
 * lull and gust that moves the bike, not the average.
 */
function gustPenalty(windKmh, gustKmh) {
  const w = num(windKmh);
  const g = num(gustKmh);
  if (w === null || g === null) return null;
  const spread = g - w;
  if (spread >= 30) return 1.5;
  if (spread >= 20) return 1.0;
  if (spread >= 12) return 0.5;
  return 0;
}

function temperaturePenalty(tempC) {
  const t = num(tempC);
  if (t === null) return null;
  if (t >= 15 && t <= 25) return 0;
  if ((t >= 10 && t < 15) || (t > 25 && t <= 30)) return 1;
  if (t >= 5 && t < 10) return 2;
  if (t > 30 && t <= 35) return 3.5;
  if (t > 35) return 6;
  if (t >= 0 && t < 5) return 3;
  return 4.5; // sub-zero
}

function humidityPenalty(humidityPct) {
  const rh = num(humidityPct);
  if (rh === null) return null;
  if (rh <= 60) return 0;
  if (rh <= 80) return 1;
  return 2;
}

/**
 * Precipitation — the factor the previous scorer left out entirely.
 * Combines "how likely" with "how hard", taking the worse of the two so that a
 * certain drizzle and a possible downpour are both represented honestly.
 */
function precipitationPenalty(probabilityPct, intensityMm) {
  const p = num(probabilityPct);
  const mm = num(intensityMm);
  if (p === null && mm === null) return null;

  let fromProbability = 0;
  if (p !== null) {
    if (p <= 10) fromProbability = 0;
    else if (p <= 30) fromProbability = 0.5;
    else if (p <= 50) fromProbability = 1.5;
    else if (p <= 70) fromProbability = 2.5;
    else if (p <= 90) fromProbability = 3.5;
    else fromProbability = 4;
  }

  let fromIntensity = 0;
  if (mm !== null) {
    if (mm <= 0) fromIntensity = 0;
    else if (mm < 0.5) fromIntensity = 1.5;  // spitting
    else if (mm < 2) fromIntensity = 3;      // steady rain
    else if (mm < 5) fromIntensity = 4;      // heavy
    else fromIntensity = 5;                  // soaked
  }

  return Math.max(fromProbability, fromIntensity);
}

function visibilityPenalty(visibilityKm) {
  const v = num(visibilityKm);
  if (v === null) return null;
  if (v >= 10) return 0;
  if (v >= 5) return 1;
  if (v >= 2) return 2;
  return 3;
}

function uvPenalty(uvIndex) {
  const uv = num(uvIndex);
  if (uv === null) return null;
  if (uv <= 5) return 0;
  if (uv <= 7) return 0.5;
  if (uv <= 9) return 1.0;
  return 1.5;
}

/**
 * Goal: Turn accumulated recent rainfall into a 0–3 surface/mud factor.
 * Why: This is the entire reason gravel and MTB are separate tabs — without it
 *      they are just "road with a different wind multiplier".
 */
export function mudFactorFromRain(totalMm, windowHours) {
  const mm = num(totalMm);
  if (mm === null) return null;
  // Longer memory windows need proportionally more rain to reach the same mud.
  const scale = windowHours >= 72 ? 1.5 : 1;
  if (mm >= 20 * scale) return 3;
  if (mm >= 10 * scale) return 2;
  if (mm >= 3 * scale) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Score tiers — single source of truth for label, colour and message
// ---------------------------------------------------------------------------

/**
 * Goal: Map a 1–10 score to one tier used by every part of the UI.
 * Why: The old code had `scoreToLabel()` saying "Poor" while the message said
 *      "Decent conditions" for the same score. One function, no contradictions.
 */
export function scoreTier(score10) {
  const s = num(score10) ?? 0;
  if (s >= 8) return { key: 'excellent', label: 'Excellent', emoji: '🟢', tone: 'green' };
  if (s >= 6) return { key: 'good', label: 'Good', emoji: '🟡', tone: 'yellow' };
  if (s >= 4) return { key: 'fair', label: 'Fair', emoji: '🟠', tone: 'orange' };
  if (s >= 2.5) return { key: 'poor', label: 'Poor', emoji: '🔴', tone: 'red' };
  return { key: 'skip', label: 'Skip it', emoji: '⛔', tone: 'red' };
}

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

/**
 * Goal: Score one set of conditions for one discipline on a 1–10 scale.
 * Why: Every view (now, each forecast hour, the best-window search) needs the
 *      same verdict from the same rules.
 * How: Start at 10, subtract weighted penalties, then apply hard hazard ceilings
 *      that no amount of otherwise-good weather can argue away.
 *
 * @param {object} conditions - temperatureC, apparentTemperatureC, humidityPct,
 *   windKmh, windGustKmh, precipitationProbabilityPct, precipitationMm,
 *   visibilityKm, uvIndex, weatherCode
 * @param {object} options - { discipline, windRelation, recentRainMm }
 */
export function scoreConditions(conditions = {}, options = {}) {
  const profile = DISCIPLINES[options.discipline] || DISCIPLINES.road;
  const windRelation = options.windRelation || 'crosswind';

  // Prefer "feels like" for the comfort judgement — that is what the rider feels.
  const feelsLike = num(conditions.apparentTemperatureC);
  const airTemp = num(conditions.temperatureC);
  const comfortTemp = feelsLike !== null ? feelsLike : airTemp;

  const breakdown = [];
  const unknown = [];
  let total = 10;

  const apply = (name, rawPenalty, weight = 1) => {
    if (rawPenalty === null) {
      unknown.push(name);
      return;
    }
    const weighted = round1(rawPenalty * weight);
    if (weighted !== 0) total -= weighted;
    breakdown.push({ name, penalty: weighted });
  };

  const baseWind = windPenalty(conditions.windKmh);
  apply(
    'Wind',
    baseWind === null ? null : baseWind * directionMultiplier(windRelation),
    profile.windWeight
  );
  apply('Gusts', gustPenalty(conditions.windKmh, conditions.windGustKmh), profile.gustWeight);
  apply('Temperature', temperaturePenalty(comfortTemp));
  apply('Humidity', humidityPenalty(conditions.humidityPct));
  apply(
    'Precipitation',
    precipitationPenalty(conditions.precipitationProbabilityPct, conditions.precipitationMm),
    profile.precipWeight
  );
  apply('Visibility', visibilityPenalty(conditions.visibilityKm));
  apply('UV', uvPenalty(conditions.uvIndex));

  // Surface memory — gravel and MTB only.
  if (profile.mudWeight > 0) {
    const mud = mudFactorFromRain(options.recentRainMm, profile.mudWindowH);
    apply('Surface / mud', mud, profile.mudWeight);
  }

  // Very high humidity compounds everything else.
  const rh = num(conditions.humidityPct);
  if (rh !== null && rh >= 90) total = Math.min(total, 4);

  // --- Hard hazard ceilings -------------------------------------------------
  const ceilings = [];
  const code = num(conditions.weatherCode);
  const temp = airTemp;
  const precipProb = num(conditions.precipitationProbabilityPct) ?? 0;

  if (temp !== null && temp > profile.heatCeiling) {
    ceilings.push({ cap: 2, reason: 'Extreme heat' });
  }
  if (code !== null && CODES_THUNDER.has(code)) {
    ceilings.push({ cap: 1.5, reason: 'Thunderstorms' });
  }
  if (code !== null && CODES_FREEZING.has(code)) {
    ceilings.push({ cap: 1.5, reason: 'Freezing rain — ice risk' });
  }
  if (temp !== null && temp <= 1 && precipProb > 40) {
    ceilings.push({ cap: 2.5, reason: 'Near-freezing with precipitation — ice risk' });
  }
  if (code !== null && CODES_SNOW.has(code)) {
    ceilings.push({ cap: profile.key === 'road' ? 2 : 3, reason: 'Snow' });
  }

  for (const c of ceilings) total = Math.min(total, c.cap);

  const score = Math.max(1, Math.min(10, round1(total)));
  const tier = scoreTier(score);
  let message = profile.messages[tier.key];

  const uv = num(conditions.uvIndex);
  if (uv !== null && uv >= 7) message += ' Consider riding early or late — UV is high.';
  if (ceilings.length) message = `${ceilings[0].reason}. ${message}`;

  return {
    score,
    tier,
    message,
    discipline: profile.key,
    breakdown: breakdown.filter(b => b.penalty !== 0),
    allPenalties: breakdown,
    unknown,
    ceilings
  };
}

/**
 * Goal: Score the conditions the app currently shows as "now".
 * Why: Convenience wrapper so callers do not reshape the weather object by hand.
 */
export function scoreCurrent(weatherData, discipline = 'road', windRelation = 'crosswind') {
  const c = weatherData?.current || {};
  const profile = DISCIPLINES[discipline] || DISCIPLINES.road;
  const recentRainMm = profile.mudWindowH
    ? recentPrecipSum(weatherData?.hourly, profile.mudWindowH)
    : null;

  return scoreConditions(toConditions(c), { discipline, windRelation, recentRainMm });
}

/**
 * Goal: Adapt a parsed weather record (current or hourly) to scorer input.
 * Why: `weather.js` speaks metres and km/h; the scorer speaks km and km/h.
 */
export function toConditions(record = {}) {
  const visibilityM = num(record.visibility);
  return {
    temperatureC: num(record.temperature),
    apparentTemperatureC: num(record.apparentTemperature),
    humidityPct: num(record.humidity),
    windKmh: num(record.windSpeed),
    windGustKmh: num(record.windGusts),
    precipitationProbabilityPct: num(record.precipitationProbability),
    precipitationMm: num(record.precipitation),
    visibilityKm: visibilityM === null ? null : visibilityM / 1000,
    uvIndex: num(record.uvIndex),
    weatherCode: num(record.weatherCode)
  };
}

// ---------------------------------------------------------------------------
// Hourly scoring and the "when should I ride?" search
// ---------------------------------------------------------------------------

/**
 * Goal: Sum precipitation over the N hours before `at`.
 * Why: Drives the mud/surface factor for gravel and MTB.
 * How: Walk the hourly series (which includes past days) and total the window.
 */
export function recentPrecipSum(hourly, hoursBack, at = new Date()) {
  if (!Array.isArray(hourly) || !hoursBack) return null;
  const end = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const start = end - hoursBack * 3600 * 1000;
  let total = 0;
  let sawAny = false;
  for (const h of hourly) {
    const t = new Date(h.time).getTime();
    if (Number.isNaN(t) || t < start || t > end) continue;
    const p = num(h.precipitation);
    if (p !== null) {
      total += p;
      sawAny = true;
    }
  }
  return sawAny ? round1(total) : null;
}

/**
 * Goal: Score every upcoming hour so the UI can show a rideability timeline.
 * Why: The app holds 168 hours of data and used to judge only the current one.
 *      "When should I go out?" is the question a cyclist actually asks.
 * How: For each future hour, recompute the surface factor as of that hour, then
 *      run the same scorer used for "now".
 */
export function scoreHourlySeries(weatherData, discipline = 'road', options = {}) {
  const hourly = weatherData?.hourly;
  if (!Array.isArray(hourly) || !hourly.length) return [];

  const profile = DISCIPLINES[discipline] || DISCIPLINES.road;
  const now = options.now instanceof Date ? options.now : new Date();
  const horizonH = options.hours ?? 48;
  const horizon = now.getTime() + horizonH * 3600 * 1000;
  // Include the hour we are currently inside, not just strictly future ones.
  const floor = now.getTime() - 3600 * 1000;

  return hourly
    .filter(h => {
      const t = new Date(h.time).getTime();
      return !Number.isNaN(t) && t >= floor && t <= horizon;
    })
    .map(h => {
      const at = new Date(h.time);
      const recentRainMm = profile.mudWindowH
        ? recentPrecipSum(hourly, profile.mudWindowH, at)
        : null;
      const result = scoreConditions(toConditions(h), {
        discipline,
        windRelation: options.windRelation || 'crosswind',
        recentRainMm
      });
      return { ...result, time: h.time, date: at, hour: h };
    });
}

/**
 * Goal: Find the best contiguous stretch to ride in the next day or so.
 * Why: This is the app's reason to exist — turning a forecast into a plan.
 * How: Slide windows of `maxHours..minHours` over the scored series, prefer the
 *      highest average score, break ties toward longer and earlier windows.
 *      Windows that cross a big score cliff are rejected via a floor on the
 *      worst hour inside them.
 *
 * @returns {{start: Date, end: Date, hours: number, score: number, tier: object}|null}
 */
export function findBestWindow(scoredHours, options = {}) {
  const minHours = options.minHours ?? 2;
  const maxHours = options.maxHours ?? 4;
  const withinHours = options.withinHours ?? 24;
  const daylight = options.daylight || null; // { sunrise: Date, sunset: Date }[]

  if (!Array.isArray(scoredHours) || scoredHours.length < minHours) return null;

  const now = options.now instanceof Date ? options.now : new Date();
  const limit = now.getTime() + withinHours * 3600 * 1000;

  let pool = scoredHours.filter(h => h.date.getTime() <= limit);
  if (daylight) pool = pool.filter(h => isDaylight(h.date, daylight));
  if (pool.length < minHours) return null;

  let best = null;
  for (let len = maxHours; len >= minHours; len--) {
    for (let i = 0; i + len <= pool.length; i++) {
      const slice = pool.slice(i, i + len);
      if (!isContiguous(slice)) continue;

      const avg = slice.reduce((s, h) => s + h.score, 0) / len;
      const worst = Math.min(...slice.map(h => h.score));
      // Reject windows that look good on average but contain an awful hour.
      if (worst < avg - 2.5) continue;

      const candidate = {
        start: slice[0].date,
        end: new Date(slice[len - 1].date.getTime() + 3600 * 1000),
        hours: len,
        score: round1(avg),
        worst: round1(worst),
        tier: scoreTier(avg)
      };

      if (
        !best ||
        candidate.score > best.score + 0.05 ||
        (Math.abs(candidate.score - best.score) <= 0.05 && candidate.hours > best.hours)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

function isContiguous(slice) {
  for (let i = 1; i < slice.length; i++) {
    const gap = slice[i].date.getTime() - slice[i - 1].date.getTime();
    if (gap !== 3600 * 1000) return false;
  }
  return true;
}

function isDaylight(date, daylightRanges) {
  const t = date.getTime();
  return daylightRanges.some(r => {
    if (!r?.sunrise || !r?.sunset) return true;
    return t >= r.sunrise.getTime() && t <= r.sunset.getTime();
  });
}

/**
 * Goal: Tell the rider when rain starts or stops in the next hours.
 * Why: "Dry until 2pm" is a plan; "40% chance today" is trivia.
 * How: Walk the scored/hourly series for the first meaningful wet hour, and if
 *      it is already wet, the first dry one after it.
 */
export function findRainTiming(hourly, options = {}) {
  if (!Array.isArray(hourly) || !hourly.length) return null;
  const now = options.now instanceof Date ? options.now : new Date();
  const horizon = now.getTime() + (options.hours ?? 24) * 3600 * 1000;
  const probThreshold = options.probabilityThreshold ?? 50;

  const upcoming = hourly
    .map(h => ({ ...h, date: new Date(h.time) }))
    .filter(h => !Number.isNaN(h.date.getTime()) && h.date.getTime() >= now.getTime() - 3600 * 1000 && h.date.getTime() <= horizon);

  if (!upcoming.length) return null;

  const isWet = h => (num(h.precipitation) ?? 0) > 0.05 || (num(h.precipitationProbability) ?? 0) >= probThreshold;

  const wetNow = isWet(upcoming[0]);
  if (wetNow) {
    const dryIndex = upcoming.findIndex(h => !isWet(h));
    if (dryIndex === -1) return { state: 'wet', clearsAt: null };
    return { state: 'wet', clearsAt: upcoming[dryIndex].date };
  }

  const wetIndex = upcoming.findIndex(isWet);
  if (wetIndex === -1) return { state: 'dry', startsAt: null };
  return { state: 'dry', startsAt: upcoming[wetIndex].date };
}

// ---------------------------------------------------------------------------
// Safety alerts
// ---------------------------------------------------------------------------

/**
 * Goal: Surface hazards that change what a rider wears, rides, or whether they go.
 * Why: The score is one number; alerts explain the specific thing to watch.
 * How: Threshold rules over current conditions, returning typed alerts.
 */
export function generateSafetyAlerts(weatherData) {
  const alerts = [];
  const c = weatherData?.current || {};

  const wind = num(c.windSpeed);
  const gusts = num(c.windGusts);
  if (wind !== null && wind >= 25) {
    alerts.push({
      type: 'wind',
      severity: wind >= 40 ? 'high' : 'moderate',
      message: `Strong winds (${Math.round(wind)} km/h) may affect bike handling.`
    });
  }
  if (wind !== null && gusts !== null && gusts - wind >= 20) {
    alerts.push({
      type: 'wind',
      severity: gusts >= 55 ? 'high' : 'moderate',
      message: `Gusting to ${Math.round(gusts)} km/h — expect sudden pushes on exposed sections.`
    });
  }

  const visibility = num(c.visibility);
  if (visibility !== null && visibility < 2000) {
    alerts.push({ type: 'visibility', severity: 'moderate', message: 'Low visibility. Use lights and high-visibility gear.' });
  }
  const code = num(c.weatherCode);
  if (code !== null && CODES_FOG.has(code)) {
    alerts.push({ type: 'visibility', severity: 'moderate', message: 'Fog. Assume drivers cannot see you.' });
  }

  const precip = num(c.precipitation);
  const precipProb = num(c.precipitationProbability);
  if ((precip !== null && precip > 0) || (precipProb !== null && precipProb > 60)) {
    alerts.push({ type: 'wet', severity: 'moderate', message: 'Wet conditions likely. Increase braking distance.' });
  }

  const t = num(c.temperature);
  if (t !== null && t <= 0) {
    alerts.push({ type: 'cold', severity: 'high', message: 'Freezing temperatures. Risk of ice on the road.' });
  } else if (t !== null && t <= 5) {
    alerts.push({ type: 'cold', severity: 'moderate', message: 'Cold ride. Cover extremities and watch shaded corners.' });
  }
  if (t !== null && t >= 35) {
    alerts.push({ type: 'heat', severity: 'high', message: 'Extreme heat. Hydrate and avoid peak sun hours.' });
  }

  if (code !== null && CODES_THUNDER.has(code)) {
    alerts.push({ type: 'storm', severity: 'high', message: 'Thunderstorms in the area. Do not ride exposed ridgelines.' });
  }

  const uv = num(c.uvIndex);
  if (uv !== null && uv >= 8) {
    alerts.push({ type: 'uv', severity: uv >= 10 ? 'high' : 'moderate', message: `UV index ${Math.round(uv)}. Sunscreen and cover up.` });
  }

  const aqi = num(weatherData?.airQuality?.aqi);
  if (aqi !== null && aqi >= 100) {
    alerts.push({
      type: 'air',
      severity: aqi >= 150 ? 'high' : 'moderate',
      message: `Air quality index ${Math.round(aqi)} — consider an easier effort or an indoor session.`
    });
  }

  return alerts;
}

/**
 * Goal: Turn conditions into concrete kit and pacing advice.
 * Why: "8.2/10" does not tell you to bring a gilet.
 * How: A few threshold rules over temperature, wind, rain and UV.
 */
export function generateRecommendations(weatherData, discipline = 'road') {
  const c = weatherData?.current || {};
  const out = [];

  const feels = num(c.apparentTemperature);
  const air = num(c.temperature);
  const t = feels !== null ? feels : air;

  if (t !== null) {
    if (t < 5) out.push({ icon: 'thermo', text: 'Winter kit: thermal bibs, full gloves, overshoes and a cap.' });
    else if (t < 13) out.push({ icon: 'thermo', text: 'Layer up — arm warmers and a gilet for the descents.' });
    else if (t <= 24) out.push({ icon: 'thermo', text: 'Ideal temperature for long rides.' });
    else if (t <= 30) out.push({ icon: 'thermo', text: 'Warm. Carry an extra bottle and start early.' });
    else out.push({ icon: 'thermo', text: 'Very hot. Ride at dawn, halve the intensity, double the fluids.' });
  }

  const wind = num(c.windSpeed);
  const gusts = num(c.windGusts);
  if (wind !== null) {
    if (wind <= 10) out.push({ icon: 'wind', text: 'Light wind — a good day to chase a personal best.' });
    else if (wind <= 25) out.push({ icon: 'wind', text: 'Noticeable wind. Plan to ride out into it and come home with it.' });
    else out.push({ icon: 'wind', text: 'Strong wind. Avoid exposed ridges and deep-section wheels.' });
  }
  if (wind !== null && gusts !== null && gusts - wind >= 20) {
    out.push({ icon: 'wind', text: 'Gusty. Keep a relaxed grip and stay off the aero bars.' });
  }

  const precipProb = num(c.precipitationProbability) ?? 0;
  const precip = num(c.precipitation) ?? 0;
  if (precip > 0 || precipProb >= 50) {
    out.push({ icon: 'humidity', text: 'Pack a rain shell and expect longer braking distances.' });
    if (discipline === 'mtb') out.push({ icon: 'flag', text: 'Wet trails damage easily — stick to hard-pack and ride the puddles, not around them.' });
    if (discipline === 'gravel') out.push({ icon: 'flag', text: 'Expect loaded-up drivetrain and slower rolling on wet gravel.' });
  }

  const uv = num(c.uvIndex);
  if (uv !== null) {
    if (uv >= 6) out.push({ icon: 'uv', text: 'High UV — sunscreen on arms, neck and legs before you leave.' });
    else out.push({ icon: 'uv', text: 'Moderate UV. Sunscreen still recommended.' });
  }

  return out;
}
