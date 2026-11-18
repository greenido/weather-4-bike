import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rideEvent, googleCalendarUrl, GOOGLE_CALENDAR_URL } from '../js/calendar.js';
import { inZone, VIEWER_ZONES } from './helpers.js';

const RIDE = {
  start: new Date('2026-11-18T15:00:00Z'),
  end: new Date('2026-11-18T17:00:00Z'),
  hours: 2,
  score: 7.4,
  tier: { label: 'Good' }
};
const LINK = 'https://example.com/weather-4-bike/#lat=37.77&lon=-122.42&a=road';

describe('rideEvent', () => {
  test('names the ride, the place, and how it looked when planned', () => {
    const event = rideEvent(RIDE, { activityLabel: 'Gravel', placeName: 'Marin Headlands, CA', link: LINK });
    assert.equal(event.title, 'Gravel ride · Marin Headlands, CA');
    assert.equal(event.location, 'Marin Headlands, CA');
    assert.equal(event.start, RIDE.start);
    assert.equal(event.end, RIDE.end);
    assert.match(event.details, /Forecast when planned: 7\.4\/10 \(Good\)\./);
    assert.ok(event.details.includes(LINK), 'links back to the app to check again');
  });

  test('leaves out what it does not know', () => {
    const event = rideEvent({ start: RIDE.start, end: RIDE.end }, { activityLabel: 'Road' });
    assert.equal(event.title, 'Road ride');
    assert.equal(event.location, '');
    assert.equal(event.details, '');
  });

  test('no event for a ride without a real time span', () => {
    assert.equal(rideEvent(null, { activityLabel: 'Road' }), null);
    assert.equal(rideEvent({ start: RIDE.end, end: RIDE.start }, {}), null);
    assert.equal(rideEvent({ start: new Date('nope'), end: RIDE.end }, {}), null);
  });
});

describe('googleCalendarUrl', () => {
  const event = rideEvent(RIDE, { activityLabel: 'Road', placeName: 'Tel Aviv, Israel', link: LINK });

  test('opens a pre-filled event in Google Calendar', () => {
    const url = new URL(googleCalendarUrl(event));
    assert.equal(`${url.origin}${url.pathname}`, GOOGLE_CALENDAR_URL);
    assert.equal(url.searchParams.get('action'), 'TEMPLATE');
    assert.equal(url.searchParams.get('text'), 'Road ride · Tel Aviv, Israel');
    assert.equal(url.searchParams.get('location'), 'Tel Aviv, Israel');
    assert.equal(url.searchParams.get('details'), event.details, 'details survive encoding, newlines and all');
  });

  test('sends exact UTC instants, whatever zone the rider is in', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        const url = new URL(googleCalendarUrl(event));
        assert.equal(url.searchParams.get('dates'), '20261118T150000Z/20261118T170000Z', `viewer in ${zone}`);
      });
    }
  });

  test('only the fields it has', () => {
    const url = new URL(googleCalendarUrl({ start: RIDE.start, end: RIDE.end }));
    assert.equal(url.searchParams.get('text'), 'Bike ride');
    assert.equal(url.searchParams.has('details'), false);
    assert.equal(url.searchParams.has('location'), false);
  });

  test('null rather than a broken link', () => {
    assert.equal(googleCalendarUrl(null), null);
    assert.equal(googleCalendarUrl({ start: RIDE.end, end: RIDE.start }), null);
  });
});
