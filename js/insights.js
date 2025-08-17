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

// New: Road bike score algorithm (1-10) based on wind, temperature, humidity, visibility
export function calculateBikeScore(windSpeedKmh, windDirectionRelation, temperatureC, humidityPct, visibilityKm, uvIndex = 0) {
  let totalScore = 10.0;

  // Wind penalty (0-4)
  let windPenalty = 0;
  if (windSpeedKmh <= 10) windPenalty = 0;
  else if (windSpeedKmh <= 20) windPenalty = 1;
  else if (windSpeedKmh <= 30) windPenalty = 2;
  else if (windSpeedKmh <= 40) windPenalty = 3;
  else windPenalty = 4;

  const dir = String(windDirectionRelation || 'crosswind').toLowerCase();
  if (dir === 'headwind') windPenalty *= 1.3;
  else if (dir === 'tailwind') windPenalty *= 0.7;
  totalScore -= windPenalty;

  // Temperature penalty – harsher above 30°C, "no go" above 35°C
  let tempPenalty = 0;
  if (temperatureC >= 15 && temperatureC <= 25) tempPenalty = 0;
  else if ((temperatureC >= 10 && temperatureC < 15) || (temperatureC > 25 && temperatureC <= 30)) tempPenalty = 1;
  else if ((temperatureC >= 5 && temperatureC < 10)) tempPenalty = 2;
  else if (temperatureC > 30 && temperatureC <= 35) tempPenalty = 3; // much worse when >30
  else if (temperatureC > 35) tempPenalty = 6; // extreme heat, heavy penalty
  else tempPenalty = 3; // too cold (<5)
  totalScore -= tempPenalty;

  // Humidity penalty (0-2) with extra cap when >90%
  let humidityPenalty = 0;
  if (humidityPct <= 60) humidityPenalty = 0;
  else if (humidityPct <= 80) humidityPenalty = 1;
  else humidityPenalty = 2;
  totalScore -= humidityPenalty;
  if (humidityPct >= 90) {
    // Make sure the total is much lower when humidity is extremely high
    totalScore = Math.min(totalScore, 4.0);
  }

  // Visibility penalty (0-3), visibilityKm expected in km
  let visibilityPenalty = 0;
  if (visibilityKm >= 10) visibilityPenalty = 0;
  else if (visibilityKm >= 5) visibilityPenalty = 1;
  else if (visibilityKm >= 2) visibilityPenalty = 2;
  else visibilityPenalty = 3;
  totalScore -= visibilityPenalty;

  // UV penalty (0–2)
  let uvPenalty = 0;
  if (uvIndex <= 5) uvPenalty = 0;
  else if (uvIndex <= 7) uvPenalty = 0.5;
  else if (uvIndex <= 9) uvPenalty = 1.0;
  else uvPenalty = 1.5;
  totalScore -= uvPenalty;

  // Hard cap for extreme heat "no go"
  if (temperatureC > 35) {
    totalScore = Math.min(totalScore, 2.0);
  }

  const finalScore = Math.max(1, Math.min(10, Math.round(totalScore * 10) / 10));
  let message;
  if (finalScore >= 8) message = 'Perfect conditions! Go for that long ride! 🚴‍♂️';
  else if (finalScore >= 6) message = 'Good conditions for cycling. Enjoy your ride!';
  else if (finalScore >= 4) message = 'Decent conditions, but be prepared for some challenges.';
  else if (finalScore >= 3) message = "Challenging conditions. Only go if you're experienced.";
  else message = 'Poor conditions. Consider indoor training.';

  // UV recommendation
  if (uvIndex >= 7) {
    message += ' Consider riding early or late due to high UV.';
  }

  return {
    score: finalScore,
    message,
    breakdown: {
      windPenalty: Math.round(windPenalty * 10) / 10,
      temperaturePenalty: tempPenalty,
      humidityPenalty,
      visibilityPenalty,
      uvPenalty: Math.round(uvPenalty * 10) / 10
    }
  };
}

export function calculateBikeScoreFromWeather(weatherData, windRelation = 'crosswind') {
  const c = weatherData.current || {};
  const windKmh = kph(c.windSpeed);
  const tempC = Number(c.temperature) || 0;
  const rh = Number(c.humidity) || 0;
  const visKm = Math.max(0, Number(c.visibility || 0) / 1000);
  const uv = Number(c.uvIndex) || 0;
  return calculateBikeScore(windKmh, windRelation, tempC, rh, visKm, uv);
}

// Gravel: higher wind sensitivity and harsher heat penalties
export function calculateGravelScoreFromWeather(weatherData) {
  const c = weatherData.current || {};
  const windKmh = kph(c.windSpeed);
  const tempC = Number(c.temperature) || 0;
  const rh = Number(c.humidity) || 0;
  const visKm = Math.max(0, Number(c.visibility || 0) / 1000);
  const uv = Number(c.uvIndex) || 0;

  let totalScore = 10.0;
  // Wind: +50% harsher than road, assume crosswind base
  let windPenalty = 0;
  if (windKmh <= 10) windPenalty = 0; else if (windKmh <= 20) windPenalty = 1; else if (windKmh <= 30) windPenalty = 2; else if (windKmh <= 40) windPenalty = 3; else windPenalty = 4;
  windPenalty *= 1.5;
  totalScore -= windPenalty;

  // Temperature: harsher above 30, "no go" above 35
  let tempPenalty = 0;
  if (tempC >= 15 && tempC <= 25) tempPenalty = 0;
  else if ((tempC >= 10 && tempC < 15) || (tempC > 25 && tempC <= 30)) tempPenalty = 1;
  else if (tempC >= 5 && tempC < 10) tempPenalty = 2;
  else if (tempC > 30 && tempC <= 35) tempPenalty = 4;
  else if (tempC > 35) tempPenalty = 7;
  else tempPenalty = 3;
  totalScore -= tempPenalty;

  // Humidity: same base penalties, but >90% cap lower
  let humidityPenalty = 0;
  if (rh <= 60) humidityPenalty = 0; else if (rh <= 80) humidityPenalty = 1; else humidityPenalty = 2;
  totalScore -= humidityPenalty;
  if (rh >= 90) totalScore = Math.min(totalScore, 3.5);

  // Visibility
  let visibilityPenalty = 0;
  if (visKm >= 10) visibilityPenalty = 0; else if (visKm >= 5) visibilityPenalty = 1; else if (visKm >= 2) visibilityPenalty = 2; else visibilityPenalty = 3;
  totalScore -= visibilityPenalty;

  // UV penalty
  let uvPenalty = 0;
  if (uv <= 5) uvPenalty = 0; else if (uv <= 7) uvPenalty = 0.5; else if (uv <= 9) uvPenalty = 1.0; else uvPenalty = 1.5;
  totalScore -= uvPenalty;

  if (tempC > 35) totalScore = Math.min(totalScore, 2.0);
  const finalScore = Math.max(1, Math.min(10, Math.round(totalScore * 10) / 10));
  const message = (finalScore >= 8 ? 'Great day for gravel!' : finalScore >= 6 ? 'Good gravel conditions.' : finalScore >= 4 ? 'Manageable gravel, expect challenges.' : finalScore >= 3 ? 'Challenging gravel conditions.' : 'Poor gravel conditions.') + (uv >= 7 ? ' Consider riding early or late due to high UV.' : '');
  return {
    score: finalScore,
    message,
    breakdown: { windPenalty: Math.round(windPenalty * 10) / 10, temperaturePenalty: tempPenalty, humidityPenalty, visibilityPenalty, uvPenalty: Math.round(uvPenalty * 10) / 10 }
  };
}

// MTB: standard wind, harsher heat penalties
export function calculateMTBScoreFromWeather(weatherData) {
  const c = weatherData.current || {};
  const windKmh = kph(c.windSpeed);
  const tempC = Number(c.temperature) || 0;
  const rh = Number(c.humidity) || 0;
  const visKm = Math.max(0, Number(c.visibility || 0) / 1000);
  const uv = Number(c.uvIndex) || 0;

  let totalScore = 10.0;
  let windPenalty = 0;
  if (windKmh <= 10) windPenalty = 0; else if (windKmh <= 20) windPenalty = 1; else if (windKmh <= 30) windPenalty = 2; else if (windKmh <= 40) windPenalty = 3; else windPenalty = 4;
  totalScore -= windPenalty;

  let tempPenalty = 0;
  if (tempC >= 15 && tempC <= 25) tempPenalty = 0;
  else if ((tempC >= 10 && tempC < 15) || (tempC > 25 && tempC <= 30)) tempPenalty = 1;
  else if (tempC >= 5 && tempC < 10) tempPenalty = 2;
  else if (tempC > 30 && tempC <= 35) tempPenalty = 4;
  else if (tempC > 35) tempPenalty = 7;
  else tempPenalty = 3;
  totalScore -= tempPenalty;

  let humidityPenalty = 0;
  if (rh <= 60) humidityPenalty = 0; else if (rh <= 80) humidityPenalty = 1; else humidityPenalty = 2;
  totalScore -= humidityPenalty;
  if (rh >= 90) totalScore = Math.min(totalScore, 3.5);

  let visibilityPenalty = 0;
  if (visKm >= 10) visibilityPenalty = 0; else if (visKm >= 5) visibilityPenalty = 1; else if (visKm >= 2) visibilityPenalty = 2; else visibilityPenalty = 3;
  totalScore -= visibilityPenalty;

  // UV penalty
  let uvPenalty = 0;
  if (uv <= 5) uvPenalty = 0; else if (uv <= 7) uvPenalty = 0.5; else if (uv <= 9) uvPenalty = 1.0; else uvPenalty = 1.5;
  totalScore -= uvPenalty;

  if (tempC > 35) totalScore = Math.min(totalScore, 2.0);
  const finalScore = Math.max(1, Math.min(10, Math.round(totalScore * 10) / 10));
  const message = (finalScore >= 8 ? 'Trails are prime!' : finalScore >= 6 ? 'Good day to ride.' : finalScore >= 4 ? 'Rideable with caution.' : finalScore >= 3 ? 'Challenging trail conditions.' : 'Not recommended today.') + (uv >= 7 ? ' Consider riding early or late due to high UV.' : '');
  return {
    score: finalScore,
    message,
    breakdown: { windPenalty: Math.round(windPenalty * 10) / 10, temperaturePenalty: tempPenalty, humidityPenalty, visibilityPenalty, uvPenalty: Math.round(uvPenalty * 10) / 10 }
  };
}


