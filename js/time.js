/*
  Weather 4 Bike – Location time

  Goal: Show every time in the clock of the place being forecast, and compute
  "now" as a real instant rather than a wall-clock reading.

  Why: The forecast used to arrive as location-local strings with no offset
  ("2026-09-10T19:00"), which the browser parsed as *its own* local time. From
  California, Tel Aviv's "current conditions" were eleven hours stale — and the
  best window, rain timing and night icons were all shifted with it.

  How: The API now returns Unix timestamps, so every Date in the app is an exact
  instant and all the arithmetic in insights.js is correct as written. The
  location's IANA zone is applied only here, at the edge, when turning an
  instant into text.

  Pure and DOM-free, so it is testable under any process time zone.
*/

const DAY_MS = 86400000;

/**
 * An IANA zone Intl accepts, or undefined (meaning "the viewer's zone").
 * A bad or missing zone must degrade to something readable, never throw.
 */
export function safeTimeZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Unix seconds → ISO instant ("…Z"). Anything else → null. */
export function unixToIso(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/** The calendar date ("YYYY-MM-DD") of an instant, as seen in `timeZone`. */
export function localDateKey(value, timeZone) {
  const d = toDate(value);
  if (!d) return null;
  // en-CA formats as YYYY-MM-DD; formatToParts avoids relying on that.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "07:00 PM" — the instant's wall-clock time in `timeZone`. */
export function formatClock(value, timeZone, locale) {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: safeTimeZone(timeZone) });
}

/**
 * "" for today, "Tomorrow " for tomorrow, otherwise "Tue ".
 * "Today" means today *at the location*, not on the viewer's calendar.
 */
export function dayPrefix(value, now, timeZone, locale) {
  const d = toDate(value);
  if (!d) return '';
  const key = localDateKey(d, timeZone);
  if (key === localDateKey(now, timeZone)) return '';
  if (key === nextDateKey(localDateKey(now, timeZone))) return 'Tomorrow ';
  return `${d.toLocaleDateString(locale, { weekday: 'short', timeZone: safeTimeZone(timeZone) })} `;
}

/** "2026-09-10" → "2026-09-11". Pure calendar arithmetic, no zone involved. */
function nextDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Weekday of a calendar date ("2026-09-10" → "Thu").
 * A calendar date has no zone, so format it in UTC to stop it drifting a day.
 */
export function formatWeekday(dateKey, locale) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) return '';
  const [, y, m, d] = match.map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
}

/**
 * True when the instant falls outside every sunrise–sunset range.
 * Ranges are real instants, so this needs no zone at all — unlike the old
 * "minutes past midnight" comparison, which used the viewer's clock.
 */
export function isNight(value, daylightRanges) {
  const d = toDate(value);
  if (!d || !Array.isArray(daylightRanges) || !daylightRanges.length) return false;
  const t = d.getTime();
  return !daylightRanges.some(r => t >= r.sunrise.getTime() && t <= r.sunset.getTime());
}

/**
 * Goal: Say honestly how old the forecast on screen is.
 * Why: The label used to print the time the page *rendered*, so a cached or
 *      offline copy was presented as fresh.
 * How: Relative age needs no time zone, which matters on a page showing
 *      another place's clock. `stale` drives a visual warning.
 *
 * @param {number} fetchedAtMs - when the data left the API
 * @param {number} nowMs
 * @param {{offline?: boolean}} options - true when served as a fallback copy
 */
export function describeFreshness(fetchedAtMs, nowMs, options = {}) {
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) {
    return { text: '', stale: false };
  }
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60000));
  let age;
  if (minutes < 1) age = 'just now';
  else if (minutes < 60) age = `${minutes} min ago`;
  else if (minutes < 60 * 24) age = `${Math.floor(minutes / 60)} h ago`;
  else {
    const days = Math.floor(minutes / (60 * 24));
    age = `${days} day${days === 1 ? '' : 's'} ago`;
  }

  if (options.offline) {
    return { text: `Offline · forecast from ${age}`, stale: true };
  }
  return { text: `Updated ${age}`, stale: minutes >= 60 };
}
