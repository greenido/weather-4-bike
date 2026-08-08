/** @type {import('tailwindcss').Config} */
export default {
  // Every colour class used at runtime is written as a complete literal string
  // in js/app.js (see the TONE tables), so scanning the JS is enough — no safelist.
  content: ['./index.html', './js/**/*.js'],
  // 'class' rather than 'media' so the header toggle can override the OS setting.
  // Every `dark:` variant compiles to a `.dark` ancestor selector, and app.js puts
  // that class on <html>.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        road: { DEFAULT: '#2563eb' },
        gravel: { DEFAULT: '#ea580c' },
        mtb: { DEFAULT: '#16a34a' }
      }
    }
  },
  plugins: []
};
