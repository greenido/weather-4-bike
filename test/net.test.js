import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fetchWithTimeout, createLatestGate, TimeoutError, isAbort } from '../js/net.js';

/** A fetch that never answers on its own, but honours abort like the real one. */
function hangingFetch() {
  const calls = [];
  const impl = (url, init) => new Promise((_, reject) => {
    calls.push({ url, init });
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    // Like real fetch: an already-aborted signal rejects at once.
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort);
  });
  return { impl, calls };
}

describe('fetchWithTimeout', () => {
  test('passes through a normal response', async () => {
    const res = await fetchWithTimeout('https://x.example', {
      timeoutMs: 1000,
      fetchImpl: async () => ({ ok: true, status: 200 })
    });
    assert.equal(res.status, 200);
  });

  test('gives up after the deadline with a TimeoutError, and aborts the request', async () => {
    const { impl, calls } = hangingFetch();
    await assert.rejects(
      fetchWithTimeout('https://x.example', { timeoutMs: 20, fetchImpl: impl }),
      err => err instanceof TimeoutError && /timed out/.test(err.message)
    );
    assert.equal(calls[0].init.signal.aborted, true, 'the underlying request is cancelled, not leaked');
  });

  test('a caller’s abort is an AbortError, not a timeout', async () => {
    const { impl } = hangingFetch();
    const controller = new AbortController();
    const pending = fetchWithTimeout('https://x.example', { timeoutMs: 5000, signal: controller.signal, fetchImpl: impl });
    controller.abort();
    await assert.rejects(pending, err => isAbort(err) && !(err instanceof TimeoutError));
  });

  test('an already-aborted signal cancels immediately', async () => {
    const { impl } = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchWithTimeout('https://x.example', { timeoutMs: 5000, signal: controller.signal, fetchImpl: impl }),
      isAbort
    );
  });

  test('forwards other init options', async () => {
    let seen;
    await fetchWithTimeout('https://x.example', {
      timeoutMs: 1000,
      mode: 'cors',
      fetchImpl: async (url, init) => { seen = init; return { ok: true }; }
    });
    assert.equal(seen.mode, 'cors');
    assert.ok(seen.signal, 'always carries a signal');
    assert.equal(seen.timeoutMs, undefined, 'our own options are not leaked into fetch');
  });
});

describe('createLatestGate', () => {
  test('a new request supersedes and aborts the previous one', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    assert.equal(first.isCurrent(), true);

    const second = gate.begin();
    assert.equal(first.isCurrent(), false);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.isCurrent(), true);
    assert.equal(second.signal.aborted, false);
  });

  test('mark() answers "has anything started since?"', () => {
    const gate = createLatestGate();
    const untouched = gate.mark();
    assert.equal(untouched(), true);
    gate.begin();
    assert.equal(untouched(), false);
  });
});
