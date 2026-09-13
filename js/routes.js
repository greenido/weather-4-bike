/*
  Weather 4 Bike – Bike Routes link

  Goal: Hand the recommended ride over to Bike Route Weather, which scores real
  GPX routes stretch by stretch.

  Why: The best-window card says when to ride, but can only guess the wind from
  a single heading. The routes app answers the rest — as long as it opens on the
  same ride, so the link carries the start time and the rider's speed.

  How: `start` is an ISO instant, so both apps agree on the moment whatever zone
  each one displays it in; `speed` is km/h. When a link has no speed, the routes
  app reads `w4b:ridingSpeed` from localStorage (both apps share the
  greenido.github.io origin) — rename that key only together with the routes app.

  Pure and DOM-free, so it is testable.
*/

export const BIKE_ROUTES_URL = 'https://greenido.github.io/weather-bike-routes/';

/** The routes app, opened on a ride starting at `start` (a Date) at `speedKmh`. Either may be omitted. */
export function bikeRoutesUrl({ start, speedKmh } = {}) {
  const url = new URL(BIKE_ROUTES_URL);
  if (start instanceof Date && !Number.isNaN(start.getTime())) {
    url.searchParams.set('start', start.toISOString());
  }
  if (Number.isFinite(speedKmh) && speedKmh > 0) {
    url.searchParams.set('speed', String(Math.round(speedKmh)));
  }
  return url.toString();
}
