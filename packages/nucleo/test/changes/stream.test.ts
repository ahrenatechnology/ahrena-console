import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// The SSE route `GET /api/stream` (#414, layer L3): the live Feed/Conversa stream on the same change
// cursor as `/api/changes`, with no 1 s floor but keeping the burst batching. The clock is fake where the
// latency is measured: no assertion depends on real time.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, TrabalhoPorBranch, startLocalApi } from '../../src/api/index.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { ChangeCursor, withChanges, type Clock, type NewChange, type WaitResult } from '../../src/changes/index.ts';

/** Manual clock: `advance(ms)` fires, in order, the timers that are due. */
class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  private nextId = 0;
  readonly timers = new Map<number, { dueAt: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { dueAt: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const [id, t] = [...this.timers].filter(([, t]) => t.dueAt <= end).sort((a, b) => a[1].dueAt - b[1].dueAt)[0] ?? [];
      if (id === undefined || !t) break;
      this.timers.delete(id);
      this.t = t.dueAt;
      t.fn();
    }
    this.t = end;
  }
}

/** A promise with visible state, to know whether a wait has answered without awaiting it. */
function observe(p: Promise<WaitResult>) {
  const o: { value: WaitResult | null } = { value: null };
  void p.then((v) => (o.value = v));
  return o;
}
const tick = () => new Promise((r) => setImmediate(r));
const activity = (key: string): NewChange => ({ type: 'activity', key, sessionId: key, accountId: null });

interface SseEvent {
  id: string | null;
  event: string | null;
  data: Record<string, unknown> | null;
}

/** Reads one SSE event (skipping `:` comments like `: open`) from a streaming response. */
async function readSseEvent(res: Response): Promise<SseEvent> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream ended before an event');
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.startsWith(':') || block === '') continue; // comment (`: open`, keep-alive)
        const out: SseEvent = { id: null, event: null, data: null };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) out.id = line.slice(4);
          else if (line.startsWith('event: ')) out.event = line.slice(7);
          else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        return out;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe('GET /api/stream (SSE, #414 L3)', () => {
  test('#414/AC-2 (server) the SSE waiter answers without the 1 s floor, keeping the burst batch', async () => {
    const clock = new FakeClock();
    // 1 s floor and a 50 ms batch, as in production; the SSE passes minIntervalMs: 0 per wait.
    const cursor = new ChangeCursor({ clock, generation: 'g1', batchMs: 50, minIntervalMs: 1000 });
    const start = await cursor.wait(null); // '' → reset with the current cursor ('g1.0')

    // The SSE wait (minIntervalMs: 0): a change comes out at the batch (50 ms), not at the 1 s floor.
    const sse = observe(cursor.wait(start.cursor, { minIntervalMs: 0, timeoutMs: 25_000 }));
    await tick();
    cursor.record(activity('s1'));
    clock.advance(50);
    await tick();
    assert.ok(sse.value, 'answered at 50 ms, well before the 1 s floor');
    assert.deepEqual(sse.value!.changes.map((c) => c.type), ['activity']);

    // Contrast: the default wait (1 s floor) would not have answered at 50 ms.
    const baseline = observe(cursor.wait(sse.value!.cursor, { timeoutMs: 25_000 }));
    await tick();
    cursor.record(activity('s2'));
    clock.advance(50);
    await tick();
    assert.equal(baseline.value, null, 'with the 1 s floor, 50 ms is not enough');
    clock.advance(1_000);
    await tick();
    assert.ok(baseline.value, 'after 1 s it answers — the burst batch still applies');

    cursor.close();
  });

  test('#414/AC-7 (server) the SSE event id is the cursor; a new generation yields reset, and the client resumes via long poll', async () => {
    const cursor = new ChangeCursor({ generation: 'gen1', batchMs: 0, minIntervalMs: 0 });
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = withChanges(sqlite, cursor);
    const work = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const builder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: work });
    const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: builder, hooks: { storage }, port: 0, log: () => {}, changes: cursor });

    try {
      // An invalid request is still a 400 (the stream does not open).
      assert.equal((await fetch(`${api.url}/api/stream?type=nope`)).status, 400);

      // Reconnect with a Last-Event-ID from another generation: the first event is a reset, id = current cursor.
      const ac = new AbortController();
      const res = await fetch(`${api.url}/api/stream`, { headers: { 'last-event-id': 'other.9' }, signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, /text\/event-stream/);
      const reset = await readSseEvent(res);
      assert.equal(reset.event, 'reset');
      assert.equal(reset.data!.reset, true);
      assert.equal(reset.id, 'gen1.0', 'the event id is the current cursor');
      assert.equal(reset.data!.cursor, 'gen1.0');
      // The client resumes via the long poll with that id, now valid (same generation): no reset.
      const poll = (await (await fetch(`${api.url}/api/changes?since=${reset.id}&wait=0`)).json()) as WaitResult;
      assert.equal(poll.reset, false, 'the SSE cursor doubles as the long-poll cursor, with no gap');
      ac.abort();

      // Resuming at the current cursor: the next change arrives as a `changes` event, id = the new cursor.
      const ac2 = new AbortController();
      const res2 = await fetch(`${api.url}/api/stream?since=gen1.0`, { signal: ac2.signal });
      while (cursor.openWaits === 0) await tick();
      cursor.record(activity('s1'));
      const changed = await readSseEvent(res2);
      assert.equal(changed.event, 'changes');
      assert.equal(changed.id, 'gen1.1', 'the id advances with the cursor');
      assert.equal(changed.data!.cursor, 'gen1.1');
      assert.deepEqual((changed.data!.changes as { type: string; key: string }[]).map((c) => [c.type, c.key]), [['activity', 's1']]);
      ac2.abort();

      while (cursor.openWaits > 0) await tick();
    } finally {
      await api.close();
      await sqlite.close();
    }
  });
});
