/*
  Weather 4 Bike – Network helpers

  Goal: Make requests that give up, and make stale answers impossible to show.

  Why: Two separate bugs had the same root. Nothing had a timeout, so on one bar
  of signal the app sat on skeletons until the browser gave up. And nothing
  tracked which request was current, so a slow response for a place the rider
  had already left could land last and overwrite the one they chose.

  How: `fetchWithTimeout` aborts after a deadline and reports it as a
  TimeoutError. `createLatestGate` hands out a ticket per request; starting a
  new one aborts the old one and marks it no longer current.

  Pure, DOM-free, and takes `fetch` by injection, so it is testable in Node.
*/

export class TimeoutError extends Error {
  constructor(ms) {
    super(`Request timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

/** An abort we asked for — a superseded request, not a failure to report. */
export function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * Goal: fetch(), but never forever.
 * How: Our own controller fires on the deadline; a caller's `signal` (from a
 *      gate) is forwarded into it, so either one cancels the request. Written
 *      by hand rather than with AbortSignal.any, which older Safari lacks.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, signal?: AbortSignal, fetchImpl?: Function}} options
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 15000, signal, fetchImpl = globalThis.fetch, ...init } = options;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new TimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/**
 * Goal: Only the most recent request may change what is on screen.
 * How: `begin()` aborts whatever is in flight and returns a ticket. A result is
 *      applied only while `ticket.isCurrent()` holds. `mark()` answers "has
 *      anything started since?", for flows that wait on something other than a
 *      fetch first — like the geolocation prompt at startup.
 */
export function createLatestGate() {
  let seq = 0;
  let controller = null;

  return {
    begin() {
      controller?.abort();
      const mine = ++seq;
      controller = new AbortController();
      return { signal: controller.signal, isCurrent: () => mine === seq };
    },
    mark() {
      const at = seq;
      return () => at === seq;
    }
  };
}
