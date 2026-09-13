import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BIKE_ROUTES_URL, bikeRoutesUrl } from '../js/routes.js';

const paramsOf = href => new URL(href).searchParams;

describe('bikeRoutesUrl', () => {
  test('carries the start as an exact instant and the speed in km/h', () => {
    const href = bikeRoutesUrl({ start: new Date('2026-09-19T14:00:00Z'), speedKmh: 27.6 });
    assert.ok(href.startsWith(BIKE_ROUTES_URL));
    assert.equal(paramsOf(href).get('start'), '2026-09-19T14:00:00.000Z');
    assert.equal(paramsOf(href).get('speed'), '28');
  });

  test('leaves out whatever it was not given, or could not use', () => {
    assert.equal(bikeRoutesUrl(), BIKE_ROUTES_URL);
    assert.equal(bikeRoutesUrl({ start: new Date('nope'), speedKmh: NaN }), BIKE_ROUTES_URL);
    assert.equal(bikeRoutesUrl({ start: '2026-09-19T14:00:00Z', speedKmh: 0 }), BIKE_ROUTES_URL);
    assert.deepEqual([...paramsOf(bikeRoutesUrl({ speedKmh: 15 })).keys()], ['speed']);
  });
});
