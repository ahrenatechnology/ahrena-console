import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { validateAgent, validateEvent, validateSession, validateTokenUsage } from '../src/model.ts';
import { estimateCost, effectiveTokens } from '../src/pricing.ts';
import type { StoragePort } from '../src/storage-port.ts';
import {
  SeededRandom,
  CONTEXT_LIMIT,
  MINUTES_UNTIL_ABANDONED,
  CHAOS_KINDS,
  generateScenario,
  simulate,
  type SimulationOptions,
} from '../src/simulator/index.ts';
import { T0 } from './fixtures.ts';

const NOW = Date.parse(T0);
const clock = (ms: number) => new Date(NOW + ms).toISOString();

async function allEvents(storage: StoragePort, sessionId: string) {
  const events = [];
  let cursor: string | null = null;
  do {
    const page = await storage.listEvents(sessionId, { limit: 500, cursor });
    events.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

/** Everything the simulation left in the database, in a stable order. */
async function dump(storage: StoragePort) {
  const sessions = (await storage.listSessions({ limit: 500 })).items.sort((a, b) => a.id.localeCompare(b.id));
  const rest = await Promise.all(
    sessions.map(async (s) => ({
      agents: await storage.listAgents(s.id),
      events: await allEvents(storage, s.id),
      usages: await storage.listTokenUsage(s.id),
    })),
  );
  return { sessions, rest, prices: await storage.listModelPricing() };
}

async function run(options: Partial<SimulationOptions> = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const summary = await simulate(storage, { seed: 7, now: () => NOW, ...options });
  return { storage, summary, data: await dump(storage) };
}

describe('seeded random', () => {
  test('the same seed gives the same sequence; another seed, another sequence', () => {
    const seq = (s: string | number) => {
      const r = new SeededRandom(s);
      return Array.from({ length: 20 }, () => r.next());
    };
    assert.deepEqual(seq('abc'), seq('abc'));
    assert.notDeepEqual(seq('abc'), seq('abd'));
    for (const x of seq(1)) assert.ok(x >= 0 && x < 1);
  });

  test('int respects the inclusive bounds', () => {
    const r = new SeededRandom(3);
    const seen = new Set(Array.from({ length: 500 }, () => r.int(2, 5)));
    assert.deepEqual([...seen].sort(), [2, 3, 4, 5]);
  });
});

describe('scenario', () => {
  test('determinism: the same seed and options generate exactly the same script', () => {
    const a = generateScenario({ seed: 'demo', chaos: true, clock });
    const b = generateScenario({ seed: 'demo', chaos: true, clock });
    assert.deepEqual(a, b);
    assert.ok(a.operations.length > 100);
  });

  test('another seed generates another script, with another id prefix', () => {
    const a = generateScenario({ seed: 1, clock });
    const b = generateScenario({ seed: 2, clock });
    assert.notEqual(a.prefix, b.prefix);
    assert.notDeepEqual(
      a.operations.map((o) => o.offsetMs),
      b.operations.map((o) => o.offsetMs),
    );
  });

  test('operations in time order and all inside the window', () => {
    const { operations } = generateScenario({ seed: 5, durationMin: 120, chaos: true, clock });
    for (let i = 1; i < operations.length; i++) assert.ok(operations[i].offsetMs >= operations[i - 1].offsetMs);
    assert.ok(operations.every((o) => o.offsetMs <= 120 * 60_000));
  });

  test('every generated record passes the model validators', () => {
    for (const op of generateScenario({ seed: 9, sessions: 20, chaos: true, clock }).operations) {
      if (op.kind === 'session') validateSession(op.record);
      else if (op.kind === 'agent') validateAgent(op.record);
      else if (op.kind === 'event') validateEvent(op.record);
      else validateTokenUsage(op.record);
    }
  });

  test('without chaos, only normal scripts; with chaos, at least one session of each failure', () => {
    assert.ok(generateScenario({ seed: 1, clock }).scripts.every((r) => r === 'normal'));
    const { scripts } = generateScenario({ seed: 1, chaos: true, clock });
    for (const kind of CHAOS_KINDS) assert.ok(scripts.includes(kind), `missing ${kind}`);
  });

  test('synthetic data: paths under /simulacao and everything marked as simulated', () => {
    for (const op of generateScenario({ seed: 4, chaos: true, clock }).operations) {
      if (op.kind === 'session') {
        assert.match(op.record.cwd ?? '', /^\/simulacao\//);
        assert.equal(op.record.metadata.simulated, true);
      }
      if (op.kind === 'event') {
        const path = (op.record.data as { file_path?: string } | null)?.file_path;
        if (path) assert.match(path, /^\/simulacao\//);
      }
    }
  });

  test('invalid options are refused', () => {
    assert.throws(() => generateScenario({ seed: 1, sessions: 0, clock }), RangeError);
    assert.throws(() => generateScenario({ seed: 1, durationMin: 0, clock }), RangeError);
  });
});

describe('batch simulation through the port', () => {
  test('determinism: the same seed writes exactly the same data', async () => {
    const a = await run({ chaos: true, prices: true });
    const b = await run({ chaos: true, prices: true });
    assert.deepEqual(a.data, b.data);
    assert.deepEqual(a.summary, b.summary);
    const c = await run({ seed: 8, chaos: true, prices: true });
    assert.notDeepEqual(a.data.sessions, c.data.sessions);
    await Promise.all([a.storage.close(), b.storage.close(), c.storage.close()]);
  });

  test('writes sessions, agents, subagents, events and usage; the window ends now', async () => {
    const { storage, summary, data } = await run({ sessions: 10 });
    assert.equal(data.sessions.length, 10);
    assert.equal(summary.written.sessions, 10);
    const agents = data.rest.flatMap((r) => r.agents);
    assert.ok(agents.some((a) => a.type === 'main'));
    const subs = agents.filter((a) => a.type === 'subagent');
    assert.ok(subs.length > 0);
    assert.ok(subs.every((s) => s.parentAgentId?.endsWith('-a0')));
    assert.ok(data.rest.every((r) => r.events.some((e) => e.type === 'SessionStart')));
    assert.ok(data.rest.flatMap((r) => r.events).some((e) => e.type === 'PreToolUse' && e.toolName));
    assert.ok(data.rest.every((r) => r.usages.length > 0));
    for (const s of data.sessions) {
      assert.ok(s.updatedAt <= T0, 'nothing in the future');
      assert.ok(s.startedAt >= new Date(NOW - 360 * 60_000).toISOString());
    }
    await storage.close();
  });

  test('applying the same seed again on the same database duplicates nothing', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const first = await simulate(storage, { seed: 3, now: () => NOW });
    const before = await dump(storage);
    const second = await simulate(storage, { seed: 3, now: () => NOW });
    assert.deepEqual(await dump(storage), before);
    assert.ok(first.written.events > 0);
    assert.equal(second.written.events, 0);
    await storage.close();
  });

  test('illustrative prices only when asked, without overwriting existing ones', async () => {
    const without = await run();
    assert.equal(without.data.prices.length, 0);
    const withPrices = await run({ prices: true });
    assert.equal(withPrices.data.prices.length, 3);
    const usages = withPrices.data.rest.flatMap((r) => r.usages);
    assert.ok(usages.every((u) => estimateCost(u, withPrices.data.prices).priced));
    const another = await simulate(withPrices.storage, { seed: 99, prices: true, now: () => NOW });
    assert.equal(another.written.prices, 0);
    await Promise.all([without.storage.close(), withPrices.storage.close()]);
  });
});

describe('chaos mode', () => {
  // `metadata.script` is the script of each session.
  const byScript = async (seed: number) => {
    const { storage, data } = await run({ seed, chaos: true, sessions: 10 });
    const sessions = data.sessions.map((s, i) => ({ s, ...data.rest[i] }));
    return { storage, of: (r: string) => sessions.filter((x) => x.s.metadata.script === r) };
  };

  test('stuck: keeps waiting for input, without ending', async () => {
    const { storage, of } = await byScript(11);
    const stuck = of('stuck');
    assert.ok(stuck.length > 0);
    for (const { s, events } of stuck) {
      assert.equal(s.status, 'active');
      assert.ok(s.awaitingReason === 'notification' || s.awaitingReason === 'interrupted');
      assert.equal(s.endedAt, null);
      assert.ok(['Notification', 'Interrupted'].includes(events.at(-1)!.type));
    }
    await storage.close();
  });

  test('error: the tool fails and the session stays in error', async () => {
    const { storage, of } = await byScript(12);
    for (const { s, agents, events } of of('error')) {
      assert.equal(s.status, 'error');
      assert.equal(agents[0].status, 'error');
      assert.equal(events.at(-1)!.type, 'PostToolUseFailure');
    }
    assert.ok(of('error').length > 0);
    await storage.close();
  });

  test(`abandonment: no activity for ${MINUTES_UNTIL_ABANDONED} min and written as abandoned`, async () => {
    const { storage, of } = await byScript(13);
    assert.ok(of('abandonment').length > 0);
    for (const { s, events } of of('abandonment')) {
      assert.equal(s.status, 'abandoned');
      const last = Date.parse(events.at(-1)!.createdAt);
      assert.ok(Date.parse(s.endedAt!) - last >= MINUTES_UNTIL_ABANDONED * 60_000);
    }
    await storage.close();
  });

  test('overflow: token spikes overflow the context at least twice, with the compaction floor', async () => {
    const { storage, of } = await byScript(14);
    assert.ok(of('overflow').length > 0);
    for (const { s, events, usages } of of('overflow')) {
      const context = s.metadata.context as { overflows: number; limit: number };
      assert.ok(context.overflows >= 2);
      assert.equal(context.limit, CONTEXT_LIMIT);
      assert.ok(events.filter((e) => e.type === 'PreCompact').length >= 2);
      const main = usages.find((u) => u.model === s.model)!;
      assert.ok(main.baseline.cacheWrite5m > 0);
      assert.ok(effectiveTokens(main).cacheRead >= CONTEXT_LIMIT);
    }
    await storage.close();
  });

  test('swarm: at least 8 subagents working at the same time', async () => {
    const { storage, of } = await byScript(15);
    assert.ok(of('swarm').length > 0);
    for (const { agents } of of('swarm')) {
      const subs = agents.filter((a) => a.type === 'subagent');
      // Concurrency peak: at the start of each subagent, how many are running.
      const concurrent = Math.max(...subs.map((x) => subs.filter((a) => a.startedAt <= x.startedAt && a.endedAt! > x.startedAt).length));
      assert.ok(concurrent >= 8, `only ${concurrent} in parallel`);
    }
    await storage.close();
  });
});

describe('real-time simulation', () => {
  test('waits for the pace of the speed and stamps each write with the clock time', async () => {
    let virtualClock = NOW;
    const waits: number[] = [];
    const storage = openSqliteStorage({ path: ':memory:' });
    const summary = await simulate(storage, {
      seed: 21,
      sessions: 3,
      durationMin: 60,
      mode: 'real-time',
      speed: 60,
      now: () => virtualClock,
      wait: async (ms) => {
        waits.push(ms);
        virtualClock += ms;
      },
    });
    assert.equal(summary.interrupted, false);
    assert.ok(waits.length > 0);
    // 60 simulated min at 60x fit in 1 clock min.
    assert.ok(virtualClock - NOW <= 60_000);
    const { rest } = await dump(storage);
    for (const e of rest.flatMap((r) => r.events)) assert.ok(Date.parse(e.createdAt) <= virtualClock);
    await storage.close();
  });

  test('determinism in real time too', async () => {
    const execute = async () => {
      let t = NOW;
      const storage = openSqliteStorage({ path: ':memory:' });
      await simulate(storage, { seed: 'rt', chaos: true, mode: 'real-time', now: () => t, wait: async (ms) => void (t += ms) });
      const data = await dump(storage);
      await storage.close();
      return data;
    };
    assert.deepEqual(await execute(), await execute());
  });

  test('the signal interrupts and keeps what was already written', async () => {
    let t = NOW;
    const stop = new AbortController();
    let writes = 0;
    const storage = openSqliteStorage({ path: ':memory:' });
    const summary = await simulate(storage, {
      seed: 22,
      mode: 'real-time',
      now: () => t,
      wait: async (ms) => void (t += ms),
      signal: stop.signal,
      onWrite: () => {
        if (++writes === 50) stop.abort();
      },
    });
    assert.equal(summary.interrupted, true);
    assert.equal(writes, 50);
    assert.ok((await dump(storage)).sessions.length > 0);
    await storage.close();
  });

  test('invalid speed is refused', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await assert.rejects(simulate(storage, { seed: 1, mode: 'real-time', speed: 0 }), RangeError);
    await storage.close();
  });

  test('generates two synthetic accounts and splits the sessions between them', async () => {
    const { storage, summary, data } = await run({ sessions: 6 });
    const accounts = await storage.listAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(summary.written.accounts, 2);
    for (const c of accounts) {
      assert.match(c.accountUuid, /^00000000-0000-4000-8000-/);
      assert.match(c.organizationUuid, /^00000000-0000-4000-8000-/);
      assert.equal(c.metadata.simulated, true);
      assert.ok(c.configDirs.every((d) => d.startsWith('/simulacao/')));
      const ofAccount = data.sessions.filter((s) => s.accountId === c.id);
      assert.equal(ofAccount.length, 3);
      assert.equal(c.lastSeenAt, ofAccount.map((s) => s.updatedAt).sort().at(-1));
      assert.ok(c.firstSeenAt <= c.lastSeenAt);
      assert.equal((await storage.listSessions({ accountIds: [c.id] })).items.length, 3);
    }
    assert.ok(data.sessions.every((s) => s.accountId !== null && s.accountSource !== null));
    assert.deepEqual(new Set(data.sessions.map((s) => s.accountSource)), new Set(['env', 'config']));
    assert.deepEqual((await storage.listSessions({ accountIds: [null] })).items, []);
    await storage.close();
  });
});
