/*
  Weather 4 Bike – Ride planning across places, and sharing a plan

  Goal: Answer "where and when should I ride this week?" for the rider's saved
  places, and let them hand a ride to a friend as a link.

  Why: Comparing places on current conditions answers the wrong question —
  nobody drives an hour for a ride that starts right now. What matters is each
  place's best window, and which day it falls on.

  How:
  - planPlace: score one place's week and find its best window overall and per
    local day, using the same scorer and window search as the main view.
  - rankPlans: best window first; a sooner ride breaks ties.
  - shareHash / parseShareHash: put a ride in the URL *fragment*. A fragment is
    never sent to a server, so the page's analytics never see it, and the
    coordinates are rounded to ~1 km so a link does not pinpoint a home.

  Pure and DOM-free, so it is testable.
*/

import { DISCIPLINES, scoreHourlySeries, findBestWindow, scoreTier } from './insights.js';
import { getDaylightRanges } from './weather.js';
import { localDateKey } from './time.js';

const HOUR_MS = 3600 * 1000;

/**
 * One place's week, for a ride of `rideHours`.
 * @returns {{ best: object|null, days: { dateKey: string, window: object|null }[] }}
 */
export function planPlace(weather, activity, { rideHours = 2, scoring = {}, now = new Date() } = {}) {
  const scored = scoreHourlySeries(weather, activity, { hours: 168, now, ...scoring });
  const daylight = getDaylightRanges(weather);
  const search = {
    now,
    daylight: daylight.length ? daylight : null,
    minHours: rideHours,
    maxHours: rideHours,
    withinHours: 168
  };

  const best = findBestWindow(scored, search);
  const days = (Array.isArray(weather?.daily) ? weather.daily : []).map(d => ({
    dateKey: d.date,
    window: findBestWindow(scored.filter(h => localDateKey(h.date, weather.timezone) === d.date), search)
  }));
  return { best, days };
}

/** Best window first; a sooner start breaks a tie; places with no window last. */
export function rankPlans(rows) {
  return [...rows].sort((a, b) => {
    if (!a.plan?.best || !b.plan?.best) return (b.plan?.best ? 1 : 0) - (a.plan?.best ? 1 : 0);
    return (b.plan.best.score - a.plan.best.score) || (a.plan.best.start - b.plan.best.start);
  });
}

/**
 * Score the ride a friend proposed, against this forecast.
 * @returns {{start: Date, end: Date, hours: number, score: number, tier: object}|null}
 *          null when the forecast does not cover every hour of it.
 */
export function scoreWindowAt(scoredHours, start, hours) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || !(hours >= 1)) return null;
  const slice = [];
  for (let i = 0; i < hours; i++) {
    const at = start.getTime() + i * HOUR_MS;
    const hour = scoredHours.find(h => h.date.getTime() === at);
    if (!hour) return null;
    slice.push(hour);
  }
  const avg = slice.reduce((s, h) => s + h.score, 0) / hours;
  return {
    start,
    end: new Date(start.getTime() + hours * HOUR_MS),
    hours,
    score: Math.round(avg * 10) / 10,
    tier: scoreTier(avg)
  };
}

// --- Share links --------------------------------------------------------------

/** "#lat=…&lon=…" for a ride at `place`. Coordinates rounded to 2 dp (~1 km). */
export function shareHash({ place, activity, hours, start } = {}) {
  const params = new URLSearchParams();
  params.set('lat', Number(place.latitude).toFixed(2));
  params.set('lon', Number(place.longitude).toFixed(2));
  if (place.name) params.set('name', place.name);
  if (DISCIPLINES[activity]) params.set('a', activity);
  if (Number.isInteger(hours)) params.set('h', String(hours));
  if (start instanceof Date && !Number.isNaN(start.getTime())) params.set('start', start.toISOString());
  return `#${params.toString()}`;
}

/**
 * Read a shared ride back. Anything malformed is dropped rather than trusted;
 * without a usable place there is no ride at all.
 * @returns {{ place: object, activity: string|null, hours: number|null, start: Date|null }|null}
 */
export function parseShareHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (!params.has('lat') || !params.has('lon')) return null;
  const latitude = Number(params.get('lat'));
  const longitude = Number(params.get('lon'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const activity = DISCIPLINES[params.get('a')] ? params.get('a') : null;
  const h = Number(params.get('h'));
  const start = params.has('start') ? new Date(params.get('start')) : null;
  return {
    place: {
      name: (params.get('name') || '').slice(0, 80) || 'Shared location',
      latitude,
      longitude,
      region: '',
      country: ''
    },
    activity,
    hours: Number.isInteger(h) && h >= 1 && h <= 6 ? h : null,
    start: start && !Number.isNaN(start.getTime()) ? start : null
  };
}
