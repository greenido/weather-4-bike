/*
  Shared test helpers.
*/

const SYSTEM_ZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Run `fn` with the process in `timeZone`, as if the viewer's device were there.
 *
 * The timezone bug only exists when the viewer's zone differs from the forecast
 * location's, and CI runs in UTC — so a test that just runs "normally" can pass
 * while the app is wrong for everyone else. Node re-reads TZ on assignment.
 */
export function inZone(timeZone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    process.env.TZ = previous ?? SYSTEM_ZONE;
  }
}

/** Viewer zones spread around the world, including both sides of Tel Aviv. */
export const VIEWER_ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Jerusalem'];

/** A promise you can settle from outside — for driving responses out of order. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
