# Weather 4 Bike

Cycling-focused weather app that turns a forecast into a ride decision, for road, gravel, and MTB.

## Features

- **"When should I ride?"** — scores every hour of the week and finds the best contiguous window of daylight, for the ride length you choose. Shows today's best and flags when later in the week is better
- **Route-aware wind** — pick which way you head out and it scores the outbound and return legs separately, then tells you which direction to start in
- **Real surface conditions** — gravel and MTB scores use the model's soil moisture, not a rainfall total, so it knows a trail has already dried
- **Wind chill at riding speed** — what it actually feels like at 28 km/h, not standing still
- **Compare locations** — score your saved spots side by side and see where the riding is best
- **Calibrated to you** — set your own comfortable temperature range and typical speed
- Rideability score (1–10) per discipline, with a transparent penalty breakdown
- Rain timing ("dry until 2pm" / "clearing around 4pm") rather than just a daily percentage
- Safety alerts: wind, gusts, visibility, fog, ice risk, heat, thunderstorms, UV, air quality
- Kit and pacing recommendations driven by the actual conditions
- Sunrise/sunset, wind gusts, feels-like temperature, and AQI
- Hourly strip colour-coded by rideability; 7-day outlook with a temperature chart
- Geolocation first, city search fallback, recent locations
- Full metric/imperial switching (°C·km/h·km ↔ °F·mph·mi), persisted
- Every time is shown on the forecast location's clock — check Tel Aviv from California and "now" is Tel Aviv's now
- Installable PWA with offline support that works on a *bad* connection, not only a dead one, and says how old a saved forecast is
- Follows your system theme by default; a header toggle overrides it and is remembered. Applied before first paint, so no flash
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
| `npm run build` | Everything below that produces a committed artifact |
| `npm run build:css` | Compile `styles/input.css` → `styles/output.css` (minified) |
| `npm run build:sw` | Stamp the service worker cache version from the app-shell hash |
| `npm run watch:css` | CSS build in watch mode |
| `npm test` | Run the unit tests (`node --test`) |

CI runs the tests and then runs `npm run build`, failing if it leaves the tree dirty. Both `styles/output.css` and the `VERSION` in `sw.js` are committed artifacts, so "changed the markup, forgot to rebuild" would otherwise ship broken styling or a stale offline cache behind a clean-looking diff.

**Rebuild the CSS after changing markup or class names.** Tailwind purges anything it cannot see, and the compiled `styles/output.css` is committed on purpose — GitHub Pages serves this repo as-is with no build step.

### Theming

Tailwind runs in `darkMode: 'class'`, so the theme lives on `<html class="dark">`.

There are two sources of truth, in priority order:

1. **An explicit choice**, stored under `w4b:theme`. Written only when the rider clicks the toggle.
2. **The OS setting**, via `prefers-color-scheme`. Used whenever nothing is stored — which is also the default for a first-time visitor. While in this mode the page tracks live OS changes, so flipping your system theme updates an already-open tab.

The theme is applied by a small **blocking** script in `<head>`. It has to be blocking: `js/app.js` is a deferred module, so applying the theme there would render one frame in the wrong theme. If you change `THEME_KEY` or `systemTheme()` in `js/app.js`, update that inline script to match — it deliberately duplicates that logic.

There is no "reset to system" control; clearing `w4b:theme` in devtools returns to following the OS.

> Colour classes used at runtime (score tiers, activity tabs) are written as **complete literal strings** in the lookup tables at the top of `js/app.js`. Tailwind's scanner cannot see a class name assembled by concatenation, so never build one with string interpolation.

### Tests

Everything outside `app.js` is pure and dependency-free, so it is directly testable:

```bash
npm test
```

161 tests cover the penalty model, unknown-vs-zero handling, hard hazard ceilings, per-discipline weighting, the best-window search, rain timing, unit conversion, time zones, request races and timeouts, and the service worker.

- **Time-zone tests run under several process zones** (`inZone` in `test/helpers.js`). The time-zone bug only exists when the viewer's zone differs from the location's, and CI runs in UTC — a test that just runs "normally" passes while the app is wrong for everyone else.
- **`sw.js` is tested as shipped.** It is a classic worker script, not a module, so `test/sw.test.js` runs the real file in a Node VM with fake `caches` and `fetch`.
- **`app.js` is not unit-tested** — it is DOM glue. Its request-ordering logic lives in `createLatestGate` (`js/net.js`), which is.

### Time

Forecasts are requested with `timeformat=unixtime`, so every time in the app is an exact instant and all the arithmetic in `insights.js` needs no zone at all. The location's IANA zone is applied only when turning an instant into text, in `js/time.js`.

Do not go back to the API's default ISO strings: they are location-local with no offset, so `new Date()` reads them in the *viewer's* zone. That made "now" in Tel Aviv, viewed from California, eleven hours stale. A daily date from the API is local midnight, which is the previous day in UTC east of Greenwich — read it with `localDateKey`, never `.slice(0, 10)`.

### Requests

- **Only the newest request may change the screen.** `loadWeather` and city search each take a ticket from a `createLatestGate`; starting a new request aborts the old one, and a late answer is dropped. Without this, tapping one city then another could show — and save as your location — whichever answered last.
- **Everything has a deadline.** The service worker answers from its saved copy after 6 s; the page gives up after 15 s and shows the retry banner. The page's deadline must stay longer than the worker's, or the saved copy never gets its chance.
- **Only an HTTP 400 is retried** with the reduced variable set. A timeout or network failure would fail the same way, after making the rider wait twice.
- **Saved copies say how old they are.** The worker stamps `w4bFetchedAt` into each forecast it saves, and the page shows "Updated 8 min ago" or "Offline · forecast from 3 h ago" — never the time it happened to render.

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
  time.js          # Location-zone formatting and data freshness  (pure, no DOM)
  net.js           # Request deadlines and "latest request wins"  (pure, no DOM)
test/
  helpers.js       # inZone(), deferred()
  insights.test.js
  units.test.js
  time.test.js
  net.test.js
  weather.test.js  # Parsing and fetch policy, against a Tel Aviv fixture
  sw.test.js       # The real sw.js, in a VM
assets/
  icons/weather2/static/   # Weather icon set
```

`insights.js`, `units.js`, `time.js` and `net.js` have no DOM or storage dependencies — that is what makes them testable, and it is worth keeping that way.

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
| Wind chill on the bike | 0–1.5 | Below freezing only, at the airspeed a moving rider meets |
| Surface | 0–3 | Gravel and MTB only |
| Dust / loose | 0–1 | Gravel and MTB only, at the dry end |

Per-discipline weights:

| Factor | Road | Gravel | MTB |
| --- | --- | --- | --- |
| Wind | ×1.0 | ×1.5 | ×0.7 |
| Gusts | ×1.0 | ×1.0 | ×0.6 |
| Precipitation | ×1.2 | ×1.0 | ×0.9 |
| Surface | — | ×0.8 | ×1.0 |
| Dust / loose | — | ×0.4 | ×0.6 |
| Riding speed (for chill) | 28 km/h | 22 km/h | 15 km/h |

### Surface

Gravel and MTB scores read the forecast model's **volumetric soil water content** for the top layer, which already accounts for drying by sun, wind and evapotranspiration — the thing a rainfall total cannot see. Both ends cost points: saturated is mud, bone-dry is loose and blown out, and "tacky" in between is free. Where a model does not publish soil moisture, it falls back to accumulated rainfall over 48 h (gravel) or 72 h (MTB), and the UI says so.

### Personal calibration

The comfort band defaults to 15–25°C and can be moved in Settings. With the default band the penalties are numerically identical to the old fixed thresholds — there is a test pinning that.

**Unknown is not zero.** If the forecast model does not report a variable for a location, that penalty is skipped and listed under "Score details", rather than being counted as a zero reading. A missing visibility value must not cost a rider three points.

**Hard ceilings** override everything: extreme heat (2.0), thunderstorms (1.5), freezing rain (1.5), near-freezing with precipitation (2.5), snow (2.0 road / 3.0 off-road).

**Bands:** 🟢 8–10 Excellent · 🟡 6–8 Good · 🟠 4–6 Fair · 🔴 2.5–4 Poor · ⛔ below 2.5 Skip it. One tier function drives the badge, the colour, and the wording, so they cannot disagree.

## APIs

All keyless and CORS-enabled:

- **Forecast** — `https://api.open-meteo.com/v1/forecast`
  Hourly: `temperature_2m, apparent_temperature, relativehumidity_2m, precipitation_probability, precipitation, weathercode, surface_pressure, cloudcover, visibility, windspeed_10m, winddirection_10m, windgusts_10m, uv_index`
  Daily: `weathercode, temperature_2m_max/min, apparent_temperature_max/min, precipitation_probability_max, precipitation_sum, windspeed_10m_max, windgusts_10m_max, uv_index_max, sunrise, sunset`
  Requested with `past_days=3` — the mud/surface factor needs recent rainfall — and `timezone=auto&timeformat=unixtime` (see [Time](#time)).
- **Air quality** — `https://air-quality-api.open-meteo.com/v1/air-quality` (best-effort; failure never blocks the forecast)
- **Geocoding** — `https://geocoding-api.open-meteo.com/v1/search`
- **Reverse geocoding** — BigDataCloud, no key required

Responses are cached in `sessionStorage` (10 min for forecasts, 30 min for air quality). The refresh button bypasses the cache. The service worker keeps the last good forecast per location in `w4b-data-v1`, which deliberately does not change name when the app is redeployed.

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
