/*
  Weather 4 Bike – Weather icons

  Goal: Pick an icon file for a WMO weather code, day or night.

  Why: The icon pack does not cover every code, and a missing file used to
  render as a broken image. Each code gets an ordered list of files that exist;
  app.js tries them one at a time (wireIconFallbacks).

  Pure and DOM-free, so it is testable — including that every file named here
  is really in the pack.
*/

export const ICON_DIR = 'assets/icons/weather2/static';

export const ICON_BY_CODE = {
  0: 'sun',
  1: 'sun-cloud', 2: 'sun-cloud',
  3: 'cloud',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 80: 'rain', 81: 'rain', 82: 'rain',
  // This icon pack ships no sleet/freezing-rain glyph, so point the freezing
  // codes straight at the rain-snow mix rather than requesting a known 404.
  // Drop a `sleet.svg` into the pack and change these two lines to use it.
  66: 'snowy-4', 67: 'snowy-4',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow', 85: 'snow', 86: 'snow',
  95: 'storm', 96: 'storm', 99: 'storm'
};

const ICON_NIGHT = { sun: 'night', 'sun-cloud': 'cloudy-night-1', cloud: 'cloudy-night-2' };

/**
 * Fallbacks are exact file names that exist in the icon pack. The pack has no
 * `sleet.svg`, which is why freezing-rain codes used to render as a broken image.
 */
const ICON_FALLBACKS = {
  sun: ['sun-cloud', 'cloud'],
  'sun-cloud': ['cloudy-day-2', 'sun', 'cloud'],
  cloud: ['cloudy-day-3', 'sun-cloud'],
  fog: ['haze', 'cloud'],
  drizzle: ['rainy-4', 'rain', 'cloud'],
  rain: ['rain-2', 'rainy-2', 'drizzle', 'cloud'],
  'snowy-4': ['rainy-5', 'rain', 'cloud'],
  snow: ['snowy-1', 'snowy-2', 'snowy-4', 'cloud'],
  storm: ['rainy-3', 'rain', 'cloud'],
  night: ['cloudy-night-1', 'cloud'],
  'cloudy-night-1': ['cloudy-night-2', 'cloud'],
  'cloudy-night-2': ['cloudy-night-3', 'cloud']
};

export function iconCandidates(code, night = false) {
  const day = ICON_BY_CODE[code] || 'cloud';
  const base = night && ICON_NIGHT[day] ? ICON_NIGHT[day] : day;
  // Exact-key lookup. The old code used `baseName.includes(key)`, so 'sun-cloud'
  // matched the 'sun' entry first and inherited the wrong fallback list.
  const alts = ICON_FALLBACKS[base] || ICON_FALLBACKS[day] || ['cloud'];
  return [base, ...alts].map(n => `${ICON_DIR}/${n}.svg`);
}
