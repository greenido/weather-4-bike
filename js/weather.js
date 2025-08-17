// Weather API integration for Open-Meteo

const HOURLY_PARAMS = [
  'temperature_2m',
  'relativehumidity_2m',
  'precipitation_probability',
  'precipitation',
  'weathercode',
  'surface_pressure',
  'cloudcover',
  'visibility',
  'windspeed_10m',
  'winddirection_10m',
  'uv_index'
].join(',');

const DAILY_PARAMS = [
  'weathercode',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
  'windspeed_10m_max',
  'uv_index_max'
].join(',');

export async function fetchWeatherData(latitude, longitude) {
  const base = 'https://api.open-meteo.com/v1/forecast';
  const buildUrl = (hourlyParams) => `${base}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&hourly=${hourlyParams}&daily=${DAILY_PARAMS}&timezone=auto&forecast_days=7&past_days=2`;

  // Attempt full set first, then a reduced set to avoid 400 on unsupported variables
  const candidates = [
    HOURLY_PARAMS,
    ['temperature_2m','relativehumidity_2m','precipitation_probability','precipitation','weathercode','cloudcover','windspeed_10m','winddirection_10m'].join(','),
  ];

  let lastError;
  console.groupCollapsed('[weather] Fetch forecast');
  console.info('[weather] coords', { latitude, longitude });
  for (const h of candidates) {
    const url = buildUrl(h);
    console.time(`[weather] request ${h}`);
    console.info('[weather] trying hourly set', h);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await safeReadText(response);
        console.error('[weather] HTTP error', { status: response.status, body });
        throw new Error(`Weather API error ${response.status}: ${body}`);
      }
      const data = await response.json();
      console.info('[weather] success with hourly set', h);
      console.timeEnd(`[weather] request ${h}`);
      console.groupEnd();
      return formatWeatherData(parseWeatherResponse(data));
    } catch (e) {
      console.timeEnd(`[weather] request ${h}`);
      console.warn('[weather] failed hourly set, trying next if available', h, e);
      lastError = e;
      // try next candidate
    }
  }
  console.groupEnd();
  throw lastError || new Error('Weather API error');
}

export function parseWeatherResponse(data) {
  const now = new Date();
  const times = data.hourly?.time || [];
  const nearestIndex = findNearestHourIndex(times, now);

  const current = {
    temperature: data.hourly?.temperature_2m?.[nearestIndex] ?? null,
    humidity: data.hourly?.relativehumidity_2m?.[nearestIndex] ?? null,
    windSpeed: data.hourly?.windspeed_10m?.[nearestIndex] ?? null,
    windDirection: data.hourly?.winddirection_10m?.[nearestIndex] ?? null,
    precipitation: data.hourly?.precipitation?.[nearestIndex] ?? null,
    precipitationProbability: data.hourly?.precipitation_probability?.[nearestIndex] ?? null,
    weatherCode: data.hourly?.weathercode?.[nearestIndex] ?? null,
    uvIndex: data.hourly?.uv_index?.[nearestIndex] ?? null,
    visibility: data.hourly?.visibility?.[nearestIndex] ?? null,
    cloudCover: data.hourly?.cloudcover?.[nearestIndex] ?? null
  };

  const hourly = (times || []).map((iso, idx) => ({
    time: iso,
    temperature: getSafe(data.hourly?.temperature_2m, idx),
    humidity: getSafe(data.hourly?.relativehumidity_2m, idx),
    precipitation: getSafe(data.hourly?.precipitation, idx),
    precipitationProbability: getSafe(data.hourly?.precipitation_probability, idx),
    weatherCode: getSafe(data.hourly?.weathercode, idx),
    windSpeed: getSafe(data.hourly?.windspeed_10m, idx),
    windDirection: getSafe(data.hourly?.winddirection_10m, idx),
    visibility: getSafe(data.hourly?.visibility, idx),
    cloudCover: getSafe(data.hourly?.cloudcover, idx),
    uvIndex: getSafe(data.hourly?.uv_index, idx)
  }));

  const daily = (data.daily?.time || []).map((iso, idx) => ({
    date: iso,
    temperatureMax: getSafe(data.daily?.temperature_2m_max, idx),
    temperatureMin: getSafe(data.daily?.temperature_2m_min, idx),
    precipitationProbabilityMax: getSafe(data.daily?.precipitation_probability_max, idx),
    weatherCode: getSafe(data.daily?.weathercode, idx),
    windSpeedMax: getSafe(data.daily?.windspeed_10m_max, idx),
    uvIndexMax: getSafe(data.daily?.uv_index_max, idx)
  }));

  // Slice next 24 hours starting from nearest index to ensure UI always has data
  const next24FromNearest = hourly.slice(nearestIndex, nearestIndex + 24);
  console.debug('[weather] parsed sizes', {
    hourlyCount: hourly.length,
    dailyCount: daily.length,
    nearestIndex,
    next24FromNearest: next24FromNearest.length
  });
  return { current, hourly, daily, nearestIndex, next24FromNearest };
}

export function formatWeatherData(raw) {
  return {
    ...raw,
    current: {
      ...raw.current,
      weatherText: mapWeatherCodeToText(raw.current.weatherCode)
    },
    hourly: raw.hourly.map(h => ({
      ...h,
      weatherText: mapWeatherCodeToText(h.weatherCode)
    })),
    daily: raw.daily.map(d => ({
      ...d,
      weatherText: mapWeatherCodeToText(d.weatherCode)
    }))
  };
}

function getSafe(arr, idx) {
  return Array.isArray(arr) ? arr[idx] ?? null : null;
}

function findNearestHourIndex(times, now) {
  if (!Array.isArray(times) || times.length === 0) return 0;
  const nowMs = now.getTime();
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    const delta = Math.abs(t - nowMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function mapWeatherCodeToText(code) {
  const lookup = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  return lookup[code] || 'Unknown';
}

async function safeReadText(response) {
  try { return await response.text(); } catch { return ''; }
}


