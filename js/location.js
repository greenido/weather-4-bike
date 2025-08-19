/*
  Weather 4 Bike – Location Services

  Goal: Provide location capabilities: current geolocation, forward geocoding
  (search), reverse geocoding, and persistence of recent/last locations.

  Why: The app revolves around a user’s place. Keeping all location I/O and
  storage concerns together makes flows predictable and testable.

  How:
  - Thin wrappers over browser geolocation and public geocoding APIs.
  - Normalize response shapes for the UI and persist a small recents list.
  - Expose pure functions; no DOM manipulation here.
*/

const RECENTS_KEY = 'w4b_recent_locations_v1';
const LAST_KEY = 'w4b_last_location_v1';
const MAX_RECENTS = 15;

/**
 * Goal: Obtain the user's current geolocation coordinates.
 * Why: Enables one-tap weather for where the rider is.
 * How: Wrap `navigator.geolocation.getCurrentPosition` in a Promise and return
 *      latitude, longitude, and accuracy.
 */
export function getCurrentLocation(options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      },
      (err) => reject(err),
      options
    );
  });
}

/**
 * Goal: Forward-geocode a text query into candidate cities.
 * Why: Let users change the forecast location by name.
 * How: Call Open‑Meteo geocoding API, normalize fields used by the app, and
 *      return up to 10 results.
 */
export async function searchCities(query) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 3) return [];
  const base = 'https://geocoding-api.open-meteo.com/v1/search';
  const url = `${base}?name=${encodeURIComponent(trimmed)}&count=10&language=en&format=json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geocoding API error: ${response.status}`);
  const data = await response.json();
  const results = data?.results || [];
  return results.map(r => ({
    id: String(r.id ?? `${r.latitude},${r.longitude}`),
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    region: r.admin1 || '',
    country: r.country || '',
    timestamp: Date.now()
  }));
}

/**
 * Goal: Reverse-geocode coordinates into a human-readable place.
 * Why: Useful after geolocation to display city/region names.
 * How: Use BigDataCloud’s public endpoint and map fields to our standard shape.
 */
export async function reverseGeocode(latitude, longitude) {
  // Use BigDataCloud public reverse geocoding (CORS enabled, no key required)
  const base = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
  const url = `${base}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=en`;
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`Reverse geocoding error: ${response.status}`);
  const data = await response.json();
  const name = data.city || data.locality || data.principalSubdivision || data.localityInfo?.locality?.name || '';
  if (!name) return null;
  return {
    id: `${latitude},${longitude}`,
    name,
    latitude,
    longitude,
    region: data.principalSubdivision || '',
    country: data.countryName || data.countryCode || '',
    timestamp: Date.now()
  };
}

/**
 * Goal: Persist a location in the recents list.
 * Why: Quick access to previously viewed places.
 * How: De-duplicate by id/name, keep newest first, cap to MAX_RECENTS, store in
 *      localStorage.
 */
export function saveRecentLocation(location) {
  try {
    const recents = getRecentLocationsInternal();
    const targetName = normalizeName(location.name);
    const withoutDup = recents.filter(r => r.id !== location.id && normalizeName(r.name) !== targetName);
    const updated = [ { ...location, timestamp: Date.now() }, ...withoutDup ].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
  } catch (e) {
    // ignore storage errors
  }
}

/**
 * Goal: Read the recent locations list.
 * Why: Populate the recents dropdown in the UI.
 * How: Parse from localStorage and sanitize; return an empty list on errors.
 */
export function getRecentLocations() {
  try {
    return getRecentLocationsInternal();
  } catch (e) {
    return [];
  }
}

/**
 * Goal: Clear persisted recents.
 * Why: Give users control to reset their history.
 * How: Remove the localStorage key; ignore storage errors gracefully.
 */
export function clearRecentLocations() {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch (e) {
    // ignore
  }
}

function getRecentLocationsInternal() {
  const raw = localStorage.getItem(RECENTS_KEY);
  if (!raw) return [];
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) return [];
  // Sort newest first and ensure unique per name (case-insensitive)
  const sorted = [...arr].sort((a, b) => (Number(b.timestamp || 0) - Number(a.timestamp || 0)));
  const seen = new Set();
  const unique = [];
  for (const item of sorted) {
    const key = normalizeName(item.name);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
    if (unique.length >= MAX_RECENTS) break;
  }
  return unique;
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * Goal: Persist the last selected location.
 * Why: Restore the user’s context on the next visit.
 * How: Normalize and store a small object in localStorage under `LAST_KEY`.
 */
export function setLastLocation(location) {
  try {
    const payload = {
      id: String(location.id || `${location.latitude},${location.longitude}`),
      name: String(location.name || ''),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      region: String(location.region || ''),
      country: String(location.country || ''),
      timestamp: Date.now()
    };
    localStorage.setItem(LAST_KEY, JSON.stringify(payload));
  } catch (e) {
    // ignore
  }
}

/**
 * Goal: Retrieve the last selected location if available.
 * Why: Prefer continuity for returning users.
 * How: Parse from localStorage, validate shape and types, else return null.
 */
export function getLastLocation() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.latitude !== 'number' || typeof obj.longitude !== 'number') return null;
    return obj;
  } catch (e) {
    return null;
  }
}


