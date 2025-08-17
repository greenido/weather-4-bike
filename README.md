# Weather 4 Bike

Cycling-focused weather app providing actionable insights for road, gravel, and mountain biking.

## Quick Start

Open `index.html` in a browser (served via any static server). Tailwind is loaded via CDN for MVP.

## Project Structure

```
index.html
styles/
  input.css    # Tailwind directives (for future build)
  output.css   # Placeholder (CDN currently used)
js/
  app.js       # App bootstrap + rendering
  weather.js   # Open-Meteo integration
  location.js  # Geolocation + geocoding + recents
  insights.js  # Cycling insights + alerts
assets/
  icons/
  images/
```

## Build Tailwind (optional)

When ready to switch from CDN to compiled CSS, install Tailwind and build `styles/input.css` into `styles/output.css`, then replace the CDN script with a `<link>` to `styles/output.css` in `index.html`.

## Notes

- Open-Meteo APIs are used for forecast and geocoding. No API key required.
- Geolocation is attempted on load and can be re-triggered with the "Use current location" button.
- Recent locations are saved in `localStorage` (up to 15).


