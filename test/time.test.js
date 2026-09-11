import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  safeTimeZone, unixToIso, localDateKey, formatClock, dayPrefix,
  formatWeekday, isNight, describeFreshness
} from '../js/time.js';
import { inZone, VIEWER_ZONES } from './helpers.js';

const TLV = 'Asia/Jerusalem'; // UTC+3 in September

// The moment from the bug report: Thu 19:59 in California, Fri 05:59 in Tel Aviv.
const NOW = new Date('2026-09-11T02:59:00Z');

describe('localDateKey', () => {
  test('reads the date in the location’s zone, whatever the viewer’s zone', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        assert.equal(localDateKey(NOW, TLV), '2026-09-11', `viewer in ${zone}`);
        assert.equal(localDateKey(NOW, 'America/Los_Angeles'), '2026-09-10', `viewer in ${zone}`);
      });
    }
  });

  test('local midnight east of Greenwich is the previous day in UTC — and must not be', () => {
    // Open-Meteo stamps Tel Aviv's Friday at 21:00Z on Thursday.
    assert.equal(localDateKey('2026-09-10T21:00:00.000Z', TLV), '2026-09-11');
  });

  test('accepts ISO strings and Dates alike; rejects junk', () => {
    assert.equal(localDateKey('2026-09-11T02:59:00Z', TLV), localDateKey(NOW, TLV));
    assert.equal(localDateKey('not a date', TLV), null);
  });
});

describe('formatClock', () => {
  test('shows the location’s wall clock, not the viewer’s', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        assert.equal(formatClock(NOW, TLV, 'en-US'), '05:59 AM', `viewer in ${zone}`);
      });
    }
  });

  test('an unknown or bogus zone degrades to the viewer’s clock instead of throwing', () => {
    inZone('UTC', () => {
      assert.equal(formatClock(NOW, 'Not/A_Zone', 'en-US'), '02:59 AM');
      assert.equal(formatClock(NOW, null, 'en-US'), '02:59 AM');
    });
  });

  test('invalid input renders a dash', () => {
    assert.equal(formatClock('nope', TLV), '—');
  });
});

describe('dayPrefix', () => {
  test('7 AM Friday in Tel Aviv is "today" there — the bug labelled it "Tomorrow"', () => {
    const friday7am = new Date('2026-09-11T04:00:00Z');
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        assert.equal(dayPrefix(friday7am, NOW, TLV, 'en-US'), '', `viewer in ${zone}`);
      });
    }
  });

  test('the next local day is "Tomorrow", later days get a weekday', () => {
    inZone('America/Los_Angeles', () => {
      assert.equal(dayPrefix(new Date('2026-09-12T04:00:00Z'), NOW, TLV, 'en-US'), 'Tomorrow ');
      assert.equal(dayPrefix(new Date('2026-09-13T04:00:00Z'), NOW, TLV, 'en-US'), 'Sun ');
    });
  });

  test('handles a month boundary', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    assert.equal(dayPrefix(new Date('2026-10-01T06:00:00Z'), now, TLV, 'en-US'), 'Tomorrow ');
  });
});

describe('formatWeekday', () => {
  test('a calendar date has one weekday everywhere', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => {
        assert.equal(formatWeekday('2026-09-11', 'en-US'), 'Fri', `viewer in ${zone}`);
      });
    }
  });

  test('anything but YYYY-MM-DD renders empty', () => {
    assert.equal(formatWeekday('2026-09-11T00:00'), '');
    assert.equal(formatWeekday(null), '');
  });
});

describe('isNight', () => {
  const ranges = [{
    sunrise: new Date('2026-09-11T03:20:00Z'), // 06:20 in Tel Aviv
    sunset: new Date('2026-09-11T16:00:00Z')   // 19:00 in Tel Aviv
  }];

  test('05:59 in Tel Aviv is before sunrise — it was dark in the bug report', () => {
    for (const zone of VIEWER_ZONES) {
      inZone(zone, () => assert.equal(isNight(NOW, ranges), true, `viewer in ${zone}`));
    }
  });

  test('midday is day, after sunset is night', () => {
    assert.equal(isNight(new Date('2026-09-11T09:00:00Z'), ranges), false);
    assert.equal(isNight(new Date('2026-09-11T17:00:00Z'), ranges), true);
  });

  test('with no sunrise data, never claims night', () => {
    assert.equal(isNight(NOW, []), false);
    assert.equal(isNight(NOW, undefined), false);
  });
});

describe('unixToIso', () => {
  test('converts seconds to an ISO instant', () => {
    assert.equal(unixToIso(1789095600), '2026-09-11T03:00:00.000Z');
  });

  test('non-numbers become null, never "Invalid Date"', () => {
    assert.equal(unixToIso(null), null);
    assert.equal(unixToIso(undefined), null);
    assert.equal(unixToIso('1789095600'), null);
    assert.equal(unixToIso(NaN), null);
  });
});

describe('safeTimeZone', () => {
  test('passes real zones, drops fake ones', () => {
    assert.equal(safeTimeZone(TLV), TLV);
    assert.equal(safeTimeZone('Mars/Olympus_Mons'), undefined);
    assert.equal(safeTimeZone(''), undefined);
  });
});

describe('describeFreshness', () => {
  const t0 = Date.parse('2026-09-11T12:00:00Z');
  const min = 60000;

  test('reports real age, in steps', () => {
    assert.deepEqual(describeFreshness(t0, t0 + 20000), { text: 'Updated just now', stale: false });
    assert.deepEqual(describeFreshness(t0, t0 + 8 * min), { text: 'Updated 8 min ago', stale: false });
    assert.deepEqual(describeFreshness(t0, t0 + 59 * min), { text: 'Updated 59 min ago', stale: false });
    assert.deepEqual(describeFreshness(t0, t0 + 3 * 60 * min), { text: 'Updated 3 h ago', stale: true });
    assert.deepEqual(describeFreshness(t0, t0 + 24 * 60 * min), { text: 'Updated 1 day ago', stale: true });
    assert.deepEqual(describeFreshness(t0, t0 + 50 * 60 * min), { text: 'Updated 2 days ago', stale: true });
  });

  test('an offline copy always says so and is always flagged, however young', () => {
    assert.deepEqual(describeFreshness(t0, t0 + 2 * min, { offline: true }), { text: 'Offline · forecast from 2 min ago', stale: true });
  });

  test('clock skew never produces a negative age', () => {
    assert.equal(describeFreshness(t0, t0 - 5 * min).text, 'Updated just now');
  });

  test('no timestamp, no claim', () => {
    assert.deepEqual(describeFreshness(undefined, t0), { text: '', stale: false });
  });
});
