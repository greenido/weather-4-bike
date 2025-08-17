import { fetchWeatherData } from './weather.js';
import { getCurrentLocation, searchCities, saveRecentLocation, getRecentLocations, clearRecentLocations, reverseGeocode, setLastLocation, getLastLocation } from './location.js';
import { calculateRoadCyclingScore, calculateGravelConditions, calculateMTBTrailReadiness, generateSafetyAlerts, applyEnvironmentalPenalties, calculateBikeScoreFromWeather, calculateGravelScoreFromWeather, calculateMTBScoreFromWeather } from './insights.js';

const state = {
  activity: 'road', // 'road' | 'gravel' | 'mtb'
  location: null,   // { name, latitude, longitude, region, country }
  weather: null,
  units: 'C' // 'C' | 'F'
};

// Elements
const locationIndicator = document.getElementById('location-indicator');
const appTitle = document.getElementById('app-title');
const citySearchInput = document.getElementById('city-search');
const searchResults = document.getElementById('search-results');
const useGeoButton = document.getElementById('use-geolocation');
const recentsToggle = document.getElementById('recents-toggle');
const recentsList = document.getElementById('recents-list');
const activityButtons = [
  document.getElementById('activity-road'),
  document.getElementById('activity-gravel'),
  document.getElementById('activity-mtb')
];

const currentContainer = document.getElementById('current-conditions');
const currentSummary = document.getElementById('current-summary');
const weatherBgIcon = document.getElementById('weather-bg-icon');
const insightsContainer = document.getElementById('insights');
const hourlyContainer = document.getElementById('hourly-forecast');
const dailyContainer = document.getElementById('daily-forecast');
const toast = document.getElementById('toast');
let dailyTempChart = null;

// Init
document.addEventListener('DOMContentLoaded', async () => {
  bindUI();
  initScenicImageFallback();
  try {
    // Try last location first
    const last = getLastLocation();
    if (last) {
      await loadWeather(last);
    } else {
      setLocationIndicator('Locating…');
      const { latitude, longitude, accuracy } = await getCurrentLocation();
      const rev = await safeReverse(latitude, longitude);
      await loadWeather(rev || { name: 'Current location', latitude, longitude, region: '', country: '', accuracy });
    }
  } catch (e) {
    setLocationIndicator('Using default location');
    // Default demo location if geolocation is unavailable
    await loadWeather({ name: 'San Francisco', latitude: 37.7749, longitude: -122.4194, region: 'CA', country: 'USA' });
  }
  renderRecentsDropdown();
});

function bindUI() {
  activityButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      state.activity = btn.dataset.activity;
      activityButtons.forEach(b => b.setAttribute('aria-selected', String(b === btn)));
      renderInsights();
    });
  });

  useGeoButton.addEventListener('click', async () => {
    try {
      setLocationIndicator('Locating…');
      const { latitude, longitude, accuracy } = await getCurrentLocation();
      const rev = await safeReverse(latitude, longitude);
      await loadWeather(rev || { name: 'Current location', latitude, longitude, region: '', country: '', accuracy });
    } catch (e) {
      showToast('Could not access location. Please enable permissions.');
    }
  });

  const debounced = debounce(onSearchChanged, 300);
  citySearchInput.addEventListener('input', debounced);
  citySearchInput.addEventListener('focus', () => {
    if (searchResults.children.length > 0) searchResults.classList.remove('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== citySearchInput) {
      searchResults.classList.add('hidden');
    }
    if (!recentsList.contains(e.target) && e.target !== recentsToggle) {
      recentsList.classList.add('hidden');
    }
  });

  recentsToggle.addEventListener('click', () => {
    renderRecentsDropdown();
    recentsList.classList.toggle('hidden');
  });

  // Mobile menu toggle
  const mobileBtn = document.getElementById('mobile-menu-btn');
  const headerControls = document.getElementById('header-controls');
  mobileBtn?.addEventListener('click', () => {
    if (!headerControls) return;
    const isHidden = headerControls.classList.contains('hidden');
    headerControls.classList.toggle('hidden');
    mobileBtn.setAttribute('aria-expanded', String(isHidden));
  });

  // Help modal
  const helpBtn = document.getElementById('help-button');
  const helpModal = document.getElementById('help-modal');
  const helpOverlay = document.getElementById('help-overlay');
  const helpClose = document.getElementById('help-close');
  const helpClose2 = document.getElementById('help-close-2');
  const openHelp = () => { if (helpModal) { helpModal.classList.remove('hidden'); helpBtn?.setAttribute('aria-expanded', 'true'); } };
  const closeHelp = () => { if (helpModal) { helpModal.classList.add('hidden'); helpBtn?.setAttribute('aria-expanded', 'false'); } };
  helpBtn?.addEventListener('click', openHelp);
  helpOverlay?.addEventListener('click', closeHelp);
  helpClose?.addEventListener('click', closeHelp);
  helpClose2?.addEventListener('click', closeHelp);

  // Units toggle
  const cBtn = document.getElementById('units-c');
  const fBtn = document.getElementById('units-f');
  if (cBtn && fBtn) {
    cBtn.addEventListener('click', () => {
      state.units = 'C';
      updateUnitsToggleUI();
      renderAll();
    });
    fBtn.addEventListener('click', () => {
      state.units = 'F';
      updateUnitsToggleUI();
      renderAll();
    });
    // Initialize visual state
    updateUnitsToggleUI();
  }
}

// Visually highlight the active units toggle
function updateUnitsToggleUI() {
  const cBtn = document.getElementById('units-c');
  const fBtn = document.getElementById('units-f');
  if (!cBtn || !fBtn) return;
  const baseBtn = 'px-3 py-2 text-sm transition-colors';
  const active = 'bg-blue-600 text-white dark:bg-blue-500 font-semibold';
  const inactive = 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700';

  if (state.units === 'C') {
    cBtn.className = `${baseBtn} ${active}`;
    fBtn.className = `${baseBtn} ${inactive}`;
    cBtn.setAttribute('aria-pressed', 'true');
    fBtn.setAttribute('aria-pressed', 'false');
  } else {
    cBtn.className = `${baseBtn} ${inactive}`;
    fBtn.className = `${baseBtn} ${active}`;
    cBtn.setAttribute('aria-pressed', 'false');
    fBtn.setAttribute('aria-pressed', 'true');
  }
}

async function onSearchChanged() {
  const q = citySearchInput.value.trim();
  if (q.length < 3) {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    return;
  }
  try {
    const cities = await searchCities(q);
    renderSearchResults(cities);
  } catch (e) {
    // swallow errors
  }
}

function renderSearchResults(cities) {
  searchResults.innerHTML = '';
  if (!cities.length) {
    searchResults.classList.add('hidden');
    return;
  }
  cities.forEach(city => {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700';
    btn.innerHTML = `
      <div class="font-medium">${escapeHtml(city.name)}</div>
      <div class="text-sm text-gray-500 dark:text-gray-400">${escapeHtml(city.region || '')}${city.region && city.country ? ', ' : ''}${escapeHtml(city.country || '')} · ${city.latitude.toFixed(2)}, ${city.longitude.toFixed(2)}</div>
    `;
    btn.addEventListener('click', async () => {
      searchResults.classList.add('hidden');
      citySearchInput.value = `${city.name}`;
      await loadWeather(city);
    });
    searchResults.appendChild(btn);
  });
  searchResults.classList.remove('hidden');
}

async function loadWeather(location) {
  state.location = location;
  setLocationIndicator(`${location.name}${location.region ? ', ' + location.region : ''}${location.country ? ', ' + location.country : ''}`);
  setTitleLocation(`${location.name}${location.region ? ', ' + location.region : ''}${location.country ? ', ' + location.country : ''}`);
  try {
    showToast('Loading weather…');
    console.groupCollapsed('[app] loadWeather');
    console.info('[app] location', location);
    const weather = await fetchWeatherData(location.latitude, location.longitude);
    state.weather = weather;
    console.info('[app] weather loaded', {
      hourly: weather.hourly?.length,
      daily: weather.daily?.length,
      nearestIndex: weather.nearestIndex,
      next24Len: weather.next24FromNearest?.length
    });
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
    renderAll();
    hideToast();
    console.groupEnd();
  } catch (e) {
    hideToast();
    console.error('[app] loadWeather failed', e);
    showToast('Failed to load weather. Please try again.');
  }
}

function renderAll() {
  renderCurrent();
  renderInsights();
  renderHourly();
  renderDaily();
  renderDailyTempChart();
  renderRecentsDropdown();
}

function initScenicImageFallback() {
  const img = document.getElementById('scenic-image');
  if (!img) return;
  const credit = document.getElementById('scenic-credit');
  // Optional: set your Unsplash Access Key here or via window.UNSPLASH_ACCESS_KEY
  const accessKey = window.UNSPLASH_ACCESS_KEY || '2637b3c08f3ee9646350728fd410ba5cf20cf548771532b1b57b353ffcc358de';
  const query = 'cycling,mountains,outdoors';

  const setImage = (url, alt, authorName, authorLink) => {
    img.src = url;
    img.alt = alt || 'Scenic cycling photo';
    if (credit) {
      if (authorName && authorLink) {
        credit.innerHTML = `Photo by <a href="${authorLink}" target="_blank" rel="noopener" class="underline">${authorName}</a> on <a href="https://unsplash.com" target="_blank" rel="noopener" class="underline">Unsplash</a>`;
      } else {
        credit.textContent = '';
      }
    }
  };

  const setHidden = () => { img.style.display = 'none'; if (credit) credit.textContent = ''; };

  if (!accessKey) {
    // If no access key, hide image (or you could keep the Source endpoint here)
    setHidden();
    return;
  }

  const apiUrl = `https://api.unsplash.com/photos/random?client_id=${encodeURIComponent(accessKey)}&query=${encodeURIComponent(query)}&orientation=landscape`;
  fetch(apiUrl)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => {
      const imageUrl = data?.urls?.regular || data?.urls?.full || '';
      const alt = data?.alt_description || 'Scenic cycling';
      const authorName = data?.user?.name;
      const authorLink = data?.user?.links?.html;
      if (imageUrl) setImage(imageUrl, alt, authorName, authorLink);
      else setHidden();
    })
    .catch(() => setHidden());
}

function renderCurrent() {
  const c = state.weather?.current;
  if (!c) return;
  currentContainer.innerHTML = '';
  // Summary with big temp and condition
  const mainTemp = formatTemp(c.temperature);
  currentSummary.innerHTML = `
    <div class="flex items-end gap-3">
      <div class="text-5xl font-bold">${mainTemp}</div>
      <div class="text-lg text-gray-600 dark:text-gray-300">${c.weatherText}</div>
    </div>
    <div class="text-sm text-gray-500 dark:text-gray-400">Wind ${Math.round(c.windSpeed ?? 0)} km/h · UV ${Math.round(c.uvIndex ?? 0)} · Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
  `;

  // Background weather icon with runtime fallback and higher visibility layer
  // Removed from Current Conditions; large icon now shown in Biking Conditions sidebar
  if (weatherBgIcon) weatherBgIcon.innerHTML = '';
  const items = [
    { label: 'Temp', value: `${formatTemp(c.temperature)}`, icon: 'temp', title: 'Air temperature' },
    { label: 'Feels', value: `${formatTemp(c.temperature)}`, icon: 'thermo', title: 'Feels like (approx)' },
    { label: 'Wind', value: `${Math.round(c.windSpeed ?? 0)} km/h`, icon: 'wind', title: 'Wind speed at 10m' },
    { label: 'UV', value: `${Math.round(c.uvIndex ?? 0)}`, icon: 'uv', title: 'UV index' },
    { label: 'Precip', value: `${Math.round(c.precipitationProbability ?? 0)}%`, icon: 'humidity', title: 'Precipitation probability' },
    { label: 'Cloud', value: `${Math.round(c.cloudCover ?? 0)}%`, icon: 'cloud', title: 'Cloud cover' },
    { label: 'Visibility', value: `${Math.round((c.visibility ?? 0) / 1000)} km`, icon: 'visibility', title: 'Visibility' },
    { label: 'Conditions', value: `${c.weatherText}`, icon: 'flag', title: 'Weather summary' }
  ];
  items.forEach(it => {
    const div = document.createElement('div');
    div.className = 'rounded-md bg-gray-50 dark:bg-gray-700 p-3';
    div.innerHTML = `
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-300" title="${it.title || ''}">${icon(it.icon || 'flag')}<span>${it.label}</span></div>
      <div class="text-lg font-semibold">${it.value}</div>
    `;
    currentContainer.appendChild(div);
  });
}

function renderInsights() {
  if (!state.weather) return;
  insightsContainer.innerHTML = '';
  const alerts = generateSafetyAlerts(state.weather);
  const alertsDiv = document.createElement('div');
  alertsDiv.className = 'space-y-2';
  if (alerts.length) {
    alerts.forEach(a => {
      const color = a.severity === 'high' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200';
      const d = document.createElement('div');
      d.className = `rounded-md px-3 py-2 ${color}`;
      d.innerHTML = `<span class="mr-2">${aIcon(a.type)}</span>${a.message}`;
      alertsDiv.appendChild(d);
    });
  }

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between';
  let score = 0;
  let roadScoreDetail = null;
  let gravelScoreDetail = null;
  let mtbScoreDetail = null;
  if (state.activity === 'road') {
    // Use new 1–10 bike score; map to 0–100 for header
    roadScoreDetail = calculateBikeScoreFromWeather(state.weather, 'crosswind');
    const { score: s10 } = roadScoreDetail;
    score = Math.round(s10 * 10);
  }
  if (state.activity === 'gravel') {
    gravelScoreDetail = calculateGravelScoreFromWeather(state.weather);
    score = Math.round(gravelScoreDetail.score * 10);
  }
  if (state.activity === 'mtb') score = calculateMTBTrailReadiness(state.weather);
  if (state.activity === 'mtb') {
    mtbScoreDetail = calculateMTBScoreFromWeather(state.weather);
    score = Math.round(mtbScoreDetail.score * 10);
  }
  // Remove extra global penalties to avoid double-counting with new algo
  // Ensure score stays within 0-100 before any downstream usage
  score = clamp(score, 0, 100);
  const { label, emoji, colorClass } = scoreToLabel(score);
  const classes = scoreColorClasses(score);
  header.innerHTML = `
    <div class="text-sm text-gray-500 dark:text-gray-400">Selected: <span class="font-medium capitalize">${state.activity}</span></div>
    <div class="inline-flex items-center gap-2 ${classes.bg} ${classes.text} px-3 py-1 rounded-full text-sm font-medium shadow-sm">${emoji} <span>${score} – ${label}</span></div>
  `;

  insightsContainer.appendChild(header);
  if (alerts.length) {
    const t = document.createElement('div');
    t.className = 'mt-2 text-sm font-medium';
    t.textContent = 'Safety Alerts';
    insightsContainer.appendChild(t);
    insightsContainer.appendChild(alertsDiv);
  }

  // Biking Conditions Tile (imperial display)
  const c = state.weather.current;
  const windMph = Math.round(kmhToMph(c.windSpeed ?? 0));
  const tempDisp = formatTemp(c.temperature ?? 0);
  const humidity = Math.round(c.humidity ?? 0);
  const visMi = Math.round(kmToMi((c.visibility ?? 0) / 1000));
  const windDir = degToCardinal(c.windDirection ?? 0);
  // Convert to 1–10 scale as an integer
  const tenInt = clamp(Math.round(score / 10), 1, 10);
  const conditionText = score >= 80 ? 'Excellent riding conditions' : score >= 60 ? 'Good riding conditions' : score >= 40 ? 'Fair riding conditions' : 'Poor riding conditions';
  const windQualifier = windMph <= 6 ? 'light winds' : windMph <= 12 ? 'mild crosswinds' : 'breezy conditions';
  const labelEl = scoreToLabel(score).label;

  const bikeTile = document.createElement('section');
  bikeTile.className = 'mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gradient-to-r from-emerald-50 to-green-100 dark:from-gray-800 dark:to-gray-700';
  const explain = (roadScoreDetail || gravelScoreDetail || mtbScoreDetail) ? `
    <div class="mt-2">
      <button id="bike-more-btn" class="text-sm underline">Details</button>
      <div id="bike-explain" class="mt-2 hidden text-sm text-gray-700 dark:text-gray-200">
        <div class="mb-1">${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).message || ''}</div>
        <div>Score calculation (1–10): <span class="font-semibold">${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).score}</span></div>
        <ul class="mt-1 list-disc pl-5">
          <li>Wind penalty: ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown?.windPenalty ?? 0}</li>
          <li>Temperature penalty: ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown?.temperaturePenalty ?? 0}</li>
          <li>Humidity penalty: ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown?.humidityPenalty ?? 0}</li>
          <li>Visibility penalty: ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown?.visibilityPenalty ?? 0}</li>
          ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown?.uvPenalty != null ? `<li>UV penalty: ${(roadScoreDetail||gravelScoreDetail||mtbScoreDetail).breakdown.uvPenalty}</li>` : ''}
        </ul>
      </div>
    </div>
  ` : '';

  const bigIcon = `
    <div class="mt-4 flex justify-center items-center">
      <div class="relative">
        <span class="absolute inset-0 bg-white/30 dark:bg-black/30 blur-xl rounded-full"></span>
        <span class="relative inline-block drop-shadow-xl">
          ${createWeatherIconImg(c.weatherCode, 'h-40 sm:h-48 md:h-56 lg:h-64 w-auto opacity-90')}
        </span>
      </div>
    </div>
  `;
  bikeTile.innerHTML = `
    <div class="flex flex-col sm:flex-row gap-4">
      <div class="flex-1">
        <div class="text-lg font-semibold mb-1">Biking Conditions</div>
        <div class="text-sm text-gray-600 dark:text-gray-300 mb-3">${conditionText} with ${windQualifier}</div>
        <div class="text-2xl font-bold mb-1">${tenInt}/10</div>
        <div class="text-sm mb-3">${labelEl}</div>
        <div class="text-sm font-medium mb-1">Key Factors</div>
        <ul class="text-sm mb-3 space-y-1">
          <li class="flex items-center gap-2">${icon('wind')}<span>Wind: ${windMph}mph ${windDir}</span></li>
          <li class="flex items-center gap-2">${icon('temp')}<span>Temperature: ${tempDisp}</span></li>
          <li class="flex items-center gap-2">${icon('humidity')}<span>Humidity: ${humidity}%</span></li>
          <li class="flex items-center gap-2">${icon('visibility')}<span>Visibility: ${visMi}mi</span></li>
        </ul>
        <div class="text-sm font-medium mb-1">Recommendations</div>
        <ul class="text-sm space-y-1">
          <li class="flex items-center gap-2">${icon('flag')}<span>${windMph <= 6 ? 'Light wind conditions' : 'Manage crosswinds on exposed sections'}</span></li>
          <li class="flex items-center gap-2">${icon('thermo')}<span>${(state.units === 'F' ? (Number(c.temperature) >= 55 && Number(c.temperature) <= 75) : (Number(c.temperature) >= 13 && Number(c.temperature) <= 24)) ? 'Perfect temperature for long rides' : (state.units === 'F' ? (Number(c.temperature) < 55 ? 'Layer up for cooler temps' : 'Hydrate and avoid peak sun') : (Number(c.temperature) < 13 ? 'Layer up for cooler temps' : 'Hydrate and avoid peak sun'))}</span></li>
          <li class="flex items-center gap-2">${icon('uv')}<span>${(c.uvIndex ?? 0) >= 6 ? 'UV protection strongly recommended' : 'UV protection recommended'}</span></li>
        </ul>
      </div>
      <div class="sm:w-72 w-full sm:border-l sm:pl-4 border-gray-200 dark:border-gray-700">
        ${explain}
        ${bigIcon}
      </div>
    </div>
  `;
  insightsContainer.appendChild(bikeTile);

  // Wire up the More/Less toggle
  const moreBtn = bikeTile.querySelector('#bike-more-btn');
  const explainDiv = bikeTile.querySelector('#bike-explain');
  if (moreBtn && explainDiv) {
    moreBtn.addEventListener('click', () => {
      explainDiv.classList.toggle('hidden');
      moreBtn.textContent = explainDiv.classList.contains('hidden') ? 'Details' : 'Less';
    });
  }
}

function renderHourly() {
  hourlyContainer.innerHTML = '';
  if (!state.weather) return;
  const next24 = state.weather.next24FromNearest && state.weather.next24FromNearest.length
    ? state.weather.next24FromNearest
    : state.weather.hourly.slice(0, 24);

  next24.forEach(h => {
    const d = document.createElement('div');
    d.className = 'min-w-[90px] rounded-md bg-gray-50 dark:bg-gray-700 p-3 text-center';
    d.innerHTML = `
      <div class="text-xs text-gray-500 dark:text-gray-300">${formatHour(h.time)}</div>
      <div class="flex justify-center mb-1">${createWeatherIconImg(h.weatherCode, 'w-6 h-6')}</div>
      <div class="text-lg font-semibold">${formatTemp(h.temperature)}</div>
      <div class="text-xs">${Math.round(h.precipitationProbability ?? 0)}% rain</div>
      <div class="text-xs">${Math.round(h.windSpeed ?? 0)} km/h</div>
    `;
    hourlyContainer.appendChild(d);
  });
}

function renderDaily() {
  dailyContainer.innerHTML = '';
  if (!state.weather) return;
  state.weather.daily.forEach(d => {
    const el = document.createElement('div');
    el.className = 'rounded-md bg-gray-50 dark:bg-gray-700 p-3 text-center';
    el.innerHTML = `
      <div class="text-sm font-medium">${formatDay(d.date)}</div>
      <div class="flex justify-center mb-1">${createWeatherIconImg(d.weatherCode, 'w-6 h-6')}</div>
      <div class="text-xs text-gray-500 dark:text-gray-300">${d.weatherText}</div>
      <div class="text-lg font-semibold">${formatTemp(d.temperatureMax)} / ${formatTemp(d.temperatureMin)}</div>
      <div class="text-xs">💧 ${Math.round(d.precipitationProbabilityMax ?? 0)}% · 💨 ${Math.round((d.windSpeedMax ?? 0))} km/h</div>
    `;
    dailyContainer.appendChild(el);
  });
}

function renderDailyTempChart() {
  const canvas = document.getElementById('daily-temp-chart');
  if (!canvas || !state.weather || !Array.isArray(state.weather.daily)) return;
  if (typeof window.Chart === 'undefined') return; // Chart.js not loaded
  // Register datalabels plugin once if available
  if (window.Chart && window.ChartDataLabels && !window.__chartDatalabelsRegistered) {
    try { window.Chart.register(window.ChartDataLabels); window.__chartDatalabelsRegistered = true; } catch {}
  }

  const ctx = canvas.getContext('2d');
  const labels = state.weather.daily.map(d => formatDay(d.date));
  const unitSymbol = state.units === 'F' ? '°F' : '°C';
  const bodyStyles = getComputedStyle(document.body);
  const textColor = bodyStyles.color || '#111827'; // gray-900 default
  const gridColor = 'rgba(107,114,128,0.2)'; // gray-500/20

  const toDisplayTempNumber = (celsius) => {
    const c = Number(celsius);
    if (Number.isNaN(c)) return null;
    return state.units === 'F' ? Math.round(cToF(c)) : Math.round(c);
  };

  const tempsMax = state.weather.daily.map(d => toDisplayTempNumber(d.temperatureMax));
  const tempsMin = state.weather.daily.map(d => toDisplayTempNumber(d.temperatureMin));

  if (dailyTempChart) {
    dailyTempChart.destroy();
    dailyTempChart = null;
  }

  dailyTempChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Max (${unitSymbol})`,
          data: tempsMax,
          borderColor: 'rgb(239, 68, 68)', // red-500
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          pointRadius: 3,
          pointHoverRadius: 4,
          borderWidth: 3,
          tension: 0.3,
          spanGaps: true
        },
        {
          label: `Min (${unitSymbol})`,
          data: tempsMin,
          borderColor: 'rgb(59, 130, 246)', // blue-500
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          pointRadius: 3,
          pointHoverRadius: 4,
          borderWidth: 3,
          tension: 0.3,
          spanGaps: true
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
            label: (ctx) => {
              const value = ctx.parsed.y;
              if (value == null) return '';
              return `${ctx.dataset.label}: ${value}${unitSymbol}`;
            }
          }
        },
        datalabels: window.ChartDataLabels ? {
          color: textColor,
          clamp: true,
          anchor: 'end',
          align: 'top',
          offset: 2,
          padding: 2,
          font: { weight: '600', size: 10 },
          formatter: (value) => (value == null ? '' : `${value}${unitSymbol}`)
        } : undefined
      },
      scales: {
        y: {
          ticks: {
            callback: (v) => `${v}${unitSymbol}`,
            color: textColor
          },
          grid: { color: gridColor } // subtle grid
        },
        x: {
          ticks: { color: textColor },
          grid: { display: false }
        }
      }
    }
  });
}

function renderRecentsDropdown() {
  const recents = getRecentLocations();
  recentsList.innerHTML = '';
  if (!recents.length) {
    const empty = document.createElement('div');
    empty.className = 'px-3 py-2 text-sm text-gray-500 dark:text-gray-400';
    empty.textContent = 'No recent locations';
    recentsList.appendChild(empty);
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
  recentsList.appendChild(header);

  recents.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700';
    btn.innerHTML = `
      <div class="font-medium">${escapeHtml(r.name)}</div>
      <div class="text-sm text-gray-500 dark:text-gray-400">${escapeHtml(r.region || '')}${r.region && r.country ? ', ' : ''}${escapeHtml(r.country || '')} · ${Number(r.latitude).toFixed(2)}, ${Number(r.longitude).toFixed(2)}</div>
    `;
    btn.addEventListener('click', async () => {
      recentsList.classList.add('hidden');
      await loadWeather(r);
    });
    recentsList.appendChild(btn);
  });
}

// Utils
function setLocationIndicator(text) {
  if (!locationIndicator) return;
  const trimmed = trimLocationText(text);
  locationIndicator.textContent = trimmed;
}

function setTitleLocation(text) {
  // Keep a static title; do not append current location
  if (appTitle) appTitle.textContent = 'Weather 4 Bike';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
}

function hideToast() {
  toast.classList.add('hidden');
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), delay);
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatHour(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: 'short' });
}

async function safeReverse(lat, lon) {
  try {
    return await reverseGeocode(lat, lon);
  } catch (e) {
    return null;
  }
}

// Unit helpers and labels
function kmhToMph(kmh) { return kmh * 0.621371; }
function cToF(c) { return c * 9 / 5 + 32; }
function kmToMi(km) { return km * 0.621371; }
function degToCardinal(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const ix = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[ix];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreToLabel(score) {
  if (score >= 80) return { label: 'Excellent', emoji: '🟢', colorClass: 'text-green-600' };
  if (score >= 60) return { label: 'Good', emoji: '🟡', colorClass: 'text-yellow-600' };
  if (score >= 40) return { label: 'Fair', emoji: '🟠', colorClass: 'text-orange-600' };
  return { label: 'Poor', emoji: '🔴', colorClass: 'text-red-600' };
}

function scoreColorClasses(score) {
  if (score >= 80) return { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-200' };
  if (score >= 60) return { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-200' };
  if (score >= 40) return { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-200' };
  return { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-200' };
}

function formatTemp(celsius) {
  const c = Math.round(Number(celsius) || 0);
  if (state.units === 'F') {
    return `${Math.round(cToF(c))}°F`;
  }
  return `${c}°C`;
}

function trimLocationText(text) {
  if (!text) return '';
  // Expect "City, State, Country" or "City, State"
  const parts = String(text).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`; // City, State/Region
  return parts[0] || '';
}

// Inline SVG icons
function icon(type) {
  const cls = 'w-5 h-5 text-gray-700 dark:text-gray-200';
  switch (type) {
    case 'wind':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h10a3 3 0 1 0 0-6"/><path d="M2 17h14a3 3 0 1 1-3 3"/><path d="M9 9h6a3 3 0 1 0-3-3"/></svg>`;
    case 'temp':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"/></svg>`;
    case 'humidity':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69 7.05 7.64a7 7 0 1 0 9.9 0Z"/></svg>`;
    case 'visibility':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    case 'flag':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22V4"/></svg>`;
    case 'thermo':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z"/></svg>`;
    case 'uv':
      return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
    default:
      return '';
  }
}

// Map alert type to an icon
function aIcon(type) {
  switch (type) {
    case 'wind':
      return icon('wind');
    case 'visibility':
      return icon('visibility');
    case 'wet':
      return icon('humidity');
    case 'cold':
      return icon('thermo');
    case 'heat':
      return icon('uv');
    default:
      return '';
  }
}

// Weather icon path mapping to flaticon-like assets under assets/icons/weather/
function getWeatherIconPath(code) {
  const map = {
    0: 'sun', // clear
    1: 'sun-cloud', 2: 'sun-cloud', // mainly clear/partly cloudy
    3: 'cloud', // overcast
    45: 'fog', 48: 'fog',
    51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
    61: 'rain', 63: 'rain', 65: 'rain', 80: 'rain', 81: 'rain', 82: 'rain',
    66: 'sleet', 67: 'sleet',
    71: 'snow', 73: 'snow', 75: 'snow', 85: 'snow', 86: 'snow',
    95: 'storm', 96: 'storm', 99: 'storm'
  };
  const name = map[code] || 'cloud';
  return `assets/icons/weather2/static/${name}.svg`;
}

function createWeatherIconImg(code, cls) {
  const basePath = getWeatherIconPath(code);
  const baseName = basePath.split('/').pop().replace('.svg','');
  const altMap = {
    'sun': ['clear', 'day'],
    'sun-cloud': ['partly-cloudy', 'cloudy-day', 'cloudy-1'],
    'cloud': ['cloudy', 'overcast'],
    'fog': ['mist', 'haze'],
    'drizzle': ['light-rain', 'rain-1'],
    'rain': ['rainy', 'rain-2', 'showers'],
    'sleet': ['rain-snow', 'hail'],
    'snow': ['snowy', 'snow-2'],
    'storm': ['thunder', 'thunderstorm']
  };
  const key = Object.keys(altMap).find(k => baseName.includes(k)) || 'cloud';
  const dirA = 'assets/icons/weather2/static';
  const candidates = [
    `${dirA}/${baseName}.svg`,
    ...altMap[key].map(n => `${dirA}/${n}.svg`),
    // try png variants in same dir
    `${dirA}/${baseName}.png`,
    ...altMap[key].map(n => `${dirA}/${n}.png`)
  ];
  const src = candidates[0];
  const onerror = candidates.slice(1).map(u => `this.onerror=null;this.src='${u}'`).join(';');
  return `<img src="${src}" alt="" class="${cls}" onerror="${onerror}" />`;
}


