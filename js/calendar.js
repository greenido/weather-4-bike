/*
  Weather 4 Bike – Add a ride to a calendar

  Goal: Put the recommended ride in the rider's calendar in one tap.

  Why: Knowing "3–5 PM is the window" is only useful if the afternoon gets
  kept free for it. A calendar entry does that, and carries a link back to the
  app so the forecast can be checked again before heading out.

  How: `rideEvent` turns a ride into a provider-neutral event; one small
  function per calendar turns that into a link. Google Calendar first — its
  "TEMPLATE" URL opens a pre-filled event with nothing to download. Times are
  sent as UTC instants, so the calendar shows them on the rider's own clock
  whatever zone the forecast location is in.

  Pure and DOM-free, so it is testable.
*/

export const GOOGLE_CALENDAR_URL = 'https://calendar.google.com/calendar/render';

/**
 * A ride as a calendar event.
 *
 * @param {{ start: Date, end: Date, score?: number, tier?: { label: string } }} ride
 * @param {{ activityLabel: string, placeName?: string, link?: string }} context
 * @returns {{ title: string, start: Date, end: Date, details: string, location: string }|null}
 */
export function rideEvent(ride, { activityLabel, placeName = '', link = '' } = {}) {
  if (!isDate(ride?.start) || !isDate(ride?.end) || ride.end <= ride.start) return null;

  const where = String(placeName || '').trim();
  const title = `${activityLabel || 'Bike'} ride${where ? ` · ${where}` : ''}`;

  const lines = [];
  if (Number.isFinite(ride.score)) {
    const label = ride.tier?.label ? ` (${ride.tier.label})` : '';
    lines.push(`Forecast when planned: ${ride.score}/10${label}.`);
  }
  if (link) lines.push(`Check the latest forecast before you go: ${link}`);

  return { title, start: ride.start, end: ride.end, details: lines.join('\n'), location: where };
}

/** A link that opens Google Calendar on a new, pre-filled event. Null without a valid event. */
export function googleCalendarUrl(event) {
  if (!event || !isDate(event.start) || !isDate(event.end) || event.end <= event.start) return null;
  const url = new URL(GOOGLE_CALENDAR_URL);
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', event.title || 'Bike ride');
  url.searchParams.set('dates', `${utcStamp(event.start)}/${utcStamp(event.end)}`);
  if (event.details) url.searchParams.set('details', event.details);
  if (event.location) url.searchParams.set('location', event.location);
  return url.toString();
}

/** 2026-11-18T15:00:00.000Z → 20261118T150000Z, the basic format calendars expect. */
function utcStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function isDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
