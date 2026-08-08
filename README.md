# Weather 4 Bike

Cycling-focused weather app that turns a forecast into a ride decision, for road, gravel, and MTB.

## Features

- **"When should I ride?"** — scores every upcoming hour and finds the best contiguous window in the next 24 hours of daylight
- Rideability score (1–10) per discipline, with a transparent penalty breakdown
- Rain timing ("dry until 2pm" / "clearing around 4pm") rather than just a daily percentage
- Safety alerts: wind, gusts, visibility, fog, ice risk, heat, thunderstorms, UV, air quality
- Kit and pacing recommendations driven by the actual conditions
- Sunrise/sunset, wind gusts, feels-like temperature, and AQI
- Hourly strip colour-coded by rideability; 7-day outlook with a temperature chart
- Geolocation first, city search fallback, recent locations
- Full metric/imperial switching (°C·km/h·km ↔ °F·mph·mi), persisted
- Installable PWA with offline support
- Manual dark/light toggle, persisted, applied before first paint (no flash)
- Mobile-first, keyboard accessible

## Run locally

The app uses ES modules, so it must be served over HTTP:

```bash
python3 -m http.server 9000
```

Then open `http://localhost:9000/`.

## Development

```bash
npm install
```

| Command | What it does |
| --- | --- |
| `npm run build:css` | Compile `styles/input.css` → `styles/output.css` (minified) |
| `npm run watch:css` | Same, in watch mode |
| `npm test` | Run the unit tests (`node --test`) |

**Rebuild the CSS after changing markup or class names.** Tailwind purges anything it cannot see, and the compiled `styles/output.css` is committed on purpose — GitHub Pages serves this repo as-is with no build step.

Tailwind runs in `darkMode: 'class'`, so the theme lives on `<html class="dark">` rather than following the OS. It is stored under `w4b:theme` and applied by a small **blocking** script in `<head>`: the app module is deferred, so applying it there would render one frame in the wrong theme. If you change `THEME_KEY` or `DEFAULT_THEME` in `js/app.js`, update that inline script to match.

> Colour classes used at runtime (score tiers, activity tabs) are written as **complete literal strings** in the lookup tables at the top of `js/app.js`. Tailwind's scanner cannot see a class name assembled by concatenation, so never build one with string interpolation.

### Tests

The scoring engine is pure and dependency-free, so it is directly testable:

```bash
npm test
```

63 tests cover the penalty model, unknown-vs-zero handling, hard hazard ceilings, per-discipline weighting, the best-window search, rain timing, and unit conversion.

## Architecture

```
index.html
sw.js              # Service worker: app shell cache-first, API network-first
tailwind.config.js
styles/
  input.css        # Source
  output.css       # Compiled — committed, do not edit by hand
js/
  app.js           # UI controller: state, events, rendering
  weather.js       # Open-Meteo fetch, parsing, caching, air quality
  location.js      # Geolocation, geocoding, recents
  insights.js      # Scoring, alerts, best-window search  (pure, no DOM)
  units.js         # Unit systems and all display formatting  (pure, no DOM)
test/
  insights.test.js
  units.test.js
assets/
  icons/weather2/static/   # Weather icon set
```

`insights.js` and `units.js` have no DOM or storage dependencies — that is what makes them testable, and it is worth keeping that way.

## Scoring

Every score starts at **10.0** and subtracts penalties, clamped to 1–10.

| Penalty | Range | Notes |
| --- | --- | --- |
| Wind | 0–4 | Headwind ×1.3, tailwind ×0.7, crosswind ×1.0 |
| Gusts | 0–1.5 | Based on gust-minus-mean spread |
| Temperature | 0–6 | Uses feels-like when available |
| Precipitation | 0–5 | Worse of probability and intensity |
| Humidity | 0–2 | ≥90% caps the total at 4 |
| Visibility | 0–3 | |
| UV | 0–1.5 | |
| Surface / mud | 0–3 | Gravel and MTB only |

Per-discipline weights:

| Factor | Road | Gravel | MTB |
| --- | --- | --- | --- |
| Wind | ×1.0 | ×1.5 | ×0.7 |
| Gusts | ×1.0 | ×1.0 | ×0.6 |
| Precipitation | ×1.2 | ×1.0 | ×0.9 |
| Surface / mud | — | ×0.8 (48 h) | ×1.0 (72 h) |

**Unknown is not zero.** If the forecast model does not report a variable for a location, that penalty is skipped and listed under "Score details", rather than being counted as a zero reading. A missing visibility value must not cost a rider three points.

**Hard ceilings** override everything: extreme heat (2.0), thunderstorms (1.5), freezing rain (1.5), near-freezing with precipitation (2.5), snow (2.0 road / 3.0 off-road).

**Bands:** 🟢 8–10 Excellent · 🟡 6–8 Good · 🟠 4–6 Fair · 🔴 2.5–4 Poor · ⛔ below 2.5 Skip it. One tier function drives the badge, the colour, and the wording, so they cannot disagree.

## APIs

All keyless and CORS-enabled:

- **Forecast** — `https://api.open-meteo.com/v1/forecast`
  Hourly: `temperature_2m, apparent_temperature, relativehumidity_2m, precipitation_probability, precipitation, weathercode, surface_pressure, cloudcover, visibility, windspeed_10m, winddirection_10m, windgusts_10m, uv_index`
  Daily: `weathercode, temperature_2m_max/min, apparent_temperature_max/min, precipitation_probability_max, precipitation_sum, windspeed_10m_max, windgusts_10m_max, uv_index_max, sunrise, sunset`
  Requested with `past_days=3` — the mud/surface factor needs recent rainfall.
- **Air quality** — `https://air-quality-api.open-meteo.com/v1/air-quality` (best-effort; failure never blocks the forecast)
- **Geocoding** — `https://geocoding-api.open-meteo.com/v1/search`
- **Reverse geocoding** — BigDataCloud, no key required

Responses are cached in `sessionStorage` (10 min for forecasts, 30 min for air quality). The refresh button bypasses the cache.

Add `?debug=1` to the URL for verbose fetch logging.

## Optional: scenic photo

The scenic Unsplash banner is **off by default and ships no API key**. To enable it, create `js/config.local.js` (git-ignored):

```js
window.UNSPLASH_ACCESS_KEY = 'your-key-here';
```

and uncomment the corresponding `<script>` tag in `index.html`. Never commit a key — this repository is public.

## Icons

Weather icons load from `assets/icons/weather2/static/`. Each weather code has an ordered fallback chain; if a file is missing, the next candidate is tried one at a time. The pack has no sleet glyph, so freezing-rain codes (66/67) use the rain-snow mix — drop in a `sleet.svg` and update the two lines in `ICON_BY_CODE` if you want a dedicated one.

## Accessibility

- City search is a proper ARIA combobox: arrow keys, Enter, Escape, `aria-activedescendant`
- Activity tabs use the roving-tabindex pattern (arrows, Home/End)
- Help dialog traps focus, closes on Escape, and restores focus to its trigger
- Toast is an `aria-live` region; the error banner is `role="alert"`
- Skip-to-content link, and `prefers-reduced-motion` is respected

## Deploy to GitHub Pages

Pure static site — no build step on the server. Push to the default branch, then Settings → Pages → Deploy from a branch → `main` / root. `.nojekyll` is already present.

Remember to run `npm run build:css` and commit `styles/output.css` before pushing if you changed any markup.

## License

- Code: MIT
- Icons: see the license in `assets/icons/weather2/`
