## Weather 4 Bike: Turning Raw Forecasts Into Actionable Rides [Aug 2025]
 
### Why this project
Most weather apps tell you the conditions. Cyclists need to know what those conditions mean for the ride. Weather 4 Bike translates forecast data into clear, activity‑aware guidance for road, gravel, and MTB—so you can decide when and where to ride with confidence.

### What it does
- Smart, activity‑specific scoring (1–10) with human‑readable recommendations
- Current, hourly (next 24h), and 7‑day forecast cards
- Geolocation on load with city search fallback and recent locations
- “Biking Conditions” tile with key factors and a collapsible details panel
- Dark mode, responsive design, and a mobile hamburger header

### How scoring works (road, gravel, mtb)
Scores start at 10 and deduct points based on: wind (speed and, for road, relative direction), temperature bands, humidity, visibility, and UV. We cap scores for extreme heat and very high humidity to keep advice realistic.

- Wind: thresholds penalize speed; road supports head/tail/crosswind modifiers
- Temperature: ideal 15–25°C; >30°C increases penalty; >35°C can drop to “no go”
- Humidity: >90% caps the final score lower
- Visibility: <10 km adds penalty, more below 5/2 km
- UV: high UV adds a penalty and suggests riding early/late

The details drawer shows a breakdown (wind/temperature/humidity/visibility/UV) so riders understand the “why.”

### Tech stack and architecture
- HTML + Tailwind CDN for fast iteration
- Vanilla JS modules for clear separation of concerns
  - `js/weather.js`: Open‑Meteo fetch + parse + format
  - `js/location.js`: geolocation, geocoding, recents, persisted last location
  - `js/insights.js`: scoring algorithms and safety alerts
  - `js/app.js`: UI state, rendering, events, icon mapping, Unsplash banner
- Static icons under `assets/icons/weather2/static/` with graceful fallbacks

### Data sources
- Forecast: Open‑Meteo (no key), hourly + daily endpoints
- Geocoding: Open‑Meteo search; BigDataCloud reverse geocoding for nearest city
- Banner: Unsplash API (optional key) fetching cycling/mountain landscapes

### UX highlights
- Current Conditions emphasizes big temp, concise meta (wind, UV, updated time)
- Activity Insights shows a colored score chip and a right‑side details pane
- Hourly: horizontally scrollable and icon‑driven; Daily: compact 7‑day grid
- Mobile: hamburger menu collapses header controls

### Accessibility and performance
- Keyboard focusable controls, ARIA states, high contrast in dark mode
- Lightweight, no framework build; minimal blocking scripts

### Deployment
It’s a static site. GitHub Pages works out of the box:
- `.nojekyll` included so assets serve as‑is
- Enable Pages from branch root and you’re live

### Local quick start
Serve the folder so ESM imports work:
```bash
python3 -m http.server 9000
# open http://localhost:9000/
```

### What’s next
- Route‑aware wind (map + direction selection)
- Per‑rider preferences (heat/cold sensitivity)
- Offline cache and installable PWA
- Radar layer and trail status integrations

### Closing thoughts
Weather 4 Bike reframes the forecast around the ride. By converting raw numbers into an activity score, alerts, and clear advice, it shortens the gap between “what’s the weather?” and “should I go now?”
