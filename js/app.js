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
  generateSafetyAlerts, generateRecommendations, scoreTier
} from './insights.js';
import {
  formatTemp, formatSpeed, formatVisibility, formatPercent, formatPrecip,
  degToCardinal, temperatureComfort, windDescriptor, convertTemp, systemFor
} from './units.js';

const state = {
  activity: 'road',       // 'road' | 'gravel' | 'mtb'
  location: null,
  weather: null,
  airQuality: null,
  unitSystem: 'metric',   // 'metric' | 'imperial'
  theme: 'light',         // 'dark' | 'light' — the theme currently showing
  themeSource: 'system',  // 'system' | 'user' — whether the rider chose it
  loading: false,
  error: null
};

const UNITS_KEY = 'w4b:units';
const ACTIVITY_KEY = 'w4b:activity';
// Also read by the pre-paint inline script in index.html — keep both in sync.
const THEME_KEY = 'w4b:theme';

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
    'theme-toggle', 'theme-toggle-dark-icon', 'theme-toggle-light-icon'
  ];
  ids.forEach(id => { el[camel(id)] = document.getElementById(id); });
  el.activityButtons = ['activity-road', 'activity-gravel', 'activity-mtb']
    .map(id => document.getElementById(id))
    .filter(Boolean);
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

let dailyTempChart = null;
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

  try {
    const last = getLastLocation();
    if (last) {
      await loadWeather(last);
    } else {
      setLocationIndicator('Locating…');
      const { latitude, longitude, accuracy } = await getCurrentLocation();
      const place = await safeReverse(latitude, longitude);
      await loadWeather(place || { name: 'Current location', latitude, longitude, region: '', country: '', accuracy });
    }
  } catch {
    setLocationIndicator('Using default location');
    await loadWeather({ name: 'San Francisco', latitude: 37.7749, longitude: -122.4194, region: 'CA', country: 'USA' });
  }
  renderRecentsDropdown();
});

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
  } catch {
    // Private mode — defaults are fine.
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
  bindHelpModal();

  el.useGeolocation?.addEventListener('click', async () => {
    try {
      setLocationIndicator('Locating…');
      const { latitude, longitude, accuracy } = await getCurrentLocation();
      const place = await safeReverse(latitude, longitude);
      await loadWeather(place || { name: 'Current location', latitude, longitude, region: '', country: '', accuracy });
    } catch {
      showToast('Could not access location. Please enable permissions.');
    }
  });

  el.refreshBtn?.addEventListener('click', async () => {
    if (!state.location) return;
    clearWeatherCache();
    await loadWeather(state.location, { force: true });
    showToast('Forecast refreshed', 1500);
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
  renderHourly();
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
    // The chart bakes its label colour from the computed body colour, so it has
    // to be rebuilt or its axes keep the previous theme's contrast.
    renderDailyTempChart();
    showToast(state.theme === 'dark' ? 'Dark mode' : 'Light mode', 1200);
  });

  // Track the OS while the rider has not overridden it, so flipping the system
  // theme updates a page that is already open.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (state.themeSource !== 'system') return;
      applyTheme(e.matches ? 'dark' : 'light', { persist: false, source: 'system' });
      renderDailyTempChart();
    });
  } catch {
    // Safari < 14 has no addEventListener on MediaQueryList; static default is fine.
  }
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
  const q = el.citySearch.value.trim();
  if (q.length < 3) {
    searchOptions = [];
    closeSearchResults();
    el.searchResults.innerHTML = '';
    return;
  }
  try {
    searchOptions = await searchCities(q);
    renderSearchResults(searchOptions);
  } catch {
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
 */
async function loadWeather(location, options = {}) {
  state.location = location;
  state.loading = true;
  state.error = null;
  hideErrorBanner();
  setLocationIndicator(formatLocationName(location));
  renderSkeletons();

  try {
    const weather = await fetchWeatherData(location.latitude, location.longitude, options);
    state.weather = weather;

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
    fetchAirQuality(location.latitude, location.longitude, options).then(air => {
      if (state.location !== location) return; // user moved on
      state.airQuality = air;
      if (state.weather) state.weather.airQuality = air;
      renderCurrent();
      renderInsights();
    });
  } catch (e) {
    state.loading = false;
    state.error = e;
    showErrorBanner(e);
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

  if (el.currentUpdated) {
    el.currentUpdated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

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

  const scored = scoreHourlySeries(state.weather, state.activity, { hours: 30 });
  const daylight = getDaylightRanges(state.weather);
  const best = findBestWindow(scored, { daylight: daylight.length ? daylight : null, withinHours: 24 });
  const rain = findRainTiming(state.weather.hourly, { hours: 24 });

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

  if (!best) {
    el.bestWindow.innerHTML = `
      <div class="rounded-lg border ${TONE.gray.border} ${TONE.gray.soft} p-4">
        <div class="font-medium">No clear window in the next 24 hours of daylight.</div>
        <div class="text-sm text-gray-600 dark:text-gray-300 mt-1">Check the 7-day outlook below, or plan an indoor session.</div>
        <div class="text-sm text-gray-600 dark:text-gray-300 mt-2">${rainLine}</div>
      </div>`;
    return;
  }

  const t = tone(best.tier.tone);
  const sparkline = renderSparkline(scored.slice(0, 24));

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
    </div>`;
}

/** A 24-bar strip: height and colour both encode the hourly rideability score. */
function renderSparkline(scoredHours) {
  if (!scoredHours.length) return '';
  const bars = scoredHours.map(h => {
    const t = tone(h.tier.tone);
    const height = Math.max(8, Math.round((h.score / 10) * 40));
    return `<div class="flex-1 flex flex-col justify-end items-center gap-1" title="${escapeAttr(`${formatClock(h.date)} · ${h.score}/10 ${h.tier.label}`)}">
      <div class="${t.bar} w-full rounded-sm" style="height:${height}px"></div>
    </div>`;
  }).join('');

  const first = scoredHours[0];
  const mid = scoredHours[Math.floor(scoredHours.length / 2)];
  const last = scoredHours[scoredHours.length - 1];

  return `
    <div class="mt-3" aria-hidden="true">
      <div class="flex items-end gap-[2px] h-[44px]">${bars}</div>
      <div class="flex justify-between text-[11px] text-gray-500 dark:text-gray-400 mt-1">
        <span>${formatClock(first.date)}</span><span>${formatClock(mid.date)}</span><span>${formatClock(last.date)}</span>
      </div>
    </div>`;
}

// --- Insights ---------------------------------------------------------------

function renderInsights() {
  if (!el.insights || !state.weather) return;
  const sys = state.unitSystem;
  const c = state.weather.current;

  if (el.insightsCard) {
    el.insightsCard.className = `rounded-lg shadow-lg p-4 backdrop-blur ${ACTIVITY_CARD_BG[state.activity]}`;
  }

  const result = scoreCurrent(state.weather, state.activity);
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
            <li class="flex items-center gap-2">${icon('humidity')}<span>Rain: ${formatPercent(c.precipitationProbability)} chance</span></li>
            <li class="flex items-center gap-2">${icon('visibility')}<span>Visibility: ${formatVisibility(c.visibility, sys)}</span></li>
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

// --- Hourly -----------------------------------------------------------------

function renderHourly() {
  if (!el.hourlyForecast || !state.weather) return;
  const sys = state.unitSystem;
  const scored = scoreHourlySeries(state.weather, state.activity, { hours: 24 }).slice(0, 24);

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

function renderDailyTempChart() {
  const canvas = el.dailyTempChart;
  if (!canvas || !state.weather || !Array.isArray(state.weather.daily)) return;
  if (typeof window.Chart === 'undefined') return;

  if (window.ChartDataLabels && !window.__chartDatalabelsRegistered) {
    try { window.Chart.register(window.ChartDataLabels); window.__chartDatalabelsRegistered = true; } catch { /* optional plugin */ }
  }

  const sys = state.unitSystem;
  const unitSymbol = systemFor(sys).temp;
  const labels = state.weather.daily.map(d => formatDay(d.date));
  const toDisplay = v => {
    const converted = convertTemp(v, sys);
    return converted === null ? null : Math.round(converted);
  };
  const textColor = getComputedStyle(document.body).color || '#111827';

  if (dailyTempChart) {
    dailyTempChart.destroy();
    dailyTempChart = null;
  }

  dailyTempChart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Max (${unitSymbol})`,
          data: state.weather.daily.map(d => toDisplay(d.temperatureMax)),
          borderColor: 'rgb(239, 68, 68)',
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          pointRadius: 3, pointHoverRadius: 4, borderWidth: 3, tension: 0.3, spanGaps: true
        },
        {
          label: `Min (${unitSymbol})`,
          data: state.weather.daily.map(d => toDisplay(d.temperatureMin)),
          borderColor: 'rgb(59, 130, 246)',
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          pointRadius: 3, pointHoverRadius: 4, borderWidth: 3, tension: 0.3, spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 12, right: 8, left: 8, bottom: 8 } },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: textColor } },
        tooltip: {
          callbacks: {
            label: ctx => (ctx.parsed.y == null ? '' : `${ctx.dataset.label}: ${ctx.parsed.y}${unitSymbol}`)
          }
        },
        datalabels: window.ChartDataLabels ? {
          color: textColor, clamp: true, anchor: 'end', align: 'top', offset: 2, padding: 2,
          font: { weight: '600', size: 10 },
          formatter: v => (v == null ? '' : `${v}${unitSymbol}`)
        } : undefined
      },
      scales: {
        y: { ticks: { callback: v => `${v}${unitSymbol}`, color: textColor }, grid: { color: 'rgba(107,114,128,0.2)' } },
        x: { ticks: { color: textColor }, grid: { display: false } }
      }
    }
  });
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
  const today = state.weather?.today;
  if (!today?.sunrise || !today?.sunset) return false;
  const t = date.getTime();
  const sunrise = new Date(today.sunrise).getTime();
  const sunset = new Date(today.sunset).getTime();
  if (Number.isNaN(sunrise) || Number.isNaN(sunset)) return false;
  // Compare clock position within the day so tomorrow's small hours count too.
  const minutes = date.getHours() * 60 + date.getMinutes();
  const riseMin = new Date(sunrise).getHours() * 60 + new Date(sunrise).getMinutes();
  const setMin = new Date(sunset).getHours() * 60 + new Date(sunset).getMinutes();
  return minutes < riseMin || minutes > setMin;
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

function formatClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Tomorrow " prefix when the window is not today, so 6:00 is never ambiguous. */
function formatDayPrefix(date) {
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '';
  const tomorrow = new Date(today.getTime() + 86400000);
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow ';
  return `${date.toLocaleDateString([], { weekday: 'short' })} `;
}

function formatDay(iso) {
  // Date-only strings must be built as local time, or they shift a day in UTC-negative zones.
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short' });
  }
  return new Date(iso).toLocaleDateString([], { weekday: 'short' });
}

async function safeReverse(lat, lon) {
  try {
    return await reverseGeocode(lat, lon);
  } catch {
    return null;
  }
}
