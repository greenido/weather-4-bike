# Weather 4 Bike

Cycling-focused weather app providing actionable insights for road, gravel, and mountain biking.

## Features

- Smart activity insights with safety alerts (wind, visibility, wet roads, heat/cold stress)
- Geolocation first, city search fallback (Open‑Meteo Geocoding)
- Hourly (next 24 hours) and 7‑day forecasts
- Recent locations (localStorage)
- Mobile-first UI with Tailwind, dark mode, and iconography
- Units toggle: Celsius (default) or Fahrenheit

## Demo (Local)

Serve the repo with a static server (needed for module imports):

```bash
# Example using Python
cd weather-4-bike
python3 -m http.server 9000

# or
php -S localhost:9000

# then open http://localhost:9000/
```

Or use any dev server (MAMP, VSCode Live Server, nginx, etc.).

## Deploy to GitHub Pages

1. Create a new GitHub repository (or use existing) and push this project to the root of the default branch (e.g., `main`).
2. Add a file named `.nojekyll` at the project root (already included) to ensure assets are served as-is.
3. In GitHub → Settings → Pages:
   - Source: Deploy from a branch
   - Branch: `main` (or your default) / Root (`/`)
4. Save. After a minute, your site will be available at `https://<username>.github.io/<repo>/`.

Notes:
- This is a pure static site (HTML/JS/CSS), so no build is required.
- If using a custom domain, configure it in Pages settings and add a `CNAME` file.

## APIs

- Forecast: Open‑Meteo Forecast API
  - Endpoint: `https://api.open-meteo.com/v1/forecast`
  - Hourly fields used: `temperature_2m,relativehumidity_2m,precipitation_probability,precipitation,weathercode,surface_pressure,cloudcover,visibility,windspeed_10m,winddirection_10m,uv_index`
  - Daily fields used: `weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max,uv_index_max`
- Geocoding (search): `https://geocoding-api.open-meteo.com/v1/search`
- Reverse Geocoding: BigDataCloud no‑key endpoint
  - `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude={lat}&longitude={lon}&localityLanguage=en`

## Project Structure

```
index.html
styles/
  input.css
  output.css
js/
  app.js       # App bootstrap + rendering (UI, units, icons, events)
  weather.js   # Open‑Meteo fetch + parsing + formatting
  location.js  # Geolocation, geocoding, recents
  insights.js  # Cycling insights, penalties, safety alerts
assets/
  icons/
    weather2/static/   # Weather icon set (svg/png)
  images/
weather_icons_1/ (optional legacy)
```

## UI Overview

- Header: title + bike icon, location indicator, search, geolocation button, units toggle, recents
- Current Conditions card: large temp, background weather icon, compact metrics grid
- Activity Insights: score (1–10), alerts, “Biking Conditions” tile with key factors and recommendations
- Next 24 hours: horizontal scroll of hourly cards (time, temp, precip, wind)
- 7‑Day forecast: compact daily cards (icon, text, hi/lo, precip, wind)
- Scenic banner: Unsplash Source (hidden automatically on error)

## Units

- Default is Celsius (°C). Toggle to Fahrenheit (°F) via header buttons.
- Temperatures are formatted via `formatTemp()` so values remain consistent across the app.
- Wind is shown in km/h. Visibility shown in km (mi in some tiles). Extendable for full unit toggling.

## Scoring & Safety

- Activity scoring combines temperature, wind, precipitation, UV, humidity and recent precip (for gravel/MTB).
- Environmental penalties (global):
  - Heat: > 30°C reduces score; with humidity ≥ 70%, caps below 4/10
  - Cold: < 10°C reduces score
- Safety alerts flag wind, low visibility, wet roads, heat/cold extremes.

## Icons

- Weather icons are loaded from `assets/icons/weather2/static/` with runtime fallbacks for common file names.
- Replace the set with your preferred SVG pack by dropping files into that folder; no code changes needed if file names match.

## Development Notes

- Tailwind is loaded via CDN for MVP. When ready, compile `styles/input.css` → `styles/output.css` and replace the CDN script with a `<link>` tag.
- The app uses ES modules. Serve over HTTP to avoid CORS/file loading issues.
- If the weather fetch fails, the console logs print the exact hourly set tried and response body from Open‑Meteo.

## Accessibility

- Keyboard friendly controls, ARIA on buttons, high contrast in dark mode, large touch targets on mobile.

## License

- Code: MIT
- Icons: see the license of the icon set used in `assets/icons/weather2/static/`
- Unsplash: subject to Unsplash Source usage terms
