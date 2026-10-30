// The GitHub background sync (decision 0015, #356): due steps one at a time, the cadence after each run,
// pending retried on the next tick, the rate-limit pause and the status.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { githubSyncSteps } from '../../src/api/github-screens.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { GithubBackgroundSync, type SyncStep } from '../../src/github/background-sync.ts';

const T0 = Date.parse('2026-10-29T12:00:00Z');

function step(name: string, everyMs: number, outcomes: ('done' | 'skipped' | 'pending' | Error)[], log: string[]): SyncStep {
  return {
    name,
    everyMs,
    async run() {
      log.push(name);
      const o = outcomes.shift() ?? 'done';
      if (o instanceof Error) throw o;
      return o;
    },
  };
}

describe('#356 GithubBackgroundSync', () => {
  test('every step runs at start, in order, and again only after its interval', async () => {
    const clock = { now: T0 };
    const ran: string[] = [];
    const sync = new GithubBackgroundSync({ steps: [step('project', 120_000, [], ran), step('decisions', 900_000, [], ran)], now: () => clock.now });
    await sync.tick();
    assert.deepEqual(ran, ['project', 'decisions']);
    clock.now += 120_000;
    await sync.tick();
    assert.deepEqual(ran, ['project', 'decisions', 'project']);
    clock.now += 780_000;
    await sync.tick();
    assert.deepEqual(ran, ['project', 'decisions', 'project', 'project', 'decisions']);
  });

  test('pending runs again on the next tick; an error keeps the cadence and shows in the status', async () => {
    const clock = { now: T0 };
    const ran: string[] = [];
    const sync = new GithubBackgroundSync({ steps: [step('decisions', 900_000, ['pending', new Error('GitHub fora'), 'done'], ran)], now: () => clock.now, tickMs: 15_000 });
    await sync.tick();
    assert.equal(sync.status().steps[0].lastOutcome, 'pending');
    clock.now += 15_000;
    await sync.tick();
    const failed = sync.status().steps[0];
    assert.equal(failed.lastOutcome, 'error');
    assert.equal(failed.error, 'GitHub fora');
    assert.equal(failed.nextAt, new Date(clock.now + 900_000).toISOString());
    clock.now += 900_000;
    await sync.tick();
    assert.equal(sync.status().steps[0].lastOutcome, 'done');
    assert.equal(sync.status().steps[0].error, null);
    assert.equal(ran.length, 3);
  });

  test('while GitHub has paused the core, no step runs', async () => {
    const pause = { left: 60_000 };
    const ran: string[] = [];
    const sync = new GithubBackgroundSync({ steps: [step('project', 120_000, [], ran)], now: () => T0, pauseLeftMs: () => pause.left });
    await sync.tick();
    assert.deepEqual(ran, []);
    assert.equal(sync.status().pausedUntil, new Date(T0 + 60_000).toISOString());
    pause.left = 0;
    await sync.tick();
    assert.deepEqual(ran, ['project']);
  });

  test('a tick during another waits for it instead of running the steps twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const sync = new GithubBackgroundSync({ steps: [{ name: 'decisions', everyMs: 900_000, run: async () => (runs++, await gate, 'done') }], now: () => T0 });
    const a = sync.tick();
    const b = sync.tick();
    assert.equal(sync.status().steps[0].running, true);
    release();
    await Promise.all([a, b]);
    assert.equal(runs, 1);
  });

  test('requestNow makes a step due on the next tick', async () => {
    const ran: string[] = [];
    const sync = new GithubBackgroundSync({ steps: [step('project', 120_000, [], ran)], now: () => T0 });
    await sync.tick();
    await sync.tick();
    sync.requestNow('project');
    await sync.tick();
    assert.deepEqual(ran, ['project', 'project']);
  });
});

describe('#356 the sync steps and the status route', () => {
  test('without a GitHub connection both steps are skipped and nothing is read', async () => {
    let read = 0;
    const kanban = { board: async () => (read++, { stale: false }) };
    const screens = { project: { kanban: () => kanban }, current: () => ({ decisions: { sync: async () => (read++, 'done' as const) } }) } as unknown as Parameters<typeof githubSyncSteps>[0];
    const steps = githubSyncSteps(screens, async () => false);
    assert.deepEqual(await Promise.all(steps.map((s) => s.run())), ['skipped', 'skipped']);
    assert.equal(read, 0);
    assert.deepEqual(await Promise.all(githubSyncSteps(screens, async () => true).map((s) => s.run())), ['done', 'done']);
    assert.equal(read, 2);
  });

  test('GET /api/github/sync answers the status', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, agora: () => T0 });
    const sync = new GithubBackgroundSync({ steps: [step('project', 120_000, [], [])], now: () => T0 });
    await sync.tick();
    const api = await startLocalApi({ panelBuilder, hooks: { storage }, port: 0, log: () => {}, githubSync: sync });
    try {
      const r = await fetch(`${api.url}/api/github/sync`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { steps: { name: string; lastOutcome: string }[] };
      assert.deepEqual(body.steps.map((x) => [x.name, x.lastOutcome]), [['project', 'done']]);
    } finally {
      await api.close();
      await storage.close();
    }
  });
});
