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
 * - mudWeight:    how much a wet surface hurts the ride.
 * - mudWindowH:   how far back the rainfall fallback looks, when modelled soil
 *                 moisture is unavailable (see surfaceState).
 * - dustWeight:   how much a bone-dry, blown-out surface hurts.
 * - ridingSpeedKmh: typical moving speed. Used to work out the airspeed a rider
 *                 actually feels, which is what decides how cold a ride is.
 */
export const DISCIPLINES = {
  road: {
    key: 'road',
    label: 'Road',
    windWeight: 1.0,
    gustWeight: 1.0,
    precipWeight: 1.2, // wet tarmac + traffic is the worst combination
    mudWeight: 0,      // tarmac drains; only current rain matters
    mudWindowH: 0,
    dustWeight: 0,
    ridingSpeedKmh: 28,
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
    dustWeight: 0.4,   // loose dry gravel is sketchy in corners
    ridingSpeedKmh: 22,
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
    dustWeight: 0.6, // blown-out dusty trails lose all grip
    ridingSpeedKmh: 15,
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
 * Goal: Work out whether a given heading puts the wind in your face or at your back.
 * Why: Wind direction was displayed but never used — every score assumed a
 *      crosswind because the route direction was unknown. Once the rider says
 *      which way they are going, the multiplier above finally has real input.
 * How: Open-Meteo reports the direction wind blows *from*. If that matches the
 *      direction you are heading toward, it is in your face.
 *
 * @param {number} headingDeg - compass bearing the rider is travelling toward
 * @param {number} windFromDeg - direction the wind is coming from
 */
export function windRelationFor(headingDeg, windFromDeg) {
  const heading = num(headingDeg);
  const from = num(windFromDeg);
  if (heading === null || from === null) return 'crosswind';
  // Smallest angle between "where the wind comes from" and "where you're going".
  // 0° means it is blowing straight into your face; 180° means straight behind.
  const offNose = Math.abs(((from - heading + 540) % 360) - 180);
  if (offNose <= 45) return 'headwind';
  if (offNose >= 135) return 'tailwind';
  return 'crosswind';
}

/**
 * Goal: The temperature a rider actually feels, given that they are moving.
 * Why: `apparent_temperature` assumes near-still air. A rider at 28 km/h into a
 *      20 km/h headwind sits in ~48 km/h of airflow; on a descent it is worse.
 *      This is the difference between "cool" and "cannot feel my hands", and it
 *      is the most cycling-specific number the app can show.
 * How: Environment Canada wind chill over the airspeed the rider meets. The
 *      formula is only defined at or below 10°C and above ~5 km/h of air
 *      movement; outside that range the ambient temperature is the honest answer.
 */
export function ridingWindChill(tempC, windKmh, ridingSpeedKmh, relation = 'crosswind') {
  const t = num(tempC);
  const wind = num(windKmh) ?? 0;
  const speed = num(ridingSpeedKmh);
  if (t === null || speed === null) return null;

  let airspeed;
  switch (String(relation).toLowerCase()) {
    case 'headwind': airspeed = speed + wind; break;
    case 'tailwind': airspeed = Math.abs(speed - wind); break;
    // A crosswind still adds to airspeed, just not linearly.
    default: airspeed = Math.sqrt(speed * speed + wind * wind);
  }

  if (t > 10 || airspeed < 5) return t;
  const v = Math.pow(airspeed, 0.16);
  return round1(13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v);
}

/**
 * Penalty for being genuinely cold on the bike, on top of the ambient
 * temperature penalty. Bounded and only below freezing, so it sharpens the
 * winter picture without double-counting `apparent_temperature`.
 */
function windChillPenalty(chillC) {
  const c = num(chillC);
  if (c === null || c >= 0) return c === null ? null : 0;
  if (c >= -5) return 0.5;
  if (c >= -10) return 1;
  return 1.5;
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

/** The default comfort band, in °C. Riders can move it — see `comfortBand`. */
export const DEFAULT_COMFORT_BAND = [15, 25];

/**
 * Goal: Penalise temperature relative to what *this* rider finds comfortable.
 * Why: A rider acclimatised in Tel Aviv and one in Seattle do not agree on what
 *      15°C means. A fixed band makes the score feel wrong for both of them.
 * How: Penalties grow with distance outside the band, in the same steps the
 *      fixed thresholds used to hardcode. With the default band the numbers are
 *      identical to before, so existing behaviour is preserved.
 */
function temperaturePenalty(tempC, band = DEFAULT_COMFORT_BAND) {
  const t = num(tempC);
  if (t === null) return null;
  const [lo, hi] = band;
  if (t >= lo && t <= hi) return 0;

  if (t > hi) {
    const over = t - hi;
    if (over <= 5) return 1;
    if (over <= 10) return 3.5;
    return 6;
  }

  const under = lo - t;
  if (under <= 5) return 1;
  if (under <= 10) return 2;
  if (t >= 0) return 3;
  return 4.5; // sub-zero
}

/** Clamp a rider-supplied comfort band to something the scorer can use. */
export function comfortBand(band) {
  if (!Array.isArray(band) || band.length !== 2) return DEFAULT_COMFORT_BAND;
  const lo = num(band[0]);
  const hi = num(band[1]);
  if (lo === null || hi === null || lo >= hi) return DEFAULT_COMFORT_BAND;
  return [clamp(lo, -20, 40), clamp(hi, -19, 45)];
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
 * Why: Fallback for locations or models where soil moisture is not published.
 * Note: This is the weaker signal. 15 mm two days ago means nothing after a hot
 *       windy day and everything after a cold damp one — rainfall alone cannot
 *       tell those apart, which is why `surfaceState` prefers soil moisture.
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

/**
 * Goal: Describe what the ground is actually like to ride on.
 * Why: This is the entire reason gravel and MTB are separate tabs. Rainfall
 *      totals are a proxy for it; volumetric soil water content *is* it, and
 *      the weather model already accounts for drying through evapotranspiration,
 *      sun and wind — the exact thing a rain sum cannot see.
 * How: Map volumetric water content (m³/m³, roughly 0 to ~0.5 at saturation)
 *      onto a named state. Both ends are bad: saturated is mud, bone-dry is
 *      loose and blown out. "Tacky" in the middle is what everyone hopes for.
 *
 * Thresholds are for typical loam. They are deliberately coarse — the point is
 * to separate "hero dirt" from "stay home", not to model soil science.
 *
 * @returns {{state: string, mud: number, dust: number, label: string}|null}
 */
export function surfaceState(volumetricWaterContent) {
  const vwc = num(volumetricWaterContent);
  if (vwc === null) return null;
  if (vwc < 0.10) return { state: 'dusty', mud: 0, dust: 1, label: 'Dusty and loose' };
  if (vwc < 0.16) return { state: 'dry', mud: 0, dust: 0.5, label: 'Dry and fast' };
  if (vwc < 0.27) return { state: 'tacky', mud: 0, dust: 0, label: 'Tacky — hero dirt' };
  if (vwc < 0.34) return { state: 'soft', mud: 1, dust: 0, label: 'Soft in places' };
  if (vwc < 0.41) return { state: 'muddy', mud: 2, dust: 0, label: 'Muddy' };
  return { state: 'saturated', mud: 3, dust: 0, label: 'Saturated — let it dry' };
}

/**
 * Goal: Resolve the surface however we can, best signal first.
 * How: Modelled soil moisture when the forecast carries it; otherwise fall back
 *      to accumulated rainfall so off-road scoring still works.
 */
export function resolveSurface(soilMoisture, recentRainMm, windowHours) {
  const modelled = surfaceState(soilMoisture);
  if (modelled) return { ...modelled, source: 'soil-moisture' };

  const mud = mudFactorFromRain(recentRainMm, windowHours);
  if (mud === null) return null;
  const label = ['Dry', 'Damp in places', 'Muddy', 'Saturated — let it dry'][mud];
  return { state: ['dry', 'soft', 'muddy', 'saturated'][mud], mud, dust: 0, label, source: 'rainfall' };
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
 *   visibilityKm, uvIndex, weatherCode, soilMoisture
 * @param {object} options - { discipline, windRelation, recentRainMm,
 *   comfortBand, ridingSpeedKmh }
 */
export function scoreConditions(conditions = {}, options = {}) {
  const profile = DISCIPLINES[options.discipline] || DISCIPLINES.road;
  const windRelation = options.windRelation || 'crosswind';
  const band = comfortBand(options.comfortBand);
  const ridingSpeed = num(options.ridingSpeedKmh) ?? profile.ridingSpeedKmh;

  // Prefer "feels like" for the comfort judgement — that is what the rider feels.
  const feelsLike = num(conditions.apparentTemperatureC);
  const airTemp = num(conditions.temperatureC);
  const comfortTemp = feelsLike !== null ? feelsLike : airTemp;

  // What it feels like once you are moving. Ambient "feels like" assumes still
  // air; this is the number that decides whether you can feel your hands.
  const chill = ridingWindChill(airTemp, conditions.windKmh, ridingSpeed, windRelation);

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
  apply('Temperature', temperaturePenalty(comfortTemp, band));
  apply('Wind chill', windChillPenalty(chill));
  apply('Humidity', humidityPenalty(conditions.humidityPct));
  apply(
    'Precipitation',
    precipitationPenalty(conditions.precipitationProbabilityPct, conditions.precipitationMm),
    profile.precipWeight
  );
  apply('Visibility', visibilityPenalty(conditions.visibilityKm));
  apply('UV', uvPenalty(conditions.uvIndex));

  // Surface condition — gravel and MTB only. Prefers modelled soil moisture and
  // falls back to accumulated rainfall; see resolveSurface.
  let surface = null;
  if (profile.mudWeight > 0) {
    surface = resolveSurface(conditions.soilMoisture, options.recentRainMm, profile.mudWindowH);
    if (surface === null) {
      unknown.push('Surface');
    } else {
      apply('Surface', surface.mud, profile.mudWeight);
      if (profile.dustWeight > 0 && surface.dust > 0) {
        apply('Dust / loose', surface.dust, profile.dustWeight);
      }
    }
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

  if (surface && surface.mud >= 2) {
    message += ` ${surface.label}.`;
  }

  return {
    score,
    tier,
    message,
    discipline: profile.key,
    breakdown: breakdown.filter(b => b.penalty !== 0),
    allPenalties: breakdown,
    unknown,
    ceilings,
    surface,                 // null for road, or { state, label, source, ... }
    ridingFeelsLikeC: chill, // what it feels like once you are moving
    windRelation,
    comfortBand: band
  };
}

/**
 * Goal: Score the conditions the app currently shows as "now".
 * Why: Convenience wrapper so callers do not reshape the weather object by hand.
 */
export function scoreCurrent(weatherData, discipline = 'road', options = {}) {
  // Older call sites passed a windRelation string here.
  const opts = typeof options === 'string' ? { windRelation: options } : options;
  const c = weatherData?.current || {};
  const profile = DISCIPLINES[discipline] || DISCIPLINES.road;
  const recentRainMm = profile.mudWindowH
    ? recentPrecipSum(weatherData?.hourly, profile.mudWindowH)
    : null;

  return scoreConditions(toConditions(c), { discipline, recentRainMm, ...opts });
}

/**
 * Goal: Score an out-and-back in both directions and say which way to set off.
 * Why: On a windy day the single most useful piece of advice is "ride out into
 *      it, come home with it" — get that backwards and the last hour is misery.
 *      The scorer has supported headwind/tailwind all along; nothing ever fed it
 *      a route direction.
 * How: Score the outbound heading and its reverse, then recommend starting with
 *      whichever leg is harder.
 *
 * @param {number} headingDeg - compass bearing of the outbound leg
 * @returns {{out: object, back: object, advice: string}|null}
 */
export function scoreOutAndBack(weatherData, discipline = 'road', headingDeg, options = {}) {
  const heading = num(headingDeg);
  if (heading === null) return null;

  const windFrom = num(weatherData?.current?.windDirection);
  const outRelation = windRelationFor(heading, windFrom);
  const backRelation = windRelationFor((heading + 180) % 360, windFrom);

  const out = scoreCurrent(weatherData, discipline, { ...options, windRelation: outRelation });
  const back = scoreCurrent(weatherData, discipline, { ...options, windRelation: backRelation });

  let advice;
  if (outRelation === backRelation) {
    advice = outRelation === 'crosswind'
      ? 'Crosswind both ways — direction barely matters today.'
      : 'Wind is similar in both directions.';
  } else if (Math.abs(out.score - back.score) < 0.05) {
    // The legs differ on paper, but the wind is too light to change the score.
    // Claiming the harder leg is first here would contradict the labels above it.
    advice = 'Wind is light enough that either direction rides much the same.';
  } else if (out.score < back.score) {
    advice = 'Good call — the hard leg is first. Save the tailwind for the way home.';
  } else {
    advice = 'Consider riding the reverse first, so the tailwind is on the way home.';
  }

  return { out: { ...out, relation: outRelation }, back: { ...back, relation: backRelation }, advice };
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
    weatherCode: num(record.weatherCode),
    soilMoisture: num(record.soilMoisture)
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
      // The rainfall fallback is O(n) per hour, so only pay for it when the
      // model did not give us soil moisture for this hour.
      const needsRainFallback = profile.mudWindowH > 0 && num(h.soilMoisture) === null;
      const recentRainMm = needsRainFallback
        ? recentPrecipSum(hourly, profile.mudWindowH, at)
        : null;
      const result = scoreConditions(toConditions(h), {
        discipline,
        windRelation: options.windRelation || 'crosswind',
        comfortBand: options.comfortBand,
        ridingSpeedKmh: options.ridingSpeedKmh,
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
