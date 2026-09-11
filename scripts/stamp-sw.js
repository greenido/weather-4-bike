#!/usr/bin/env node
/*
  Stamp the service worker's cache version from the content of the app shell.

  Goal: Make a stale cached shell impossible to ship.

  Why: `VERSION` in sw.js used to be bumped by hand. Forget it and returning
  visitors keep serving yesterday's HTML and JS out of the cache — the worst
  kind of bug, because it does not reproduce for whoever deployed it.

  How: Hash the files the worker precaches. If any of them changed, the hash
  changes, the cache names change, and `activate` drops the old caches. CI runs
  this and fails on a dirty tree, so the stamp can never drift from the code.
*/

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'sw.js');

// Keep in step with SHELL_ASSETS in sw.js. Anything whose content should
// invalidate the cache belongs here.
const HASHED_FILES = [
  'index.html',
  'styles/output.css',
  'js/app.js',
  'js/weather.js',
  'js/insights.js',
  'js/location.js',
  'js/units.js',
  'js/time.js',
  'js/net.js',
  'manifest.json'
];

const hash = createHash('sha256');
for (const rel of HASHED_FILES) {
  hash.update(rel);
  hash.update(readFileSync(join(root, rel)));
}
const version = hash.digest('hex').slice(0, 12);

const source = readFileSync(swPath, 'utf8');
const marker = /const VERSION = '[^']*';/;

if (!marker.test(source)) {
  console.error("stamp-sw: could not find `const VERSION = '...';` in sw.js");
  process.exit(1);
}

const next = source.replace(marker, `const VERSION = '${version}';`);
if (next === source) {
  console.log(`stamp-sw: already current (${version})`);
} else {
  writeFileSync(swPath, next);
  console.log(`stamp-sw: version -> ${version}`);
}
