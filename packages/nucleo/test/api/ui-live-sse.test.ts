// The live transport (#414, L6): `startLive` uses the SSE stream `/api/stream` as the main path and falls
// back to the long polling of `/api/changes` when the stream errors, drops or is not available — without
// losing news, resuming from the cursor the stream reached, and re-reading everything on a `reset`.
// AC-7: SSE drops → long polling, no loss; reset → re-read everything.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: browser module, plain JavaScript
import { startLive } from '../../ui/live.js';

type Evt = { data: string; lastEventId?: string };
type Change = { type: string; key: string };

// A fake EventSource the test drives: it records what was opened and lets the test emit server events.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, ((e: Evt) => void)[]>();
  private onopenFn: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  set onopen(fn: () => void) {
    this.onopenFn = fn;
    fn();
  }
  addEventListener(type: string, fn: (e: Evt) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)!).push(fn);
  }
  close(): void {
    this.closed = true;
  }
  private emit(type: string, obj: unknown, lastEventId?: string): void {
    for (const f of this.listeners.get(type) ?? []) f({ data: JSON.stringify(obj), lastEventId });
  }
  reset(obj: unknown, id?: string): void {
    this.emit('reset', obj, id);
  }
  changes(obj: unknown, id?: string): void {
    this.emit('changes', obj, id);
  }
  fail(): void {
    for (const f of this.listeners.get('error') ?? []) f({ data: '' });
  }
}

const until = async (cond: () => boolean, ms = 1000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
};

// A fake read for the long-poll fall back: serves the queued answers, then parks until `stop` aborts.
function pollReader(queue: unknown[]) {
  const requests: string[] = [];
  const read = (route: string, { signal }: { signal?: AbortSignal } = {}) => {
    requests.push(route);
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  return { read, requests };
}

describe('Live transport: SSE with a fall back to long polling (#414, L6)', () => {
  test('AC-7: SSE drops and the long polling takes over from the last cursor without losing news; a reset re-reads everything', async () => {
    const states: string[] = [];
    const changes: Change[] = [];
    let restarts = 0;
    const { read, requests } = pollReader([
      { cursor: 'c3', changes: [{ type: 'session', key: 's2' }], reset: false },
      { cursor: 'c4', changes: [], reset: true },
    ]);
    const live = startLive({
      read,
      wait: 25,
      sleep: async () => {},
      eventSource: FakeEventSource,
      onState: ({ state }: { state: string }) => states.push(state),
      onRestart: () => restarts++,
      onChange: (m: Change[]) => changes.push(...m),
    });

    const es = FakeEventSource.last!;
    assert.ok(es, 'opened the SSE stream');
    assert.equal(es.url, '/api/stream', 'the first connection carries no cursor');

    // The stream leads: a reset re-reads everything, then a change arrives over SSE.
    es.reset({ cursor: 'c1', reset: true }, 'c1');
    assert.equal(restarts, 1, 'the SSE reset re-reads everything');
    es.changes({ cursor: 'c2', changes: [{ type: 'session', key: 's1' }], reset: false }, 'c2');
    assert.ok(changes.some((c) => c.key === 's1'), 'the SSE change arrived');

    // The stream drops: the long polling takes over, resuming from the last cursor the stream reached.
    es.fail();
    await until(() => requests.length > 0);
    assert.equal(requests[0], '/api/changes?since=c2&wait=25', 'the long poll resumes from the last SSE cursor');
    assert.ok(es.closed, 'the SSE stream was closed on the fall back');

    // No news is lost across the hand-off, and the poll reset re-reads everything again.
    await until(() => changes.some((c) => c.key === 's2') && restarts === 2);
    assert.ok(states.includes('live'), 'the state reached live');

    await live.stop();
  });

  test('AC-7: with no stream available, it goes straight to long polling from no cursor', async () => {
    let restarts = 0;
    const { read, requests } = pollReader([{ cursor: 'c1', changes: [], reset: true }]);
    const Unavailable = class {
      constructor() {
        throw new Error('no /api/stream here');
      }
    };
    const live = startLive({
      read,
      wait: 25,
      sleep: async () => {},
      eventSource: Unavailable as unknown as typeof EventSource,
      onState: () => {},
      onRestart: () => restarts++,
      onChange: () => {},
    });

    await until(() => requests.length > 0);
    assert.equal(requests[0], '/api/changes?since=&wait=25', 'starts the long poll from no cursor');
    await until(() => restarts === 1, 1000);
    await live.stop();
  });
});
