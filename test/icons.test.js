import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { iconCandidates, ICON_BY_CODE, ICON_DIR } from '../js/icons.js';

const onDisk = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const name = (path) => path.slice(ICON_DIR.length + 1, -'.svg'.length);

describe('iconCandidates', () => {
  test('every file any weather code can ask for is in the icon pack', () => {
    // A missing file is a broken image in the hourly strip, in some weather,
    // at some time of day — easy to ship and hard to notice.
    const codes = [...Object.keys(ICON_BY_CODE).map(Number), 12345];
    for (const code of codes) {
      for (const night of [false, true]) {
        for (const path of iconCandidates(code, night)) {
          assert.ok(onDisk(path), `${path} (code ${code}, ${night ? 'night' : 'day'})`);
        }
      }
    }
  });

  test('clear and partly cloudy skies have night versions', () => {
    assert.equal(name(iconCandidates(0, true)[0]), 'night');
    assert.equal(name(iconCandidates(2, true)[0]), 'cloudy-night-1');
    assert.equal(name(iconCandidates(0, false)[0]), 'sun');
  });

  test('rain and snow look the same day and night', () => {
    assert.deepEqual(iconCandidates(63, true), iconCandidates(63, false));
    assert.deepEqual(iconCandidates(73, true), iconCandidates(73, false));
  });

  test('partly cloudy falls back through its own list, not the sun’s', () => {
    assert.deepEqual(iconCandidates(2).map(name), ['sun-cloud', 'cloudy-day-2', 'sun', 'cloud']);
  });

  test('freezing rain uses the rain-snow mix, since the pack has no sleet', () => {
    assert.equal(name(iconCandidates(66)[0]), 'snowy-4');
  });

  test('an unknown code gets a plain cloud rather than nothing', () => {
    assert.equal(name(iconCandidates(12345)[0]), 'cloud');
    assert.equal(name(iconCandidates(undefined)[0]), 'cloud');
  });
});
