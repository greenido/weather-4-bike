import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getSavedPlaces, isSavedPlace, toggleSavedPlace, placeKey, getCurrentLocation } from '../js/location.js';

/** Just enough of localStorage for the saved-places store. */
function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k)
  };
}

const HOME = { name: 'Springfield', latitude: 39.7817, longitude: -89.6501, region: 'IL', country: 'USA' };
const TRAIL = { name: 'Shelbyville', latitude: 39.4064, longitude: -88.7901 };

describe('saved places', () => {
  beforeEach(installStorage);

  test('star, read back, un-star', () => {
    assert.deepEqual(getSavedPlaces(), []);
    assert.equal(toggleSavedPlace(HOME), true);
    assert.equal(isSavedPlace(HOME), true);
    assert.equal(getSavedPlaces()[0].name, 'Springfield');

    assert.equal(toggleSavedPlace(HOME), false);
    assert.equal(isSavedPlace(HOME), false);
    assert.deepEqual(getSavedPlaces(), []);
  });

  test('the same spot found two ways is one place', () => {
    toggleSavedPlace(HOME);
    const viaGps = { name: 'Current location', latitude: 39.78171, longitude: -89.65008 };
    assert.equal(placeKey(viaGps), placeKey(HOME));
    assert.equal(isSavedPlace(viaGps), true);
  });

  test('keeps the order they were saved in, and caps the list', () => {
    toggleSavedPlace(HOME);
    toggleSavedPlace(TRAIL);
    assert.deepEqual(getSavedPlaces().map(p => p.name), ['Springfield', 'Shelbyville']);

    for (let i = 0; i < 10; i++) toggleSavedPlace({ name: `Spot ${i}`, latitude: i, longitude: i });
    const saved = getSavedPlaces();
    assert.equal(saved.length, 8);
    assert.equal(saved[saved.length - 1].name, 'Spot 9', 'the newest is kept');
  });

  test('corrupt storage reads as nothing saved', () => {
    localStorage.setItem('w4b:savedPlaces', '{nope');
    assert.deepEqual(getSavedPlaces(), []);
    localStorage.setItem('w4b:savedPlaces', JSON.stringify([{ name: 'x' }, HOME]));
    assert.deepEqual(getSavedPlaces().map(p => p.name), ['Springfield']);
  });
});

describe('getCurrentLocation', () => {
  /** A geolocation stub that records the options it was asked with. */
  function stubGeolocation(coords) {
    const calls = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { geolocation: { getCurrentPosition: (ok, _err, options) => { calls.push(options); ok({ coords }); } } }
    });
    return calls;
  }

  test('asks for a quick network fix, not GPS', async () => {
    const calls = stubGeolocation({ latitude: 39.78, longitude: -89.65, accuracy: 900 });
    await getCurrentLocation();
    assert.equal(calls[0].enableHighAccuracy, false);
    assert.ok(calls[0].maximumAge >= 60000, 'a fix from a few minutes ago is good enough');
  });

  test('rounds the position to about 100 m before anyone sees it', async () => {
    stubGeolocation({ latitude: 39.781734, longitude: -89.650148, accuracy: 15 });
    const pos = await getCurrentLocation();
    assert.deepEqual(pos, { latitude: 39.782, longitude: -89.65, accuracy: 15 });
  });

  test('rejects when the browser has no geolocation', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await assert.rejects(getCurrentLocation(), /not supported/);
  });
});
