// Location handling: geolocation, geocoding search, and recent locations

const RECENTS_KEY = 'w4b_recent_locations_v1';
const MAX_RECENTS = 15;

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

export function getRecentLocations() {
  try {
    return getRecentLocationsInternal();
  } catch (e) {
    return [];
  }
}

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


