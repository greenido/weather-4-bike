/*
  Tests for unit conversion and formatting.

  The headline case is `temperatureComfort`: the old UI branched on the selected
  unit but kept comparing the raw Celsius value, so switching to °F on an 18°C
  day told the rider to "layer up for cooler temps".
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTemp, formatSpeed, formatVisibility, formatPercent, formatPrecip,
  degToCardinal, temperatureComfort, windDescriptor,
  convertTemp, convertSpeed, convertDistance, systemFor, SYSTEMS,
  describeHourConditions, hourConditionsSentence
} from '../js/units.js';

describe('temperatureComfort (regression: °F compared against °C values)', () => {
  test('both systems agree on every whole degree from -10 to 40 °C', () => {
    for (let c = -10; c <= 40; c++) {
      assert.equal(
        temperatureComfort(c, 'metric'),
        temperatureComfort(c, 'imperial'),
        `systems disagree at ${c}°C (= ${(c * 9 / 5 + 32).toFixed(1)}°F)`
      );
    }
  });

  test('classifies the obvious cases correctly', () => {
    assert.equal(temperatureComfort(18, 'metric'), 'ideal');
    assert.equal(temperatureComfort(18, 'imperial'), 'ideal'); // 64.4°F — was "cold"
    assert.equal(temperatureComfort(2, 'metric'), 'cold');
    assert.equal(temperatureComfort(2, 'imperial'), 'cold');
    assert.equal(temperatureComfort(33, 'metric'), 'hot');
    assert.equal(temperatureComfort(33, 'imperial'), 'hot');
  });

  test('reports unknown rather than guessing', () => {
    assert.equal(temperatureComfort(null, 'metric'), 'unknown');
    assert.equal(temperatureComfort(undefined, 'imperial'), 'unknown');
  });
});

describe('formatTemp', () => {
  test('converts before rounding', () => {
    // Rounding to whole Celsius first (18.6 -> 19 -> 66°F) loses a degree.
    assert.equal(formatTemp(18.6, 'imperial'), '65°F');
    assert.equal(formatTemp(18.6, 'metric'), '19°C');
  });

  test('renders unknown values as a dash, never as zero', () => {
    assert.equal(formatTemp(null, 'metric'), '—');
    assert.equal(formatTemp(undefined, 'imperial'), '—');
    assert.equal(formatTemp(0, 'metric'), '0°C');
  });

  test('can omit the unit suffix', () => {
    assert.equal(formatTemp(20, 'metric', { unit: false }), '20°');
  });
});

describe('formatSpeed', () => {
  test('follows the selected system', () => {
    assert.equal(formatSpeed(32, 'metric'), '32 km/h');
    assert.equal(formatSpeed(32, 'imperial'), '20 mph');
  });

  test('renders unknown values as a dash', () => {
    assert.equal(formatSpeed(null, 'metric'), '—');
  });
});

describe('formatVisibility', () => {
  test('takes metres in and gives the active distance unit out', () => {
    assert.equal(formatVisibility(20000, 'metric'), '20 km');
    assert.equal(formatVisibility(20000, 'imperial'), '12 mi');
  });

  test('keeps one decimal at short ranges where it matters', () => {
    assert.equal(formatVisibility(1500, 'metric'), '1.5 km');
    assert.equal(formatVisibility(800, 'metric'), '0.8 km');
  });

  test('distinguishes unknown from zero', () => {
    assert.equal(formatVisibility(null, 'metric'), '—');
    assert.equal(formatVisibility(0, 'metric'), '0 km');
  });
});

describe('formatPrecip', () => {
  test('uses millimetres or inches to match the system', () => {
    assert.equal(formatPrecip(12.4, 'metric'), '12 mm');
    assert.equal(formatPrecip(2.5, 'metric'), '2.5 mm');
    assert.equal(formatPrecip(25.4, 'imperial'), '1.0"');
    assert.equal(formatPrecip(2.54, 'imperial'), '0.10"');
  });
});

describe('formatPercent', () => {
  test('rounds and marks unknowns', () => {
    assert.equal(formatPercent(66.6), '67%');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(null), '—');
  });
});

describe('degToCardinal', () => {
  test('maps the cardinal points', () => {
    assert.equal(degToCardinal(0), 'N');
    assert.equal(degToCardinal(90), 'E');
    assert.equal(degToCardinal(180), 'S');
    assert.equal(degToCardinal(270), 'W');
    assert.equal(degToCardinal(360), 'N');
  });

  test('handles wrap-around and negatives', () => {
    assert.equal(degToCardinal(350), 'N');
    assert.equal(degToCardinal(-10), 'N');
    assert.equal(degToCardinal(450), 'E');
  });

  test('marks unknown direction', () => {
    assert.equal(degToCardinal(null), '—');
  });
});

describe('raw conversions', () => {
  test('round-trip within floating point tolerance', () => {
    assert.ok(Math.abs(convertTemp(100, 'imperial') - 212) < 1e-9);
    assert.ok(Math.abs(convertSpeed(100, 'imperial') - 62.1371) < 1e-3);
    assert.ok(Math.abs(convertDistance(100, 'imperial') - 62.1371) < 1e-3);
  });

  test('metric is a pass-through', () => {
    assert.equal(convertTemp(21, 'metric'), 21);
    assert.equal(convertSpeed(21, 'metric'), 21);
    assert.equal(convertDistance(21, 'metric'), 21);
  });

  test('an unknown system key falls back to metric', () => {
    assert.equal(systemFor('nonsense').key, 'metric');
    assert.equal(convertTemp(21, undefined), 21);
  });
});

describe('windDescriptor', () => {
  test('escalates with speed', () => {
    assert.equal(windDescriptor(5), 'light winds');
    assert.equal(windDescriptor(15), 'a moderate breeze');
    assert.equal(windDescriptor(28), 'breezy conditions');
    assert.equal(windDescriptor(38), 'strong winds');
    assert.equal(windDescriptor(55), 'very strong winds');
    assert.equal(windDescriptor(null), 'unknown wind');
  });
});

describe('system definitions', () => {
  test('every system declares all the units the UI needs', () => {
    for (const [key, s] of Object.entries(SYSTEMS)) {
      assert.equal(s.key, key);
      assert.ok(s.temp && s.speed && s.distance);
      assert.equal(s.comfortBand.length, 2);
      assert.ok(s.comfortBand[0] < s.comfortBand[1]);
    }
  });
});

describe('describeHourConditions (ride chart tooltip)', () => {
  const hour = {
    temperature: 22.4,
    apparentTemperature: 20.6,
    windSpeed: 12,
    windGusts: 20,
    windDirection: 315,
    precipitationProbability: 10,
    precipitation: 0.2
  };

  test('metric: every field, in the rider’s units', () => {
    assert.deepEqual(describeHourConditions(hour, 'metric'), {
      temp: '22°C',
      feelsLike: '21°C',
      wind: '12 km/h',
      windFrom: 'NW',
      gusts: '20 km/h',
      rainChance: '10%',
      rainAmount: '0.2 mm'
    });
  });

  test('imperial converts every number, not just the labels', () => {
    const d = describeHourConditions(hour, 'imperial');
    assert.equal(d.temp, '72°F');
    assert.equal(d.feelsLike, '69°F');
    assert.equal(d.wind, '7 mph');
    assert.equal(d.gusts, '12 mph');
    assert.equal(d.rainAmount, '0.01"');
  });

  test('feels-like is left out when it says nothing new', () => {
    assert.equal(describeHourConditions({ ...hour, apparentTemperature: 22.9 }, 'metric').feelsLike, null);
    assert.equal(describeHourConditions({ ...hour, apparentTemperature: null }, 'metric').feelsLike, null);
  });

  test('gusts are left out when they are no stronger than the wind, as displayed', () => {
    assert.equal(describeHourConditions({ ...hour, windGusts: 12.3 }, 'metric').gusts, null);
    assert.equal(describeHourConditions({ ...hour, windGusts: null }, 'metric').gusts, null);
    // 12.4 vs 12.6 km/h: different readings, same displayed number.
    assert.equal(describeHourConditions({ ...hour, windSpeed: 12.4, windGusts: 12.6 }, 'imperial').gusts, null);
  });

  test('a dry hour, or a trace that rounds to zero, shows no amount', () => {
    assert.equal(describeHourConditions({ ...hour, precipitation: 0 }, 'metric').rainAmount, null);
    assert.equal(describeHourConditions({ ...hour, precipitation: 0.02 }, 'metric').rainAmount, null, 'not "0 mm"');
    assert.equal(describeHourConditions({ ...hour, precipitation: 0.1 }, 'imperial').rainAmount, null, 'not \'0.00"\'');
  });

  test('unknown stays unknown: dashes, never zeros', () => {
    const d = describeHourConditions({}, 'metric');
    assert.equal(d.temp, '—');
    assert.equal(d.wind, '—');
    assert.equal(d.rainChance, '—');
    assert.equal(d.windFrom, null);
    assert.equal(d.gusts, null);
    assert.equal(d.rainAmount, null);
  });

  test('the sentence says what the tooltip shows', () => {
    assert.equal(
      hourConditionsSentence(describeHourConditions(hour, 'metric')),
      '22°C, feels like 21°C. Wind 12 km/h from NW, gusts 20 km/h. Rain chance 10%, 0.2 mm.'
    );
    assert.equal(
      hourConditionsSentence(describeHourConditions({ temperature: 15, windSpeed: 5, precipitationProbability: 0 }, 'metric')),
      '15°C. Wind 5 km/h. Rain chance 0%.'
    );
  });
});
