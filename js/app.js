/*
  Weather 4 Bike – Application Orchestrator (UI Controller)

  Goal: Tie together location lookup, weather fetching, and riding insights into
  an interactive, accessible UI.

  Why: Centralising UI state and rendering keeps the flow from user action to
  data fetch to pixels easy to follow, and keeps the domain rules in insights.js
  free of DOM concerns.

  How:
  - A small `state` object; every state change re-renders through `renderAll`.
  - Pure-ish render functions per section, all reading from `state`.
  - All display formatting delegated to units.js, all judgement to insights.js.

  Note on Tailwind class names: colour classes are written as complete literal
  strings in the lookup tables below. Tailwind's scanner cannot see a class name
  that was assembled by string concatenation, so it would purge them.
*/

import { fetchWeatherData, fetchAirQuality, getDaylightRanges, clearWeatherCache, aqiCategory } from './weather.js';
import {
  getCurrentLocation, searchCities, saveRecentLocation, getRecentLocations,
  clearRecentLocations, reverseGeocode, setLastLocation, getLastLocation
} from './location.js';
import {
  DISCIPLINES, scoreCurrent, scoreHourlySeries, findBestWindow, findRainTiming,
  generateSafetyAlerts, generateRecommendations, scoreTier, scoreOutAndBack,
  comfortBand, DEFAULT_COMFORT_BAND
} from './insights.js';
import {
  formatTemp, formatSpeed, formatVisibility, formatPercent, formatPrecip,
  degToCardinal, temperatureComfort, windDescriptor, convertTemp, systemFor,
  describeHourConditions, hourConditionsSentence
} from './units.js';
import { formatClock as clockAt, dayPrefix, formatWeekday, isNight, describeFreshness } from './time.js';
import { createLatestGate, isAbort } from './net.js';

// One gate per kind of request: only the newest may change the screen.
const loadGate = createLatestGate();
const searchGate = createLatestGate();

const state = {
  activity: 'road',       // 'road' | 'gravel' | 'mtb'
  location: null,
  weather: null,
  airQuality: null,
  unitSystem: 'metric',   // 'metric' | 'imperial'
  theme: 'light',         // 'dark' | 'light' — the theme currently showing
  themeSource: 'system',  // 'system' | 'user' — whether the rider chose it
  rideHours: 2,           // how long the rider wants to be out
  routeBearing: null,     // compass bearing of the outbound leg, or null
  comfortBand: null,      // rider-calibrated [minC, maxC], or null for the default
  ridingSpeedKmh: null,   // rider-calibrated, or null for the discipline default
  loading: false,
  error: null
};

const UNITS_KEY = 'w4b:units';
const ACTIVITY_KEY = 'w4b:activity';
// Also read by the pre-paint inline script in index.html — keep both in sync.
const THEME_KEY = 'w4b:theme';
const RIDE_HOURS_KEY = 'w4b:rideHours';
const BEARING_KEY = 'w4b:routeBearing';
const COMFORT_KEY = 'w4b:comfortBand';
const SPEED_KEY = 'w4b:ridingSpeed';

/** Scoring options derived from rider preferences, passed into every scorer call. */
function scoringOptions() {
  return {
    comfortBand: state.comfortBand || undefined,
    ridingSpeedKmh: state.ridingSpeedKmh || undefined
  };
}

// --- Colour tables. Full literal class strings so Tailwind keeps them. ------

const TONE = {
  green: {
    badge: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200',
    bar: 'bg-green-400',
    border: 'border-green-300 dark:border-green-800',
    soft: 'bg-green-50 dark:bg-green-900/20'
  },
  yellow: {
    badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-200',
    bar: 'bg-yellow-400',
    border: 'border-yellow-300 dark:border-yellow-800',
    soft: 'bg-yellow-50 dark:bg-yellow-900/20'
  },
  orange: {
    badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200',
    bar: 'bg-orange-400',
    border: 'border-orange-300 dark:border-orange-800',
    soft: 'bg-orange-50 dark:bg-orange-900/20'
  },
  red: {
    badge: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200',
    bar: 'bg-red-400',
    border: 'border-red-300 dark:border-red-800',
    soft: 'bg-red-50 dark:bg-red-900/20'
  },
  gray: {
    badge: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
    bar: 'bg-gray-400',
    border: 'border-gray-300 dark:border-gray-700',
    soft: 'bg-gray-50 dark:bg-gray-800'
  }
};

const ACTIVITY_CARD_BG = {
  road: 'bg-gradient-to-r from-blue-50 to-blue-100 dark:from-gray-800 dark:to-gray-700',
  gravel: 'bg-gradient-to-r from-orange-50 to-orange-100 dark:from-gray-800 dark:to-gray-700',
  mtb: 'bg-gradient-to-r from-emerald-50 to-green-100 dark:from-gray-800 dark:to-gray-700'
};

const ACTIVITY_TAB_ACTIVE = {
  road: 'bg-blue-600 text-white',
  gravel: 'bg-orange-600 text-white',
  mtb: 'bg-green-600 text-white'
};
const TAB_INACTIVE = 'bg-white text-gray-700 dark:bg-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700';

const ACTIVITY_EMOJI = { road: '🚴🏼‍♂️', gravel: '🚴🏼', mtb: '🚵🏼‍♀️' };

function tone(key) {
  return TONE[key] || TONE.gray;
}

// --- Element handles --------------------------------------------------------

const el = {};
function cacheElements() {
  const ids = [
    'location-indicator', 'app-title', 'city-search', 'search-results', 'use-geolocation',
    'refresh-btn', 'recents-toggle', 'recents-list', 'current-conditions', 'current-summary',
    'current-updated', 'insights', 'insights-card', 'hourly-forecast', 'daily-forecast',
    'best-window', 'toast', 'error-banner', 'error-detail', 'error-retry',
    'mobile-menu-btn', 'header-controls', 'help-button', 'help-modal', 'help-overlay',
    'help-close', 'help-close-2', 'units-c', 'units-f', 'scenic-section', 'scenic-image',
    'scenic-credit', 'daily-temp-chart',
    'theme-toggle', 'theme-toggle-dark-icon', 'theme-toggle-light-icon',
    'ride-duration', 'route-bearing', 'route-wind', 'compare-btn', 'compare-results',
    'pref-temp-min', 'pref-temp-max', 'pref-speed', 'pref-reset', 'pref-hint'
  ];
  ids.forEach(id => { el[camel(id)] = document.getElementById(id); });
  el.activityButtons = ['activity-road', 'activity-gravel', 'activity-mtb']
    .map(id => document.getElementById(id))
    .filter(Boolean);
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

let searchActiveIndex = -1;
let searchOptions = [];
let lastFocusedBeforeModal = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  loadPreferences();
  bindUI();
  // The inline head script already put the class on <html> to avoid a flash;
  // this re-asserts it and syncs the toggle's icon and labels.
  applyTheme(state.theme, { persist: false, source: state.themeSource });
  updateUnitsToggleUI();
  updateActivityTabsUI();
  registerServiceWorker();
  initScenicImage();
  renderSkeletons();
  // The label is relative ("8 min ago"), so it has to keep counting.
  setInterval(renderFreshness, 60000);

  const untouched = loadGate.mark();
  try {
    const last = getLastLocation();
    if (last) {
      await loadWeather(last);
    } else {
      await loadCurrentPosition();
    }
  } catch {
    // Denied or timed out. A first-time visitor may have searched while the
    // permission prompt was up — their choice beats our default.
    if (untouched()) {
      setLocationIndicator('Using default location');
      await loadWeather({ name: 'San Francisco', latitude: 37.7749, longitude: -122.4194, region: 'CA', country: 'USA' });
    }
  }
  renderRecentsDropdown();
});

/**
 * Goal: Geolocate, then load the forecast there.
 * Why: A position fix can take ten seconds. If the rider picks a place in the
 *      meantime, arriving late must not drag them back.
 * Throws if geolocation fails, so each caller can choose its own fallback.
 */
async function loadCurrentPosition() {
  const untouched = loadGate.mark();
  setLocationIndicator('Locating…');
  const { latitude, longitude, accuracy } = await getCurrentLocation();
  const place = await safeReverse(latitude, longitude);
  if (!untouched()) return;
  await loadWeather(place || { name: 'Current location', latitude, longitude, region: '', country: '', accuracy });
}

function loadPreferences() {
  try {
    const stored = localStorage.getItem(UNITS_KEY);
    // Migrate the old 'C' / 'F' values, which only ever governed temperature.
    if (stored === 'metric' || stored === 'imperial') state.unitSystem = stored;
    else if (stored === 'F') state.unitSystem = 'imperial';
    else if (stored === 'C') state.unitSystem = 'metric';

    const activity = localStorage.getItem(ACTIVITY_KEY);
    if (activity && DISCIPLINES[activity]) state.activity = activity;

    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'light' || theme === 'dark') {
      state.theme = theme;
      state.themeSource = 'user';
    } else {
      state.theme = systemTheme();
      state.themeSource = 'system';
    }

    const hours = Number(localStorage.getItem(RIDE_HOURS_KEY));
    if (Number.isFinite(hours) && hours >= 1 && hours <= 6) state.rideHours = hours;

    const bearing = localStorage.getItem(BEARING_KEY);
    if (bearing !== null && bearing !== '') {
      const b = Number(bearing);
      if (Number.isFinite(b) && b >= 0 && b < 360) state.routeBearing = b;
    }

    const band = JSON.parse(localStorage.getItem(COMFORT_KEY) || 'null');
    // comfortBand() rejects anything malformed and hands back the default.
    if (Array.isArray(band)) {
      const resolved = comfortBand(band);
      state.comfortBand = resolved === DEFAULT_COMFORT_BAND ? null : resolved;
    }

    const speed = Number(localStorage.getItem(SPEED_KEY));
    if (Number.isFinite(speed) && speed >= 5 && speed <= 60) state.ridingSpeedKmh = speed;
  } catch {
    // Private mode or corrupt JSON — defaults are fine.
  }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function bindUI() {
  bindActivityTabs();
  bindSearch();
  bindRecents();
  bindUnits();
  bindTheme();
  bindPlanner();
  bindPreferences();
  bindCompare();
  bindHelpModal();

  el.useGeolocation?.addEventListener('click', async () => {
    try {
      await loadCurrentPosition();
    } catch {
      showToast('Could not access location. Please enable permissions.');
    }
  });

  el.refreshBtn?.addEventListener('click', async () => {
    if (!state.location) return;
    clearWeatherCache();
    const outcome = await loadWeather(state.location, { force: true });
    // Only claim a refresh that happened. On failure the error banner speaks.
    if (outcome === 'fresh') showToast('Forecast refreshed', 1500);
    else if (outcome === 'offline') showToast('Offline — showing the saved forecast', 2500);
  });

  el.errorRetry?.addEventListener('click', async () => {
    if (state.location) await loadWeather(state.location, { force: true });
  });

  el.mobileMenuBtn?.addEventListener('click', () => {
    if (!el.headerControls) return;
    const willShow = el.headerControls.classList.contains('hidden');
    el.headerControls.classList.toggle('hidden', !willShow);
    el.mobileMenuBtn.setAttribute('aria-expanded', String(willShow));
  });

  document.addEventListener('click', (e) => {
    if (el.searchResults && !el.searchResults.contains(e.target) && e.target !== el.citySearch) {
      closeSearchResults();
    }
    if (el.recentsList && !el.recentsList.contains(e.target) && e.target !== el.recentsToggle) {
      el.recentsList.classList.add('hidden');
      el.recentsToggle?.setAttribute('aria-expanded', 'false');
    }
  });
}

/** Tabs follow the WAI-ARIA roving-tabindex pattern: arrows move, Home/End jump. */
function bindActivityTabs() {
  el.activityButtons.forEach((btn, index) => {
    btn.addEventListener('click', () => selectActivity(btn.dataset.activity));
    btn.addEventListener('keydown', (e) => {
      let target = null;
      if (e.key === 'ArrowRight') target = el.activityButtons[(index + 1) % el.activityButtons.length];
      else if (e.key === 'ArrowLeft') target = el.activityButtons[(index - 1 + el.activityButtons.length) % el.activityButtons.length];
      else if (e.key === 'Home') target = el.activityButtons[0];
      else if (e.key === 'End') target = el.activityButtons[el.activityButtons.length - 1];
      if (!target) return;
      e.preventDefault();
      selectActivity(target.dataset.activity);
      target.focus();
    });
  });
}

function selectActivity(activity) {
  if (!DISCIPLINES[activity] || state.activity === activity) return;
  state.activity = activity;
  savePreference(ACTIVITY_KEY, activity);
  updateActivityTabsUI();
  renderInsights();
  renderBestWindow();
  renderRouteWind();
  renderHourly();
  // Default riding speed is per-discipline, so the calibration hint moves too.
  updatePreferencesUI();
}

function updateActivityTabsUI() {
  el.activityButtons.forEach(btn => {
    const active = btn.dataset.activity === state.activity;
    const activeClass = ACTIVITY_TAB_ACTIVE[btn.dataset.activity] || ACTIVITY_TAB_ACTIVE.road;
    btn.className = `px-4 py-2 font-medium focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 transition-colors ${active ? activeClass : TAB_INACTIVE}`;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
}

function bindUnits() {
  const set = (system) => {
    if (state.unitSystem === system) return;
    state.unitSystem = system;
    savePreference(UNITS_KEY, system);
    updateUnitsToggleUI();
    renderAll();
  };
  el.unitsC?.addEventListener('click', () => set('metric'));
  el.unitsF?.addEventListener('click', () => set('imperial'));
}

function updateUnitsToggleUI() {
  if (!el.unitsC || !el.unitsF) return;
  const base = 'px-3 py-2 text-sm transition-colors';
  const active = 'bg-blue-600 text-white font-semibold';
  const inactive = 'bg-white text-gray-700 dark:bg-gray-800 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700';
  const metric = state.unitSystem === 'metric';
  el.unitsC.className = `${base} ${metric ? active : inactive}`;
  el.unitsF.className = `${base} ${metric ? inactive : active}`;
  el.unitsC.setAttribute('aria-pressed', String(metric));
  el.unitsF.setAttribute('aria-pressed', String(!metric));
}

// --- Theme -------------------------------------------------------------------

/** What the operating system is currently asking for. */
function systemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Goal: Show the OS theme by default, and let the rider override it.
 * Why: Following the system is the right default — someone who has set their
 *      whole machine to light should not be handed a dark app. But it is a poor
 *      mandate: outdoors the right theme depends on glare, not on the OS.
 * How: Toggle a `dark` class on <html> (Tailwind runs `darkMode: 'class'`).
 *      Only an explicit toggle writes THEME_KEY; until then nothing is stored
 *      and the pre-paint script in index.html falls back to the media query.
 */
function applyTheme(theme, { persist = true, source = 'user' } = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  state.theme = next;
  state.themeSource = source;
  document.documentElement.classList.toggle('dark', next === 'dark');

  // Keep the address-bar / task-switcher colour in step with the app.
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'dark' ? '#111827' : '#2563eb');

  updateThemeToggleUI();
  if (persist) savePreference(THEME_KEY, next);
}

function updateThemeToggleUI() {
  const dark = state.theme === 'dark';
  // Show the sun while dark (click to go light), and the moon while light.
  el.themeToggleLightIcon?.classList.toggle('hidden', !dark);
  el.themeToggleDarkIcon?.classList.toggle('hidden', dark);
  el.themeToggle?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  el.themeToggle?.setAttribute('aria-pressed', String(dark));
  el.themeToggle?.setAttribute(
    'title',
    state.themeSource === 'system'
      ? 'Following your system theme — click to override'
      : 'Toggle dark/light mode'
  );
}

function bindTheme() {
  el.themeToggle?.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    // No re-render needed: the SVG chart inherits currentColor, unlike the
    // Chart.js canvas it replaced, which baked its label colour in at build time.
    showToast(state.theme === 'dark' ? 'Dark mode' : 'Light mode', 1200);
  });

  // Track the OS while the rider has not overridden it, so flipping the system
  // theme updates a page that is already open.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (state.themeSource !== 'system') return;
      applyTheme(e.matches ? 'dark' : 'light', { persist: false, source: 'system' });
    });
  } catch {
    // Safari < 14 has no addEventListener on MediaQueryList; static default is fine.
  }
}

// --- Planner controls (ride length, route direction) ------------------------

function bindPlanner() {
  if (el.rideDuration) {
    el.rideDuration.value = String(state.rideHours);
    el.rideDuration.addEventListener('change', () => {
      const hours = Number(el.rideDuration.value);
      if (!Number.isFinite(hours)) return;
      state.rideHours = hours;
      savePreference(RIDE_HOURS_KEY, String(hours));
      renderBestWindow();
    });
  }

  if (el.routeBearing) {
    el.routeBearing.value = state.routeBearing === null ? '' : String(state.routeBearing);
    el.routeBearing.addEventListener('change', () => {
      const raw = el.routeBearing.value;
      state.routeBearing = raw === '' ? null : Number(raw);
      savePreference(BEARING_KEY, raw);
      renderRouteWind();
    });
  }
}

// --- Rider calibration ------------------------------------------------------

function bindPreferences() {
  const commitBand = () => {
    const sys = state.unitSystem;
    // The inputs are in the rider's own unit; the scorer works in Celsius.
    const lo = toCelsius(Number(el.prefTempMin.value), sys);
    const hi = toCelsius(Number(el.prefTempMax.value), sys);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      updatePreferencesUI('Enter a range with the lower number first.');
      return;
    }
    state.comfortBand = comfortBand([lo, hi]);
    savePreference(COMFORT_KEY, JSON.stringify(state.comfortBand));
    updatePreferencesUI();
    renderAll();
  };

  el.prefTempMin?.addEventListener('change', commitBand);
  el.prefTempMax?.addEventListener('change', commitBand);

  el.prefSpeed?.addEventListener('change', () => {
    const shown = Number(el.prefSpeed.value);
    // Stored in km/h regardless of what the rider is shown.
    const kmh = state.unitSystem === 'imperial' ? shown / 0.621371 : shown;
    state.ridingSpeedKmh = Number.isFinite(kmh) && kmh >= 5 && kmh <= 60 ? Math.round(kmh) : null;
    if (state.ridingSpeedKmh) savePreference(SPEED_KEY, String(state.ridingSpeedKmh));
    updatePreferencesUI();
    renderAll();
  });

  el.prefReset?.addEventListener('click', () => {
    state.comfortBand = null;
    state.ridingSpeedKmh = null;
    try {
      localStorage.removeItem(COMFORT_KEY);
      localStorage.removeItem(SPEED_KEY);
    } catch { /* ignore */ }
    updatePreferencesUI();
    renderAll();
  });

  updatePreferencesUI();
}

function toCelsius(value, systemKey) {
  if (!Number.isFinite(value)) return NaN;
  return systemKey === 'imperial' ? (value - 32) * 5 / 9 : value;
}

/** Reflect stored preferences into the inputs, in the rider's current units. */
function updatePreferencesUI(message) {
  const sys = state.unitSystem;
  const band = state.comfortBand || DEFAULT_COMFORT_BAND;
  const speed = state.ridingSpeedKmh || DISCIPLINES[state.activity].ridingSpeedKmh;

  if (el.prefTempMin) el.prefTempMin.value = String(Math.round(convertTemp(band[0], sys)));
  if (el.prefTempMax) el.prefTempMax.value = String(Math.round(convertTemp(band[1], sys)));
  if (el.prefSpeed) {
    el.prefSpeed.value = String(Math.round(sys === 'imperial' ? speed * 0.621371 : speed));
  }

  if (el.prefHint) {
    const unit = systemFor(sys);
    el.prefHint.textContent = message || (
      state.comfortBand || state.ridingSpeedKmh
        ? `Using your settings. Speed in ${unit.speed}, temperature in ${unit.temp}.`
        : `Using defaults for ${DISCIPLINES[state.activity].label}. Speed in ${unit.speed}, temperature in ${unit.temp}.`
    );
  }
}

// --- Compare locations ------------------------------------------------------

function bindCompare() {
  el.compareBtn?.addEventListener('click', () => runComparison());
}

/**
 * Goal: Answer "is it better an hour up the road?".
 * Why: Riders who travel to ride already have their spots saved; scoring them
 *      side by side turns the recents list into a decision tool.
 * How: Fetch each recent location (served from cache when warm) and score it
 *      for the selected discipline. Failures are reported per row, never fatal.
 */
async function runComparison() {
  if (!el.compareResults) return;
  const others = getRecentLocations()
    .filter(r => !state.location || `${r.latitude},${r.longitude}` !== `${state.location.latitude},${state.location.longitude}`)
    .slice(0, 4);

  if (!others.length) {
    el.compareResults.innerHTML = '<p>No other saved locations yet. Search for a city or two, then come back.</p>';
    return;
  }

  el.compareBtn.disabled = true;
  el.compareResults.innerHTML = skeletonBlock('h-24');

  const places = state.location ? [state.location, ...others] : others;
  const rows = await Promise.all(places.map(async (place) => {
    try {
      const weather = await fetchWeatherData(place.latitude, place.longitude);
      const result = scoreCurrent(weather, state.activity, scoringOptions());
      return { place, result };
    } catch (e) {
      return { place, error: e };
    }
  }));

  const scored = rows.filter(r => r.result).sort((a, b) => b.result.score - a.result.score);
  const failed = rows.filter(r => r.error);

  el.compareBtn.disabled = false;
  el.compareResults.innerHTML = `
    <ul class="space-y-2">
      ${scored.map((row, i) => {
        const t = tone(row.result.tier.tone);
        const isCurrent = state.location && row.place.name === state.location.name;
        return `<li class="flex items-center justify-between gap-3 rounded-lg border ${t.border} ${t.soft} px-3 py-2">
          <div class="min-w-0">
            <div class="font-medium truncate">${i === 0 ? '🏆 ' : ''}${escapeHtml(row.place.name)}${isCurrent ? ' <span class="text-xs text-gray-500 dark:text-gray-400">(current)</span>' : ''}</div>
            <div class="text-xs text-gray-600 dark:text-gray-300 truncate">${escapeHtml(row.result.message)}</div>
          </div>
          <span class="shrink-0 inline-flex items-center gap-1 ${t.badge} px-2.5 py-1 rounded-full text-sm font-medium">${row.result.tier.emoji} ${row.result.score}/10</span>
        </li>`;
      }).join('')}
      ${failed.map(row => `<li class="rounded-lg border ${TONE.gray.border} px-3 py-2 text-xs text-gray-500 dark:text-gray-400">${escapeHtml(row.place.name)}: forecast unavailable</li>`).join('')}
    </ul>
    <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Scored for ${escapeHtml(DISCIPLINES[state.activity].label)}, current conditions.</p>`;
}

// --- Search combobox --------------------------------------------------------

function bindSearch() {
  if (!el.citySearch) return;
  el.citySearch.addEventListener('input', debounce(onSearchChanged, 300));
  el.citySearch.addEventListener('focus', () => {
    if (searchOptions.length) openSearchResults();
  });
  el.citySearch.addEventListener('keydown', onSearchKeydown);
}

/**
 * Goal: Full keyboard operation of the city picker.
 * Why: Previously the results were plain divs with click handlers only — a
 *      keyboard or screen-reader user could type a city but never choose one.
 */
function onSearchKeydown(e) {
  const open = el.searchResults && !el.searchResults.classList.contains('hidden');
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (!open && searchOptions.length) openSearchResults();
      moveSearchActive(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveSearchActive(-1);
      break;
    case 'Enter':
      if (open && searchActiveIndex >= 0 && searchOptions[searchActiveIndex]) {
        e.preventDefault();
        chooseCity(searchOptions[searchActiveIndex]);
      }
      break;
    case 'Escape':
      closeSearchResults();
      break;
    case 'Tab':
      closeSearchResults();
      break;
    default:
      break;
  }
}

function moveSearchActive(delta) {
  if (!searchOptions.length) return;
  searchActiveIndex = (searchActiveIndex + delta + searchOptions.length) % searchOptions.length;
  const items = el.searchResults.querySelectorAll('[role="option"]');
  items.forEach((item, i) => {
    const active = i === searchActiveIndex;
    item.setAttribute('aria-selected', String(active));
    item.classList.toggle('bg-gray-100', active);
    item.classList.toggle('dark:bg-gray-700', active);
    if (active) {
      el.citySearch.setAttribute('aria-activedescendant', item.id);
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

function openSearchResults() {
  el.searchResults.classList.remove('hidden');
  el.citySearch.setAttribute('aria-expanded', 'true');
}

function closeSearchResults() {
  el.searchResults?.classList.add('hidden');
  el.citySearch?.setAttribute('aria-expanded', 'false');
  el.citySearch?.removeAttribute('aria-activedescendant');
  searchActiveIndex = -1;
}

async function onSearchChanged() {
  // Begin before the length check, so clearing the box also cancels a query in
  // flight — otherwise its results could reopen the list after you emptied it.
  const ticket = searchGate.begin();
  const q = el.citySearch.value.trim();
  if (q.length < 3) {
    searchOptions = [];
    closeSearchResults();
    el.searchResults.innerHTML = '';
    return;
  }
  try {
    const results = await searchCities(q, { signal: ticket.signal });
    // "Par" must not overwrite "Paris" just because it came back second.
    if (!ticket.isCurrent()) return;
    searchOptions = results;
    renderSearchResults(searchOptions);
  } catch {
    if (!ticket.isCurrent()) return;
    searchOptions = [];
    closeSearchResults();
  }
}

function renderSearchResults(cities) {
  el.searchResults.innerHTML = '';
  searchActiveIndex = -1;
  if (!cities.length) {
    closeSearchResults();
    return;
  }
  cities.forEach((city, i) => {
    const li = document.createElement('li');
    li.id = `city-option-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.className = 'cursor-pointer px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700';
    li.innerHTML = `
      <div class="font-medium">${escapeHtml(city.name)}</div>
      <div class="text-sm text-gray-500 dark:text-gray-400">${escapeHtml(locationSubtitle(city))}</div>
    `;
    li.addEventListener('click', () => chooseCity(city));
    el.searchResults.appendChild(li);
  });
  openSearchResults();
}

async function chooseCity(city) {
  searchGate.begin(); // a query still in flight must not reopen the list
  closeSearchResults();
  el.citySearch.value = city.name;
  await loadWeather(city);
}

function locationSubtitle(loc) {
  const parts = [loc.region, loc.country].filter(Boolean);
  const coords = `${Number(loc.latitude).toFixed(2)}, ${Number(loc.longitude).toFixed(2)}`;
  return parts.length ? `${parts.join(', ')} · ${coords}` : coords;
}

// --- Recents ----------------------------------------------------------------

function bindRecents() {
  el.recentsToggle?.addEventListener('click', () => {
    renderRecentsDropdown();
    const willShow = el.recentsList.classList.contains('hidden');
    el.recentsList.classList.toggle('hidden', !willShow);
    el.recentsToggle.setAttribute('aria-expanded', String(willShow));
  });
}

function renderRecentsDropdown() {
  if (!el.recentsList) return;
  const recents = getRecentLocations();
  el.recentsList.innerHTML = '';

  if (!recents.length) {
    const empty = document.createElement('div');
    empty.className = 'px-3 py-2 text-sm text-gray-500 dark:text-gray-400';
    empty.textContent = 'No recent locations';
    el.recentsList.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700';
  header.innerHTML = '<div class="text-sm font-medium">Recent</div>';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'text-xs text-red-600 hover:underline';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => { clearRecentLocations(); renderRecentsDropdown(); });
  header.appendChild(clearBtn);
  el.recentsList.appendChild(header);

  recents.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700';
    btn.innerHTML = `
      <div class="font-medium">${escapeHtml(r.name)}</div>
      <div class="text-sm text-gray-500 dark:text-gray-400">${escapeHtml(locationSubtitle(r))}</div>
    `;
    btn.addEventListener('click', async () => {
      el.recentsList.classList.add('hidden');
      el.recentsToggle?.setAttribute('aria-expanded', 'false');
      await loadWeather(r);
    });
    el.recentsList.appendChild(btn);
  });
}

// --- Help modal, with a focus trap -----------------------------------------

function bindHelpModal() {
  const open = () => {
    if (!el.helpModal) return;
    lastFocusedBeforeModal = document.activeElement;
    el.helpModal.classList.remove('hidden');
    el.helpButton?.setAttribute('aria-expanded', 'true');
    el.helpClose?.focus();
    document.addEventListener('keydown', onModalKeydown);
  };
  const close = () => {
    if (!el.helpModal) return;
    el.helpModal.classList.add('hidden');
    el.helpButton?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onModalKeydown);
    if (lastFocusedBeforeModal instanceof HTMLElement) lastFocusedBeforeModal.focus();
  };

  function onModalKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Trap focus inside the dialog while it is open.
    const focusables = el.helpModal.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  el.helpButton?.addEventListener('click', open);
  el.helpOverlay?.addEventListener('click', close);
  el.helpClose?.addEventListener('click', close);
  el.helpClose2?.addEventListener('click', close);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Goal: Fetch weather (and air quality) for a location and refresh every view.
 * Why: Single entry point shared by search, recents, geolocation and refresh.
 * How: Show skeletons, fetch, persist the choice, render. On failure show an
 *      inline error with a retry action rather than leaving a blank page.
 *      Every step after an await checks its ticket: if the rider has moved on,
 *      a late answer is dropped — not rendered, not saved as their location.
 *
 * @returns {Promise<'fresh'|'offline'|'error'|'superseded'>}
 */
async function loadWeather(location, options = {}) {
  const ticket = loadGate.begin();
  state.location = location;
  state.loading = true;
  state.error = null;
  hideErrorBanner();
  setLocationIndicator(formatLocationName(location));
  renderSkeletons();

  try {
    const weather = await fetchWeatherData(location.latitude, location.longitude, { ...options, signal: ticket.signal });
    if (!ticket.isCurrent()) return 'superseded';
    state.weather = weather;
    // The previous place's AQI must not sit beside this place's forecast.
    state.airQuality = null;

    saveRecentLocation({
      id: `${location.latitude},${location.longitude}`,
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      region: location.region || '',
      country: location.country || '',
      timestamp: Date.now()
    });
    setLastLocation(location);

    state.loading = false;
    renderAll();

    // Air quality is a bonus: fetch after the main render so it never delays it.
    fetchAirQuality(location.latitude, location.longitude, { ...options, signal: ticket.signal }).then(air => {
      if (!ticket.isCurrent()) return;
      state.airQuality = air;
      if (state.weather) state.weather.airQuality = air;
      renderCurrent();
      renderInsights();
    });
    return weather.offline ? 'offline' : 'fresh';
  } catch (e) {
    // Superseded requests are aborted on purpose; that is not an error to show.
    if (!ticket.isCurrent() || isAbort(e)) return 'superseded';
    state.loading = false;
    state.error = e;
    showErrorBanner(e);
    return 'error';
  }
}

function showErrorBanner(error) {
  if (!el.errorBanner) return;
  el.errorBanner.classList.remove('hidden');
  if (el.errorDetail) {
    el.errorDetail.textContent = navigator.onLine === false
      ? 'You appear to be offline. Reconnect and try again.'
      : `${error?.message || 'Unknown error'}`;
  }
  clearSkeletons();
}

function hideErrorBanner() {
  el.errorBanner?.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderCurrent();
  renderBestWindow();
  renderRouteWind();
  renderInsights();
  renderHourly();
  renderDaily();
  renderDailyTempChart();
  renderRecentsDropdown();
  wireIconFallbacks(document.body);
}

function skeletonBlock(classes) {
  return `<div class="animate-pulse rounded-md bg-gray-200 dark:bg-gray-700 ${classes}"></div>`;
}

/** Show shaped placeholders instead of an empty page while the forecast loads. */
function renderSkeletons() {
  if (el.currentSummary) el.currentSummary.innerHTML = skeletonBlock('h-14 w-56 mb-2') + skeletonBlock('h-4 w-72');
  if (el.currentConditions) {
    el.currentConditions.innerHTML = Array.from({ length: 8 })
      .map(() => skeletonBlock('h-[68px]')).join('');
  }
  if (el.bestWindow) el.bestWindow.innerHTML = skeletonBlock('h-20');
  if (el.routeWind) el.routeWind.innerHTML = '';
  if (el.insights) el.insights.innerHTML = skeletonBlock('h-40');
  if (el.hourlyForecast) {
    el.hourlyForecast.innerHTML = Array.from({ length: 8 })
      .map(() => skeletonBlock('min-w-[92px] h-[132px]')).join('');
  }
  if (el.dailyForecast) {
    el.dailyForecast.innerHTML = Array.from({ length: 7 })
      .map(() => skeletonBlock('h-[104px]')).join('');
  }
}

function clearSkeletons() {
  [el.currentSummary, el.currentConditions, el.bestWindow, el.insights, el.hourlyForecast, el.dailyForecast]
    .forEach(node => { if (node && node.querySelector('.animate-pulse')) node.innerHTML = ''; });
}

// --- Current conditions -----------------------------------------------------

function renderCurrent() {
  const c = state.weather?.current;
  if (!c || !el.currentConditions) return;
  const sys = state.unitSystem;

  const feelsDiffers = c.apparentTemperature != null && c.temperature != null
    && Math.abs(Number(c.apparentTemperature) - Number(c.temperature)) >= 1;

  el.currentSummary.innerHTML = `
    <div class="flex items-end gap-3 flex-wrap">
      <div class="text-5xl font-bold">${formatTemp(c.temperature, sys)}</div>
      <div class="text-lg text-gray-600 dark:text-gray-300">${escapeHtml(c.weatherText || '')}</div>
    </div>
    <div class="text-sm text-gray-500 dark:text-gray-400 mt-1">
      ${feelsDiffers ? `Feels like ${formatTemp(c.apparentTemperature, sys)} · ` : ''}Wind ${formatSpeed(c.windSpeed, sys)} ${degToCardinal(c.windDirection)}${sunLine()}
    </div>
  `;

  renderFreshness();

  const gustText = c.windGusts != null ? ` (gusts ${formatSpeed(c.windGusts, sys)})` : '';
  const air = state.airQuality;

  const items = [
    { label: 'Temp', value: formatTemp(c.temperature, sys), icon: 'temp', title: 'Air temperature' },
    { label: 'Feels like', value: formatTemp(c.apparentTemperature ?? c.temperature, sys), icon: 'thermo', title: 'Apparent temperature, accounting for wind and humidity' },
    { label: 'Wind', value: `${formatSpeed(c.windSpeed, sys)}${gustText}`, icon: 'wind', title: 'Wind speed at 10 m, with gusts' },
    { label: 'UV', value: c.uvIndex == null ? '—' : String(Math.round(c.uvIndex)), icon: 'uv', title: 'UV index' },
    { label: 'Precip', value: `${formatPercent(c.precipitationProbability)}${Number(c.precipitation) > 0 ? ` · ${formatPrecip(c.precipitation, sys)}` : ''}`, icon: 'humidity', title: 'Chance of precipitation, and current rate' },
    { label: 'Humidity', value: formatPercent(c.humidity), icon: 'humidity', title: 'Relative humidity' },
    { label: 'Visibility', value: formatVisibility(c.visibility, sys), icon: 'visibility', title: 'Visibility' },
    air
      ? { label: 'Air quality', value: `${Math.round(air.aqi)} · ${air.category.label}`, icon: 'air', title: `${air.scale}${air.pm25 != null ? ` · PM2.5 ${air.pm25} µg/m³` : ''}` }
      : { label: 'Cloud', value: formatPercent(c.cloudCover), icon: 'cloud', title: 'Cloud cover' }
  ];

  el.currentConditions.innerHTML = items.map(it => `
    <div class="rounded-md bg-white/70 dark:bg-gray-700 p-3" title="${escapeAttr(it.title)}">
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-300">${icon(it.icon)}<span>${escapeHtml(it.label)}</span></div>
      <div class="text-lg font-semibold">${escapeHtml(it.value)}</div>
    </div>
  `).join('');
}

const FRESHNESS_OK = 'text-xs text-gray-500 dark:text-gray-400';
const FRESHNESS_STALE = 'text-xs font-medium text-amber-700 dark:text-amber-300';

/** How old the data really is — never the time the page happened to render. */
function renderFreshness() {
  if (!el.currentUpdated || !state.weather) return;
  const { text, stale } = describeFreshness(state.weather.fetchedAt, Date.now(), { offline: state.weather.offline });
  el.currentUpdated.textContent = text;
  el.currentUpdated.className = stale ? FRESHNESS_STALE : FRESHNESS_OK;
}

function sunLine() {
  const today = state.weather?.today;
  if (!today?.sunrise || !today?.sunset) return '';
  return ` · ☀ ${formatClock(today.sunrise)} – ${formatClock(today.sunset)}`;
}

// --- Best window ------------------------------------------------------------

/**
 * Goal: Answer the question the app exists to answer — when to go out.
 * Why: The forecast holds 168 hours; judging only "now" wastes all of it.
 */
function renderBestWindow() {
  if (!el.bestWindow || !state.weather) return;

  const hours = state.rideHours;
  // Score the whole week so the same series answers both "today" and "this week".
  const scored = scoreHourlySeries(state.weather, state.activity, { hours: 168, ...scoringOptions() });
  const daylight = getDaylightRanges(state.weather);
  const dl = daylight.length ? daylight : null;

  const search = { daylight: dl, minHours: hours, maxHours: hours };
  const best = findBestWindow(scored, { ...search, withinHours: 24 });
  const week = findBestWindow(scored, { ...search, withinHours: 168 });
  const rain = findRainTiming(state.weather.hourly, { hours: 24 });

  // Only worth showing the week separately if it beats today by a real margin.
  const weekIsBetter = week && (!best || week.score >= best.score + 0.5);

  const rainLine = (() => {
    if (!rain) return '';
    if (rain.state === 'wet') {
      return rain.clearsAt
        ? `<span class="inline-flex items-center gap-1">🌧 Wet now, clearing around <strong>${formatClock(rain.clearsAt)}</strong></span>`
        : '<span class="inline-flex items-center gap-1">🌧 Wet for the next 24 hours</span>';
    }
    return rain.startsAt
      ? `<span class="inline-flex items-center gap-1">🌤 Dry until <strong>${formatClock(rain.startsAt)}</strong></span>`
      : '<span class="inline-flex items-center gap-1">🌤 Dry for the next 24 hours</span>';
  })();

  const weekCard = weekIsBetter ? `
    <div class="mt-3 rounded-lg border ${tone(week.tier.tone).border} ${tone(week.tier.tone).soft} p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="text-sm text-gray-600 dark:text-gray-300">Better later this week</div>
          <div class="text-lg font-semibold">${formatDayPrefix(week.start)}${formatClock(week.start)} – ${formatClock(week.end)}</div>
        </div>
        <span class="inline-flex items-center gap-2 ${tone(week.tier.tone).badge} px-3 py-1 rounded-full text-sm font-medium">
          ${week.tier.emoji} ${week.score}/10 · ${escapeHtml(week.tier.label)}
        </span>
      </div>
    </div>` : '';

  if (!best) {
    el.bestWindow.innerHTML = `
      <div class="rounded-lg border ${TONE.gray.border} ${TONE.gray.soft} p-4">
        <div class="font-medium">No ${hours}-hour window in the next 24 hours of daylight.</div>
        <div class="text-sm text-gray-600 dark:text-gray-300 mt-1">${week ? 'There is one later in the week.' : 'Try a shorter ride, or plan an indoor session.'}</div>
        <div class="text-sm text-gray-600 dark:text-gray-300 mt-2">${rainLine}</div>
      </div>
      ${week ? weekCard : ''}`;
    rideChart = null;
    return;
  }

  const t = tone(best.tier.tone);
  const chartHours = scored.slice(0, 24);
  const sparkline = renderSparkline(chartHours, best);

  el.bestWindow.innerHTML = `
    <div class="rounded-lg border ${t.border} ${t.soft} p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm text-gray-600 dark:text-gray-300">Best ${best.hours}-hour window for ${escapeHtml(DISCIPLINES[state.activity].label)}</div>
          <div class="text-2xl font-bold mt-0.5">${formatDayPrefix(best.start)}${formatClock(best.start)} – ${formatClock(best.end)}</div>
          <div class="text-sm text-gray-600 dark:text-gray-300 mt-1">${rainLine}</div>
        </div>
        <div class="inline-flex items-center gap-2 ${t.badge} px-3 py-1.5 rounded-full font-medium">
          ${best.tier.emoji} <span>${best.score}/10 · ${escapeHtml(best.tier.label)}</span>
        </div>
      </div>
      ${sparkline}
    </div>
    ${weekCard}`;

  // A keyboard user starts on the first hour of the recommended window.
  wireRideChart(chartHours, chartHours.findIndex(h => h.date.getTime() === best.start.getTime()));
}

// --- Route-aware wind -------------------------------------------------------

/**
 * Goal: Tell the rider which way to set off.
 * Why: On a windy day this is the most actionable thing the app can say, and
 *      the scorer has supported head/tailwind all along with nothing feeding it.
 */
function renderRouteWind() {
  if (!el.routeWind) return;
  if (state.routeBearing === null || !state.weather) {
    el.routeWind.innerHTML = '';
    return;
  }

  const legs = scoreOutAndBack(state.weather, state.activity, state.routeBearing, scoringOptions());
  if (!legs) {
    el.routeWind.innerHTML = '';
    return;
  }

  const sys = state.unitSystem;
  const c = state.weather.current;
  const leg = (label, heading, result) => {
    const t = tone(result.tier.tone);
    return `<div class="flex-1 min-w-[140px] rounded-lg border ${t.border} ${t.soft} px-3 py-2">
      <div class="text-xs text-gray-600 dark:text-gray-300">${label} · ${escapeHtml(degToCardinal(heading))}</div>
      <div class="flex items-center justify-between gap-2 mt-0.5">
        <span class="font-semibold capitalize">${escapeHtml(result.relation)}</span>
        <span class="inline-flex items-center gap-1 ${t.badge} px-2 py-0.5 rounded-full text-sm font-medium">${result.score}/10</span>
      </div>
    </div>`;
  };

  el.routeWind.innerHTML = `
    <div class="rounded-lg border ${TONE.gray.border} p-3">
      <div class="text-sm font-medium mb-2">Route wind — ${formatSpeed(c.windSpeed, sys)} from ${escapeHtml(degToCardinal(c.windDirection))}</div>
      <div class="flex flex-wrap gap-2">
        ${leg('Out', state.routeBearing, legs.out)}
        ${leg('Back', (state.routeBearing + 180) % 360, legs.back)}
      </div>
      <div class="text-sm text-gray-600 dark:text-gray-300 mt-2">${escapeHtml(legs.advice)}</div>
    </div>`;
}

/**
 * A 24-bar strip: height and colour both encode the hourly rideability score.
 * It is also a slider over the hours — see `wireRideChart` for the tooltip.
 */
function renderSparkline(scoredHours, highlight = null) {
  if (!scoredHours.length) return '';
  const from = highlight ? highlight.start.getTime() : null;
  const to = highlight ? highlight.end.getTime() : null;

  const bars = scoredHours.map(h => {
    const t = tone(h.tier.tone);
    const height = Math.max(8, Math.round((h.score / 10) * 40));
    // Mark the hours the recommendation actually covers, so the headline and
    // the strip visibly agree.
    const inWindow = from !== null && h.date.getTime() >= from && h.date.getTime() < to;
    // Full-height column, so the hovered hour can be highlighted behind its bar.
    return `<div class="flex-1 h-full flex flex-col justify-end items-center rounded-sm">
      <div class="${t.bar} w-full rounded-sm${inWindow ? ' ring-2 ring-blue-500' : ''}" style="height:${height}px"></div>
    </div>`;
  }).join('');

  const first = scoredHours[0];
  const mid = scoredHours[Math.floor(scoredHours.length / 2)];
  const last = scoredHours[scoredHours.length - 1];

  return `
    <div class="relative mt-3" data-ride-chart>
      <div role="slider" tabindex="0"
           aria-label="Rideability by hour, next ${scoredHours.length} hours"
           aria-valuemin="0" aria-valuemax="${scoredHours.length - 1}" aria-valuenow="0"
           class="flex items-end gap-[2px] h-[44px] cursor-crosshair select-none touch-pan-y rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800">${bars}</div>
      <div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 mt-1" aria-hidden="true">
        <span>${formatClock(first.date)}</span><span>${formatClock(mid.date)}</span><span>${formatClock(last.date)}</span>
      </div>
      <div data-ride-tip hidden aria-hidden="true" class="${RIDE_TIP}"></div>
    </div>`;
}

// --- Ride chart tooltip -----------------------------------------------------

const RIDE_TIP = 'absolute bottom-full mb-2 z-20 w-max max-w-[16rem] pointer-events-none rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-xs leading-5 text-gray-800 dark:text-gray-100 shadow-lg';
// A column behind the bar under the cursor, so you can see which hour you are on.
const RIDE_BAR_ACTIVE = ['bg-gray-900/10', 'dark:bg-white/20'];

// The chart currently on screen. Replaced on every render of the best window.
let rideChart = null;

/**
 * Goal: Show one hour's conditions on the ride chart, however you point at it.
 * Why: The bars say *how* rideable each hour is; the tooltip says what the
 *      weather actually is then. A `title` attribute did neither on a phone.
 * How: One pointer model for all inputs. A mouse hovers to preview; a tap or
 *      click pins; a drag scrubs through the hours (pointer capture keeps it
 *      tracking off the edge, and `touch-action: pan-y` leaves vertical
 *      scrolling to the page). Arrow keys and Home/End move it too. Escape, or
 *      pressing anywhere else, dismisses it.
 *
 * @param {object[]} scoredHours - the hours the chart was drawn from, in order
 * @param {number} keyboardStart - index a keyboard user starts from
 */
function wireRideChart(scoredHours, keyboardStart = 0) {
  const wrap = el.bestWindow?.querySelector('[data-ride-chart]');
  if (!wrap) {
    rideChart = null;
    return;
  }

  const slider = wrap.querySelector('[role="slider"]');
  const chart = {
    wrap,
    slider,
    tip: wrap.querySelector('[data-ride-tip]'),
    bars: [...slider.children],
    hours: scoredHours,
    index: Math.max(0, keyboardStart),
    pinned: false,
    dragging: false
  };
  rideChart = chart;
  updateRideSlider(chart, chart.index);

  const indexAt = clientX => {
    const r = slider.getBoundingClientRect();
    const i = Math.floor(((clientX - r.left) / r.width) * chart.bars.length);
    return Math.min(chart.bars.length - 1, Math.max(0, i));
  };

  slider.addEventListener('pointerdown', e => {
    chart.pinned = true;
    chart.dragging = true;
    showRideHour(chart, indexAt(e.clientX));
    // Capture keeps a drag tracking past the chart's edge. It is a nicety:
    // it throws for a pointer that is no longer active, and the tap must
    // still have shown its hour.
    try {
      slider.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });
  slider.addEventListener('pointermove', e => {
    // Mouse hover previews; any pointer that is pressed down scrubs.
    if (chart.dragging || (e.pointerType === 'mouse' && !chart.pinned)) {
      showRideHour(chart, indexAt(e.clientX));
    }
  });
  const endDrag = () => { chart.dragging = false; };
  slider.addEventListener('pointerup', endDrag);
  // Fired when a touch turns into a vertical page scroll: stop scrubbing.
  slider.addEventListener('pointercancel', endDrag);
  slider.addEventListener('pointerleave', e => {
    if (e.pointerType === 'mouse' && !chart.pinned) hideRideHour(chart);
  });

  slider.addEventListener('focus', () => {
    // Keyboard focus shows where you are. Pointer focus has already shown it.
    if (chart.tip.hidden) showRideHour(chart, chart.index);
  });
  slider.addEventListener('blur', () => hideRideHour(chart));
  slider.addEventListener('keydown', e => {
    const last = chart.bars.length - 1;
    const moves = { ArrowRight: chart.index + 1, ArrowUp: chart.index + 1, ArrowLeft: chart.index - 1, ArrowDown: chart.index - 1, Home: 0, End: last };
    if (e.key in moves) {
      e.preventDefault();
      chart.pinned = true;
      showRideHour(chart, Math.min(last, Math.max(0, moves[e.key])));
    } else if (e.key === 'Escape') {
      hideRideHour(chart);
    }
  });
}

// Pressing anywhere outside the chart dismisses a pinned tooltip. Bound once,
// because the chart itself is rebuilt on every render.
document.addEventListener('pointerdown', e => {
  if (rideChart && !rideChart.wrap.contains(e.target)) hideRideHour(rideChart);
});

function showRideHour(chart, i) {
  const entry = chart.hours[i];
  if (!entry) return;
  chart.bars.forEach((bar, j) => RIDE_BAR_ACTIVE.forEach(c => bar.classList.toggle(c, j === i)));
  chart.tip.innerHTML = rideTipMarkup(entry);
  chart.tip.hidden = false;
  updateRideSlider(chart, i);

  // Centre over the bar, but never past either edge of the chart.
  const wrapBox = chart.wrap.getBoundingClientRect();
  const barBox = chart.bars[i].getBoundingClientRect();
  const centre = barBox.left + barBox.width / 2 - wrapBox.left;
  const width = chart.tip.offsetWidth;
  chart.tip.style.left = `${Math.min(Math.max(0, centre - width / 2), wrapBox.width - width)}px`;
}

function hideRideHour(chart) {
  chart.pinned = false;
  chart.dragging = false;
  chart.tip.hidden = true;
  chart.bars.forEach(bar => RIDE_BAR_ACTIVE.forEach(c => bar.classList.remove(c)));
}

/** Keep the slider's position and spoken value in step with the tooltip. */
function updateRideSlider(chart, i) {
  chart.index = i;
  const entry = chart.hours[i];
  if (!entry) return;
  const d = describeHourConditions(entry.hour, state.unitSystem);
  chart.slider.setAttribute('aria-valuenow', String(i));
  chart.slider.setAttribute('aria-valuetext',
    `${formatDayPrefix(entry.date)}${formatClock(entry.date)}, ${entry.score} out of 10, ${entry.tier.label}. ${hourConditionsSentence(d)}`);
}

function rideTipMarkup(entry) {
  const d = describeHourConditions(entry.hour, state.unitSystem);
  const t = tone(entry.tier.tone);
  const wind = `${d.wind}${d.windFrom ? ` from ${d.windFrom}` : ''}${d.gusts ? ` · gusts ${d.gusts}` : ''}`;
  return `
    <div class="flex items-center justify-between gap-3 mb-1">
      <span class="font-semibold">${escapeHtml(`${formatDayPrefix(entry.date)}${formatClock(entry.date)}`)}</span>
      <span class="inline-flex items-center gap-1 ${t.badge} px-2 py-0.5 rounded-full font-medium">${entry.tier.emoji} ${entry.score}/10</span>
    </div>
    <div>🌡 ${escapeHtml(d.temp)}${d.feelsLike ? ` <span class="text-gray-500 dark:text-gray-400">· feels ${escapeHtml(d.feelsLike)}</span>` : ''}</div>
    <div>💨 ${escapeHtml(wind)}</div>
    <div>💧 ${escapeHtml(d.rainChance)} chance${d.rainAmount ? ` · ${escapeHtml(d.rainAmount)}` : ''}</div>`;
}

// --- Insights ---------------------------------------------------------------

function renderInsights() {
  if (!el.insights || !state.weather) return;
  const sys = state.unitSystem;
  const c = state.weather.current;

  if (el.insightsCard) {
    el.insightsCard.className = `rounded-lg shadow-lg p-4 backdrop-blur ${ACTIVITY_CARD_BG[state.activity]}`;
  }

  const result = scoreCurrent(state.weather, state.activity, scoringOptions());
  const t = tone(result.tier.tone);
  const alerts = generateSafetyAlerts(state.weather);
  const recommendations = generateRecommendations(state.weather, state.activity);

  const alertsHtml = alerts.length ? `
    <div class="mt-2">
      <div class="text-sm font-medium mb-1">Safety Alerts</div>
      <div class="space-y-2">
        ${alerts.map(a => {
          const at = a.severity === 'high' ? TONE.red : TONE.yellow;
          return `<div class="rounded-md px-3 py-2 ${at.badge} flex items-start gap-2">
            <span class="shrink-0 mt-0.5">${aIcon(a.type)}</span><span>${escapeHtml(a.message)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const penaltyRows = result.breakdown.length
    ? result.breakdown.map(b => `<li>${escapeHtml(b.name)}: −${b.penalty}</li>`).join('')
    : '<li>No penalties — conditions are as good as the model gets.</li>';

  const unknownNote = result.unknown.length
    ? `<div class="mt-2 text-xs text-gray-500 dark:text-gray-400">Not reported by the forecast model for this location, so not scored: ${escapeHtml(result.unknown.join(', '))}.</div>`
    : '';

  const comfort = temperatureComfort(c.apparentTemperature ?? c.temperature, sys);
  const summaryLine = `${result.tier.label} conditions with ${windDescriptor(c.windSpeed)}`;

  el.insights.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="text-sm text-gray-600 dark:text-gray-300">
        Selected: <span class="mr-1">${ACTIVITY_EMOJI[state.activity]}</span><span class="font-medium">${escapeHtml(DISCIPLINES[state.activity].label)}</span>
      </div>
      <div class="inline-flex items-center gap-2 ${t.badge} px-3 py-1 rounded-full text-sm font-medium shadow-sm">
        ${result.tier.emoji} <span>${result.score}/10 – ${escapeHtml(result.tier.label)}</span>
      </div>
    </div>
    ${alertsHtml}

    <section class="mt-3 rounded-lg border ${t.border} p-4 ${t.soft}">
      <div class="flex flex-col sm:flex-row gap-4">
        <div class="flex-1">
          <div class="text-lg font-semibold mb-1">Biking Conditions</div>
          <div class="text-sm text-gray-600 dark:text-gray-300 mb-3">${escapeHtml(summaryLine)}</div>
          <div class="text-3xl font-bold">${result.score}<span class="text-lg font-medium text-gray-500 dark:text-gray-400">/10</span></div>
          <div class="text-sm mb-3">${escapeHtml(result.message)}</div>

          <div class="text-sm font-medium mb-1">Key Factors</div>
          <ul class="text-sm mb-3 space-y-1">
            <li class="flex items-center gap-2">${icon('wind')}<span>Wind: ${formatSpeed(c.windSpeed, sys)} ${degToCardinal(c.windDirection)}${c.windGusts != null ? `, gusting ${formatSpeed(c.windGusts, sys)}` : ''}</span></li>
            <li class="flex items-center gap-2">${icon('temp')}<span>Feels like: ${formatTemp(c.apparentTemperature ?? c.temperature, sys)} (${comfort})</span></li>
            ${onBikeChillRow(result)}
            <li class="flex items-center gap-2">${icon('humidity')}<span>Rain: ${formatPercent(c.precipitationProbability)} chance</span></li>
            <li class="flex items-center gap-2">${icon('visibility')}<span>Visibility: ${formatVisibility(c.visibility, sys)}</span></li>
            ${surfaceRow(result)}
          </ul>

          <div class="text-sm font-medium mb-1">Recommendations</div>
          <ul class="text-sm space-y-1">
            ${recommendations.map(r => `<li class="flex items-start gap-2">${icon(r.icon)}<span>${escapeHtml(r.text)}</span></li>`).join('')}
          </ul>
        </div>

        <div class="sm:w-72 w-full sm:border-l sm:pl-4 border-gray-200 dark:border-gray-700">
          <button id="bike-more-btn" class="text-sm underline" aria-expanded="false" aria-controls="bike-explain">Score details</button>
          <div id="bike-explain" class="mt-2 hidden text-sm text-gray-700 dark:text-gray-200">
            <div>Starts at 10.0, then:</div>
            <ul class="mt-1 list-disc pl-5 space-y-0.5">${penaltyRows}</ul>
            ${result.ceilings.length ? `<div class="mt-2">Capped at ${result.ceilings[0].cap} — ${escapeHtml(result.ceilings[0].reason.toLowerCase())}.</div>` : ''}
            ${unknownNote}
          </div>
          <div class="mt-4 flex justify-center items-center">
            <div class="relative">
              <span class="absolute inset-0 bg-white/30 dark:bg-black/30 blur-xl rounded-full"></span>
              <span class="relative inline-block drop-shadow-xl">
                ${weatherIconMarkup(c.weatherCode, 'h-40 sm:h-48 md:h-56 w-auto opacity-90', isNightAt(new Date()))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  const moreBtn = el.insights.querySelector('#bike-more-btn');
  const explain = el.insights.querySelector('#bike-explain');
  moreBtn?.addEventListener('click', () => {
    const hidden = explain.classList.toggle('hidden');
    moreBtn.textContent = hidden ? 'Score details' : 'Hide details';
    moreBtn.setAttribute('aria-expanded', String(!hidden));
  });

  wireIconFallbacks(el.insights);
}

/**
 * Show the on-bike wind chill only when it differs meaningfully from the
 * ambient feels-like. On a mild day the two agree and the extra row is noise.
 */
function onBikeChillRow(result) {
  const chill = result.ridingFeelsLikeC;
  const ambient = state.weather?.current?.apparentTemperature ?? state.weather?.current?.temperature;
  if (chill == null || ambient == null || Math.abs(chill - Number(ambient)) < 2) return '';
  const speed = state.ridingSpeedKmh || DISCIPLINES[state.activity].ridingSpeedKmh;
  return `<li class="flex items-center gap-2">${icon('thermo')}<span>On the bike at ${formatSpeed(speed, state.unitSystem)}: <strong>${formatTemp(chill, state.unitSystem)}</strong></span></li>`;
}

/** Surface state for gravel/MTB, with a note when it came from the weaker signal. */
function surfaceRow(result) {
  if (!result.surface) return '';
  const note = result.surface.source === 'rainfall' ? ' (estimated from rainfall)' : '';
  return `<li class="flex items-center gap-2">${icon('flag')}<span>Surface: ${escapeHtml(result.surface.label)}${note}</span></li>`;
}

// --- Hourly -----------------------------------------------------------------

function renderHourly() {
  if (!el.hourlyForecast || !state.weather) return;
  const sys = state.unitSystem;
  const scored = scoreHourlySeries(state.weather, state.activity, { hours: 24, ...scoringOptions() }).slice(0, 24);

  const source = scored.length
    ? scored
    : (state.weather.next24FromNearest || state.weather.hourly.slice(0, 24))
        .map(h => ({ hour: h, date: new Date(h.time), score: null, tier: scoreTier(0) }));

  el.hourlyForecast.innerHTML = source.map(entry => {
    const h = entry.hour;
    const t = tone(entry.tier.tone);
    const night = isNightAt(entry.date);
    return `
      <div class="min-w-[92px] rounded-md bg-gray-50 dark:bg-gray-700 overflow-hidden text-center">
        <div class="${entry.score == null ? TONE.gray.bar : t.bar} h-1.5 w-full"></div>
        <div class="p-3">
          <div class="text-xs text-gray-500 dark:text-gray-300">${formatClock(entry.date)}</div>
          <div class="flex justify-center my-1">${weatherIconMarkup(h.weatherCode, 'w-8 h-8', night)}</div>
          <div class="text-lg font-semibold">${formatTemp(h.temperature, sys)}</div>
          <div class="text-xs text-gray-600 dark:text-gray-300">${formatPercent(h.precipitationProbability)} rain</div>
          <div class="text-xs text-gray-600 dark:text-gray-300">${formatSpeed(h.windSpeed, sys)}</div>
          ${entry.score == null ? '' : `<div class="mt-1 text-xs font-semibold ${t.badge} rounded-full px-2 py-0.5 inline-block">${entry.score}/10</div>`}
        </div>
      </div>`;
  }).join('');

  wireIconFallbacks(el.hourlyForecast);
}

// --- Daily ------------------------------------------------------------------

function renderDaily() {
  if (!el.dailyForecast || !state.weather) return;
  const sys = state.unitSystem;

  el.dailyForecast.innerHTML = state.weather.daily.map(d => {
    const bgUrl = iconCandidates(d.weatherCode, false)[0];
    return `
      <div class="relative overflow-hidden rounded-md bg-gray-50 dark:bg-gray-700 p-3 text-center">
        <div aria-hidden="true" class="absolute top-0 right-0 w-1/2 h-1/2 opacity-50 bg-no-repeat bg-contain bg-right-top pointer-events-none" style="background-image:url('${escapeAttr(bgUrl)}')"></div>
        <div class="relative">
          <div class="text-sm font-medium">${formatDay(d.date)}</div>
          <div class="text-xs text-gray-500 dark:text-gray-300 mb-1">${escapeHtml(d.weatherText || '')}</div>
          <div class="text-lg font-semibold">${formatTemp(d.temperatureMax, sys)} / ${formatTemp(d.temperatureMin, sys)}</div>
          <div class="text-xs mt-1">💧 ${formatPercent(d.precipitationProbabilityMax)} · 💨 ${formatSpeed(d.windSpeedMax, sys)}</div>
          ${d.sunrise && d.sunset ? `<div class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">☀ ${formatClock(d.sunrise)}–${formatClock(d.sunset)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

/**
 * Goal: Plot the 7-day high/low as inline SVG.
 * Why: This replaced ~200 KB of Chart.js plus a datalabels plugin, pulled from a
 *      CDN, for one line chart — in an app that already draws its own sparkline.
 *      Inline SVG also inherits `currentColor`, so it just works in both themes
 *      with no re-render on toggle and no external requests to allow in a CSP.
 * How: Map temperatures to a fixed viewBox and let CSS scale it. Colours come
 *      from Tailwind text utilities on the wrapping groups.
 */
function renderDailyTempChart() {
  const host = el.dailyTempChart;
  if (!host || !state.weather || !Array.isArray(state.weather.daily)) return;

  const sys = state.unitSystem;
  const unit = systemFor(sys).temp;
  const days = state.weather.daily;
  const highs = days.map(d => convertTemp(d.temperatureMax, sys));
  const lows = days.map(d => convertTemp(d.temperatureMin, sys));

  const usable = highs.filter(v => v !== null).length;
  if (usable < 2) {
    host.innerHTML = '';
    return;
  }

  // Geometry in viewBox units; the SVG scales to whatever width it is given.
  const W = 720;
  const H = 240;
  const padX = 34;
  const padTop = 26;
  const padBottom = 34;

  const values = [...highs, ...lows].filter(v => v !== null);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 4) { const mid = (max + min) / 2; min = mid - 2; max = mid + 2; }
  const pad = (max - min) * 0.15;
  min -= pad;
  max += pad;

  const x = i => padX + (i * (W - padX * 2)) / Math.max(1, days.length - 1);
  const y = v => padTop + ((max - v) / (max - min)) * (H - padTop - padBottom);

  const path = series => series
    .map((v, i) => (v === null ? null : `${i === 0 || series[i - 1] === null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');

  const dots = (series, cls) => series
    .map((v, i) => (v === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" class="${cls}" />`))
    .join('');

  const labels = (series, cls, dy) => series
    .map((v, i) => (v === null ? '' :
      `<text x="${x(i).toFixed(1)}" y="${(y(v) + dy).toFixed(1)}" text-anchor="middle" class="${cls}" font-size="12" font-weight="600">${Math.round(v)}°</text>`))
    .join('');

  // Three horizontal guides, labelled.
  const gridLines = [0, 0.5, 1].map(f => {
    const value = max - f * (max - min);
    const gy = padTop + f * (H - padTop - padBottom);
    return `<line x1="${padX}" y1="${gy.toFixed(1)}" x2="${W - padX}" y2="${gy.toFixed(1)}" stroke="currentColor" stroke-opacity="0.15" stroke-width="1" />
      <text x="${padX - 6}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.55">${Math.round(value)}°</text>`;
  }).join('');

  const dayLabels = days
    .map((d, i) => `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity="0.7">${escapeHtml(formatDay(d.date))}</text>`)
    .join('');

  host.innerHTML = `
    <figure class="text-gray-900 dark:text-gray-100">
      <figcaption class="flex items-center gap-4 text-xs text-gray-600 dark:text-gray-300 mb-1">
        <span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-0.5 bg-red-500"></span>High (${unit})</span>
        <span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-0.5 bg-blue-500"></span>Low (${unit})</span>
      </figcaption>
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img"
           aria-label="${escapeAttr(dailyChartSummary(days, highs, lows, unit))}">
        ${gridLines}
        ${dayLabels}
        <g class="text-red-500">
          <path d="${path(highs)}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
          ${dots(highs, 'fill-red-500')}
          ${labels(highs, 'fill-red-600 dark:fill-red-300', -10)}
        </g>
        <g class="text-blue-500">
          <path d="${path(lows)}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
          ${dots(lows, 'fill-blue-500')}
          ${labels(lows, 'fill-blue-600 dark:fill-blue-300', 18)}
        </g>
      </svg>
    </figure>`;
}

/** Screen-reader description of the chart, which is otherwise pure geometry. */
function dailyChartSummary(days, highs, lows, unit) {
  const parts = days.map((d, i) => {
    if (highs[i] === null || lows[i] === null) return null;
    return `${formatDay(d.date)} ${Math.round(highs[i])} to ${Math.round(lows[i])}${unit}`;
  }).filter(Boolean);
  return `Daily high and low temperatures: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Scenic image (opt-in only — no key ships with the app)
// ---------------------------------------------------------------------------

/**
 * Goal: Show a scenic cycling photo when the operator supplies their own key.
 * Why: The previous build hardcoded a live Unsplash access key into a public
 *      repository. A key must come from runtime config, never from source.
 */
function initScenicImage() {
  const section = el.scenicSection;
  const img = el.scenicImage;
  if (!section || !img) return;

  const accessKey = typeof window.UNSPLASH_ACCESS_KEY === 'string' ? window.UNSPLASH_ACCESS_KEY.trim() : '';
  if (!accessKey) return; // stays hidden

  const url = `https://api.unsplash.com/photos/random?client_id=${encodeURIComponent(accessKey)}&query=${encodeURIComponent('cycling,mountains,outdoors')}&orientation=landscape`;
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      const src = data?.urls?.regular || data?.urls?.full;
      if (!src) return;
      img.src = src;
      img.alt = data?.alt_description || 'Scenic cycling photo';
      if (el.scenicCredit && data?.user?.name && data?.user?.links?.html) {
        el.scenicCredit.innerHTML =
          `Photo by <a href="${escapeAttr(data.user.links.html)}" target="_blank" rel="noopener" class="underline">${escapeHtml(data.user.name)}</a> on <a href="https://unsplash.com" target="_blank" rel="noopener" class="underline">Unsplash</a>`;
      }
      section.classList.remove('hidden');
    })
    .catch(() => { /* leave hidden */ });
}

// ---------------------------------------------------------------------------
// Weather icons
// ---------------------------------------------------------------------------

const ICON_DIR = 'assets/icons/weather2/static';

const ICON_BY_CODE = {
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

function iconCandidates(code, night = false) {
  const day = ICON_BY_CODE[code] || 'cloud';
  const base = night && ICON_NIGHT[day] ? ICON_NIGHT[day] : day;
  // Exact-key lookup. The old code used `baseName.includes(key)`, so 'sun-cloud'
  // matched the 'sun' entry first and inherited the wrong fallback list.
  const alts = ICON_FALLBACKS[base] || ICON_FALLBACKS[day] || ['cloud'];
  return [base, ...alts].map(n => `${ICON_DIR}/${n}.svg`);
}

function weatherIconMarkup(code, cls, night = false) {
  const candidates = iconCandidates(code, night);
  return `<img src="${escapeAttr(candidates[0])}" alt="" aria-hidden="true" class="${cls}" data-icon-fallbacks="${escapeAttr(candidates.slice(1).join('|'))}" />`;
}

/**
 * Goal: Try each fallback icon in turn, one per failed load.
 * Why: The old inline `onerror` concatenated every fallback into a single
 *      handler, so all assignments ran at once and only the last URL survived —
 *      the intermediate candidates never got a chance, and `onerror=null` meant
 *      no retry after that. This walks the list properly.
 */
function wireIconFallbacks(root) {
  if (!root) return;
  root.querySelectorAll('img[data-icon-fallbacks]').forEach(img => {
    if (img.dataset.iconWired === '1') return;
    img.dataset.iconWired = '1';
    img.addEventListener('error', () => {
      const remaining = (img.dataset.iconFallbacks || '').split('|').filter(Boolean);
      const next = remaining.shift();
      img.dataset.iconFallbacks = remaining.join('|');
      if (next) img.src = next;
      else img.style.visibility = 'hidden';
    });
  });
}

function isNightAt(date) {
  return isNight(date, getDaylightRanges(state.weather));
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

function icon(type) {
  const cls = 'w-5 h-5 shrink-0 text-gray-700 dark:text-gray-200';
  const paths = {
    wind: '<path d="M3 12h10a3 3 0 1 0 0-6"/><path d="M2 17h14a3 3 0 1 1-3 3"/><path d="M9 9h6a3 3 0 1 0-3-3"/>',
    temp: '<path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"/>',
    thermo: '<path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"/>',
    humidity: '<path d="M12 2.69 7.05 7.64a7 7 0 1 0 9.9 0Z"/>',
    visibility: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22V4"/>',
    uv: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 19Z"/>',
    air: '<path d="M4 8h11a3 3 0 1 0-3-3"/><path d="M2 12h16a3 3 0 1 1-3 3"/><path d="M4 16h8"/>',
    storm: '<path d="M17 13a4 4 0 0 0 0-8 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6 13"/><path d="m12 12-2 5h4l-2 5"/>'
  };
  const body = paths[type];
  if (!body) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${body}</svg>`;
}

function aIcon(type) {
  const map = { wind: 'wind', visibility: 'visibility', wet: 'humidity', cold: 'thermo', heat: 'uv', uv: 'uv', air: 'air', storm: 'storm' };
  return icon(map[type] || 'flag');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setLocationIndicator(text) {
  if (el.locationIndicator) el.locationIndicator.textContent = trimLocationText(text);
}

function formatLocationName(location) {
  return [location.name, location.region, location.country].filter(Boolean).join(', ');
}

function trimLocationText(text) {
  if (!text) return '';
  const parts = String(text).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : (parts[0] || '');
}

let toastTimer = null;
function showToast(message, ms = 2500) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), delay);
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const escapeAttr = escapeHtml;

// Every time on the page is shown on the forecast location's clock, not the
// viewer's. See js/time.js.
function locationZone() {
  return state.weather?.timezone;
}

function formatClock(value) {
  return clockAt(value, locationZone());
}

/** "Tomorrow " prefix when the window is not today, so 6:00 is never ambiguous. */
function formatDayPrefix(date) {
  return dayPrefix(date, new Date(), locationZone());
}

function formatDay(dateKey) {
  return formatWeekday(dateKey);
}

async function safeReverse(lat, lon) {
  try {
    return await reverseGeocode(lat, lon);
  } catch {
    return null;
  }
}
