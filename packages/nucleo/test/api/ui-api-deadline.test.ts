/*
 * #525 #557 the deadline of ui/api.js: `httpReader` and `httpWriter` abort a request the core does not answer and end it as
 * a status-0 ReadError / WriteError (the same failure as an unreachable core), while the caller's own abort still
 * cancels it and propagates its AbortError. The screens' side (the card leaving its posting state) is in
 * ui-work-board-run-contract.test.ts. Each test names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

// @ts-expect-error: browser module, plain JavaScript
import * as api from '../../ui/api.js';

const { httpReader, httpWriter, ReadError, WriteError } = api as any;
const BASE = 'http://127.0.0.1:4317';

// Counts the timers the module leaves alive: a settled request must leave none (#525).
const live = new Set<unknown>();
const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
beforeEach(() => {
  live.clear();
  (globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle: unknown = realSet(() => {
      live.delete(handle);
      fn(...rest);
    }, ms);
    live.add(handle);
    return handle;
  };
  (globalThis as any).clearTimeout = (handle: unknown) => {
    live.delete(handle);
    realClear(handle as any);
  };
});
afterEach(() => {
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => realSet(r, ms));

/** A fetch that never answers but, like the real one, rejects with an AbortError once its signal fires (#525). */
function hangingFetch() {
  const seen: AbortSignal[] = [];
  const fetch = (_url: unknown, init: RequestInit = {}) =>
    new Promise<Response>((_, reject) => {
      seen.push(init.signal!);
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    });
  return { fetch, seen };
}

/** A fetch that answers the headers at once and whose body never ends: a stall after the headers (#525). */
function stalledBodyFetch() {
  const seen: AbortSignal[] = [];
  const fetch = async (_url: unknown, init: RequestInit = {}) => {
    seen.push(init.signal!);
    return { ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) } as unknown as Response;
  };
  return { fetch, seen };
}

describe('#525 AC-1 a read or write with no answer within the deadline is aborted', () => {
  test('#525 AC-1 a read: the fetch signal is aborted and the error is a ReadError with status 0 and the unreachable-core message', async () => {
    const { fetch, seen } = hangingFetch();
    const read = httpReader({ base: BASE, fetch, timeoutMs: 30 });
    await assert.rejects(read('/api/work'), (e: any) => {
      assert.ok(e instanceof ReadError);
      assert.equal(e.status, 0);
      assert.equal(e.route, '/api/work');
      assert.equal(e.message, 'O núcleo em 127.0.0.1:4317 não respondeu');
      assert.equal(e.timedOut, true, 'the deadline is told apart from an unreachable core');
      return true;
    });
    assert.equal(seen[0]!.aborted, true);
  });

  test('#525 AC-1 a write: the fetch signal is aborted and the error is a WriteError with status 0 and the unreachable-core message', async () => {
    const { fetch, seen } = hangingFetch();
    const write = httpWriter({ base: BASE, fetch, timeoutMs: 30 });
    await assert.rejects(write('/api/work/plan', { repo: 'a/b', number: 1 }), (e: any) => {
      assert.ok(e instanceof WriteError);
      assert.equal(e.name, 'WriteError');
      assert.equal(e.status, 0);
      assert.equal(e.message, 'O núcleo em 127.0.0.1:4317 não respondeu');
      assert.equal(e.timedOut, true);
      return true;
    });
    assert.equal(seen[0]!.aborted, true);
  });

  test('#525 AC-1 an unreachable core is not a timeout: timedOut is false', async () => {
    await assert.rejects(httpReader({ base: BASE, fetch: async () => Promise.reject(new TypeError('fetch failed')), timeoutMs: 5_000 })('/api/work'), (e: any) => e instanceof ReadError && e.status === 0 && e.timedOut === false);
    await assert.rejects(httpWriter({ base: BASE, fetch: async () => Promise.reject(new TypeError('fetch failed')), timeoutMs: 5_000 })('/api/x', {}), (e: any) => e instanceof WriteError && e.status === 0 && e.timedOut === false);
  });

  test('#525 AC-1 a fetch that ignores its signal still ends at the deadline', async () => {
    const write = httpWriter({ base: BASE, fetch: () => new Promise<Response>(() => {}), timeoutMs: 30 });
    await assert.rejects(write('/api/x', {}), (e: any) => e instanceof WriteError && e.status === 0);
  });

  test('#525 AC-1 a per-call timeoutMs overrides the factory one, both ways', async () => {
    const { fetch } = hangingFetch();
    const write = httpWriter({ base: BASE, fetch, timeoutMs: 5_000 });
    const t0 = Date.now();
    await assert.rejects(write('/api/x', {}, { timeoutMs: 30 }), (e: any) => e instanceof WriteError && e.status === 0);
    assert.ok(Date.now() - t0 < 2_000, 'the call deadline, not the factory one');
    const slow = httpWriter({ base: BASE, timeoutMs: 20, fetch: async () => (await wait(120), json(200, { ok: true })) });
    assert.deepEqual(await slow('/api/x', {}, { timeoutMs: 2_000 }), { ok: true }, 'a longer call deadline lets a slow answer through');
  });

  test('#525 AC-1 the default deadline is 60 s', () => {
    assert.equal((api as any).DEFAULT_TIMEOUT_MS, 60_000);
  });

  test('#525 AC-1 the body read is covered: headers at once, a body that stalls, the same status-0 failure', async () => {
    const r = stalledBodyFetch();
    await assert.rejects(httpReader({ base: BASE, fetch: r.fetch, timeoutMs: 30 })('/api/work'), (e: any) => e instanceof ReadError && e.status === 0 && e.timedOut === true && /não respondeu/.test(e.message));
    const w = stalledBodyFetch();
    await assert.rejects(httpWriter({ base: BASE, fetch: w.fetch, timeoutMs: 30 })('/api/x', {}), (e: any) => e instanceof WriteError && e.status === 0);
    assert.equal(r.seen[0]!.aborted, true);
    assert.equal(w.seen[0]!.aborted, true);
  });
});

describe('#557 AC-2 the caller\'s own abort still cancels the request', () => {
  test('#557 AC-2 aborting the caller signal first cancels the fetch and propagates the AbortError, not a ReadError or WriteError', async () => {
    for (const make of [
      (fetch: any, signal: AbortSignal) => httpReader({ base: BASE, fetch, timeoutMs: 5_000 })('/api/work', { signal }),
      (fetch: any, signal: AbortSignal) => httpWriter({ base: BASE, fetch, timeoutMs: 5_000 })('/api/x', {}, { signal }),
    ]) {
      const ctl = new AbortController();
      const { fetch, seen } = hangingFetch();
      const pending = make(fetch, ctl.signal);
      ctl.abort();
      await assert.rejects(pending, (e: any) => {
        assert.equal(e.name, 'AbortError');
        assert.ok(!(e instanceof ReadError));
        return true;
      });
      assert.equal(seen[0]!.aborted, true, 'the fetch was cancelled');
    }
  });

  test('#557 AC-2 a signal aborted before the call never reaches the network as a live request and rejects with the AbortError', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { fetch, seen } = hangingFetch();
    await assert.rejects(httpWriter({ base: BASE, fetch, timeoutMs: 5_000 })('/api/x', {}, { signal: ctl.signal }), (e: any) => e.name === 'AbortError');
    assert.equal(seen[0]?.aborted ?? true, true);
    assert.equal(live.size, 0, 'no timer started for a request that was already cancelled');
  });

  test('#557 AC-2 the caller aborting during a stalled body read propagates its AbortError, for a read and for a write', async () => {
    for (const make of [
      (fetch: any, signal: AbortSignal) => httpReader({ base: BASE, fetch, timeoutMs: 5_000 })('/api/work', { signal }),
      (fetch: any, signal: AbortSignal) => httpWriter({ base: BASE, fetch, timeoutMs: 5_000 })('/api/x', {}, { signal }),
    ]) {
      const ctl = new AbortController();
      const { fetch } = stalledBodyFetch();
      const pending = make(fetch, ctl.signal);
      await wait(10);
      ctl.abort();
      await assert.rejects(pending, (e: any) => {
        assert.equal(e.name, 'AbortError');
        assert.ok(!(e instanceof ReadError));
        return true;
      });
    }
  });

  test('#557 AC-2 the caller aborting with its own reason during the body read rejects with that reason', async () => {
    const ctl = new AbortController();
    const reason = new Error('left the screen');
    const { fetch } = stalledBodyFetch();
    const pending = httpReader({ base: BASE, fetch, timeoutMs: 5_000 })('/api/work', { signal: ctl.signal });
    await wait(10);
    ctl.abort(reason);
    await assert.rejects(pending, (e: any) => e === reason);
  });

  test('#557 AC-2 the caller aborting with its own reason during the fetch rejects with that reason, for a read and for a write', async () => {
    for (const make of [
      (fetch: any, signal: AbortSignal) => httpReader({ base: BASE, fetch, timeoutMs: 5_000 })('/api/work', { signal }),
      (fetch: any, signal: AbortSignal) => httpWriter({ base: BASE, fetch, timeoutMs: 5_000 })('/api/x', {}, { signal }),
    ]) {
      const ctl = new AbortController();
      const reason = new Error('left the screen');
      const { fetch } = hangingFetch();
      const pending = make(fetch, ctl.signal);
      await wait(10);
      ctl.abort(reason);
      await assert.rejects(pending, (e: any) => e === reason);
    }
  });

  test('#557 AC-2 the deadline is not mistaken for the caller: both signals given, the deadline fires first, it is the status-0 failure', async () => {
    const ctl = new AbortController();
    const { fetch } = hangingFetch();
    await assert.rejects(httpReader({ base: BASE, fetch, timeoutMs: 30 })('/api/work', { signal: ctl.signal }), (e: any) => e instanceof ReadError && e.status === 0);
    assert.equal(ctl.signal.aborted, false, 'the caller\'s signal is left alone');
  });
});

describe('#525 the timer never outlives the request', () => {
  test('#525 a fast answer clears the timer, and the answer is returned', async () => {
    const read = httpReader({ base: BASE, fetch: async () => json(200, { ok: 1 }), timeoutMs: 5_000 });
    assert.deepEqual(await read('/api/work'), { ok: 1 });
    assert.equal(live.size, 0);
    const write = httpWriter({ base: BASE, fetch: async () => json(200, { done: true }), timeoutMs: 5_000 });
    assert.deepEqual(await write('/api/x', {}), { done: true });
    assert.equal(live.size, 0);
  });

  test('#525 a failure (HTTP error, network error, caller abort) clears the timer too', async () => {
    await assert.rejects(httpReader({ base: BASE, fetch: async () => json(502, { error: 'x' }), timeoutMs: 5_000 })('/api/work'), (e: any) => e.status === 502);
    assert.equal(live.size, 0);
    await assert.rejects(httpWriter({ base: BASE, fetch: async () => Promise.reject(new TypeError('fetch failed')), timeoutMs: 5_000 })('/api/x', {}), (e: any) => e instanceof WriteError && e.status === 0);
    assert.equal(live.size, 0);
    const ctl = new AbortController();
    const { fetch } = hangingFetch();
    const pending = httpWriter({ base: BASE, fetch, timeoutMs: 5_000 })('/api/x', {}, { signal: ctl.signal });
    assert.equal(live.size, 1, 'the deadline runs while the request is open');
    ctl.abort();
    await assert.rejects(pending);
    assert.equal(live.size, 0);
  });

  test('#525 the deadline never fires after settle: the caller\'s signal stays untouched and the fetch signal is not aborted late', async () => {
    const seen: AbortSignal[] = [];
    const read = httpReader({ base: BASE, fetch: async (_u: unknown, init: RequestInit = {}) => (seen.push(init.signal!), json(200, {})), timeoutMs: 40 });
    await read('/api/work');
    await wait(120);
    assert.equal(seen[0]!.aborted, false);
  });

  test('#525 the unref-free timer is gone after a timeout too', async () => {
    const { fetch } = hangingFetch();
    await assert.rejects(httpReader({ base: BASE, fetch, timeoutMs: 20 })('/api/work'));
    assert.equal(live.size, 0);
  });
});
