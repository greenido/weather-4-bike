// Cycling-specific insights and safety alerts

export function calculateRoadCyclingScore(weatherData) {
  const c = weatherData.current;
  // Temperature score (optimal 10-25°C)
  const temperatureScore = scoreRange(c.temperature, 10, 25, -10, 40);
  // Wind speed impact (km/h) – ideal < 15, degrade after 25
  const windSpeed = kph(c.windSpeed);
  const windScore = clamp(100 - normalize(windSpeed, 0, 40) * 100, 0, 100);
  // Precipitation probability
  const precipProb = c.precipitationProbability ?? 0;
  const precipitationScore = clamp(100 - normalize(precipProb, 0, 100) * 100, 0, 100);
  // UV index: moderate penalty when >6
  const uv = c.uvIndex ?? 0;
  const uvPenalty = uv <= 6 ? 0 : Math.min((uv - 6) * 5, 20);

  // Weighted score
  const score = (
    temperatureScore * 0.4 +
    windScore * 0.3 +
    precipitationScore * 0.25 +
    (100 - uvPenalty) * 0.05
  );
  return Math.round(clamp(score, 0, 100));
}

export function calculateGravelConditions(weatherData) {
  const last48h = estimateRecentPrecipSum(weatherData, 48);
  const temp = weatherData.current.temperature;
  let mudFactor = 0;
  if (last48h >= 20) mudFactor = 3;
  else if (last48h >= 10) mudFactor = 2;
  else if (last48h >= 3) mudFactor = 1;
  else mudFactor = 0;

  const comfort = scoreRange(temp, 8, 22, -10, 40);
  return { mudFactor, comfort: clamp(comfort, 0, 100) };
}

export function calculateMTBTrailReadiness(weatherData) {
  const last72h = estimateRecentPrecipSum(weatherData, 72);
  const humidityNow = weatherData.hourly[0]?.humidity ?? weatherData.current.humidity ?? 50;
  const wind = kph(weatherData.current.windSpeed);
  const temp = weatherData.current.temperature;

  // Start from 100 and apply penalties
  let score = 100;
  // Trail drying time – heavy rain recently penalizes
  if (last72h > 30) score -= 35;
  else if (last72h > 15) score -= 20;
  else if (last72h > 5) score -= 10;
  // Humidity affects dust/traction
  if (humidityNow < 30) score -= 10; // dusty
  if (humidityNow > 90) score -= 10; // greasy
  // Wind conditions for technical sections
  if (wind > 35) score -= 15;
  if (wind > 25) score -= 10;
  // Comfort temp
  score += (scoreRange(temp, 8, 24, -10, 40) - 70) * 0.5; // small influence

  return Math.round(clamp(score, 0, 100));
}

export function generateSafetyAlerts(weatherData) {
  const alerts = [];
  const c = weatherData.current;
  const wind = kph(c.windSpeed);
  if (wind >= 25) alerts.push({ type: 'wind', severity: wind >= 40 ? 'high' : 'moderate', message: 'Strong winds may affect bike handling.' });
  if ((c.visibility ?? 10000) < 2000) alerts.push({ type: 'visibility', severity: 'moderate', message: 'Low visibility. Use lights and high-visibility gear.' });
  if ((c.precipitation ?? 0) > 0 || (c.precipitationProbability ?? 0) > 60) alerts.push({ type: 'wet', severity: 'moderate', message: 'Wet conditions possible. Increase braking distance.' });
  const t = c.temperature ?? 15;
  if (t <= 0) alerts.push({ type: 'cold', severity: 'high', message: 'Freezing temperatures. Risk of ice.' });
  if (t >= 35) alerts.push({ type: 'heat', severity: 'high', message: 'High heat. Hydrate and avoid peak sun hours.' });
  return alerts;
}

// Helpers
function estimateRecentPrecipSum(weatherData, hoursBack) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - hoursBack * 3600 * 1000);
  return weatherData.hourly.reduce((sum, h) => {
    const t = new Date(h.time);
    if (t >= cutoff && t <= now) {
      const p = Number(h.precipitation ?? 0);
      if (!Number.isNaN(p)) return sum + p;
    }
    return sum;
  }, 0);
}

function scoreRange(value, optimalMin, optimalMax, absoluteMin, absoluteMax) {
  if (value == null || Number.isNaN(value)) return 50;
  if (value >= optimalMin && value <= optimalMax) return 100;
  if (value <= absoluteMin || value >= absoluteMax) return 0;
  if (value < optimalMin) {
    return Math.max(0, 100 * (value - absoluteMin) / (optimalMin - absoluteMin));
  } else {
    return Math.max(0, 100 * (absoluteMax - value) / (absoluteMax - optimalMax));
  }
}

function normalize(value, min, max) {
  if (value == null) return 0.5;
  return clamp((value - min) / (max - min), 0, 1);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function kph(kmh) {
  if (kmh == null) return 0;
  return Math.round(kmh * 10) / 10;
}

// Apply global environment penalties to any 0-100 score
export function applyEnvironmentalPenalties(baseScore, weatherData) {
  let score = baseScore;
  const c = weatherData.current || {};
  const t = Number(c.temperature);
  const rh = Number(c.humidity);

  if (!Number.isNaN(t)) {
    // Heat penalties: > 30°C strongly reduces score
    if (t > 30) {
      const heatPenalty = Math.min(60, 15 + (t - 30) * 3); // 35°C => 30, 40°C => 45
      score -= heatPenalty;
      // High humidity + heat: cap below 40 (i.e., < 4/10)
      if (!Number.isNaN(rh) && rh >= 70) {
        score = Math.min(score - 10, 35);
      }
    }
    // Cold penalties: < 10°C reduces score
    if (t < 10) {
      const coldPenalty = Math.min(50, 10 + (10 - t) * 2); // 0°C => 30
      score -= coldPenalty;
    }
  }

  return clamp(Math.round(score), 0, 100);
}


