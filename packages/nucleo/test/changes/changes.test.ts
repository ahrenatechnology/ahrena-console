// Change cursor and long polling (item 2.4). The clock is fake: no wait depends on real time.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, TrabalhoPorBranch, iniciarApiLocal, normalizeLegacyUrl } from '../../src/api/index.ts';
import { LIST_CHANGE_KEY } from '../../src/api/repos.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { SessionStateMachine } from '../../src/states/machine.ts';
import {
  SessionAccounts,
  ChangeCursor,
  MAX_WAIT_MS,
  DEFAULT_WAIT_MS,
  TooManyWaitersError,
  WAIT_FOR_CHANGES,
  awaitChanges,
  onMachineChange,
  withChanges,
  decisionsWithChanges,
  parseChangesRequest,
  NO_ACCOUNT,
  waitForChanges,
  type NewChange,
  type Clock,
  type WaitResult,
} from '../../src/changes/index.ts';
import { T0, account, agent, session } from '../fixtures.ts';
import { draft } from '../decisions/helpers.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { ErroDaFerramenta, ErroDeArgumento } from '../../src/mcp/protocolo.ts';

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

const sessionChange = (id: string, over: Partial<NewChange> = {}): NewChange => ({ type: 'session', key: id, sessionId: id, accountId: null, ...over });

function setup(options: { capacity?: number; batchMs?: number; minIntervalMs?: number; maxWaiters?: number } = {}) {
  const clock = new FakeClock();
  const cursor = new ChangeCursor({ clock, generation: 'g1', batchMs: 0, minIntervalMs: 0, ...options });
  return { clock, cursor };
}

/** A promise with visible state, to know whether the wait has answered without waiting for it. */
function observe(p: Promise<WaitResult>) {
  const o: { value: WaitResult | null; p: Promise<WaitResult> } = { value: null, p };
  p.then((v) => (o.value = v));
  return o;
}
const tick = () => new Promise((r) => setImmediate(r));

describe('change cursor', () => {
  test('no cursor, from another generation or from the future: comes back at once asking for a reset', async () => {
    const { cursor } = setup();
    cursor.record(sessionChange('s1'));
    for (const c of [null, '', 'lixo', 'g0.1', 'g1.99']) {
      const r = await cursor.wait(c);
      assert.deepEqual(r, { cursor: 'g1.1', changes: [], reset: true, timedOut: false }, String(c));
    }
  });

  test('immediate answer when there is news already, once per (type, key)', async () => {
    const { cursor, clock } = setup();
    const c0 = cursor.current;
    cursor.record(sessionChange('s1'));
    cursor.record(sessionChange('s2'));
    cursor.record(sessionChange('s1'));
    cursor.record({ type: 'plan', key: 's1', sessionId: 's1', accountId: null });
    const r = await awaitChanges(cursor, c0);
    assert.equal(r.cursor, 'g1.4');
    assert.deepEqual(r.changes.map((m) => `${m.type}:${m.key}:${m.seq}`), ['session:s2:2', 'session:s1:3', 'plan:s1:4']);
    assert.equal(clock.timers.size, 0, 'an immediate answer arms no timer');
    assert.equal(cursor.openWaits, 0);
  });

  test('holds until a change arrives', async () => {
    const { cursor } = setup();
    const waiter = observe(cursor.wait(cursor.current, { timeoutMs: 10_000 }));
    await tick();
    assert.equal(waiter.value, null);
    assert.equal(cursor.openWaits, 1);
    cursor.record(sessionChange('s1'));
    const r = await waiter.p;
    assert.deepEqual(r.changes.map((m) => m.key), ['s1']);
    assert.equal(r.timedOut, false);
    assert.equal(cursor.openWaits, 0);
  });

  test('timeout: comes back with no changes, with the cursor that skips the ones the filter left out', async () => {
    const { cursor, clock } = setup();
    const waiter = observe(cursor.wait(cursor.current, { timeoutMs: 5_000, filters: { sessionIds: ['s9'] } }));
    cursor.record(sessionChange('s1'));
    clock.advance(4_999);
    await tick();
    assert.equal(waiter.value, null);
    clock.advance(1);
    const r = await waiter.p;
    assert.deepEqual(r, { cursor: 'g1.1', changes: [], reset: false, timedOut: true });
    assert.equal(clock.timers.size, 0);
  });

  test('the timeout has a default and a cap; 0 answers at once', async () => {
    const { cursor, clock } = setup();
    void cursor.wait(cursor.current);
    assert.equal([...clock.timers.values()][0].dueAt, DEFAULT_WAIT_MS);
    cursor.close();
    void cursor.wait(cursor.current, { timeoutMs: 10 * 60_000 });
    assert.equal([...clock.timers.values()][0].dueAt, MAX_WAIT_MS);
    assert.ok(MAX_WAIT_MS < 120_000);
    cursor.close();
    const r = await cursor.wait(cursor.current, { timeoutMs: 0 });
    assert.equal(r.timedOut, false);
    assert.equal(cursor.openWaits, 0);
  });

  test('several simultaneous waits: each one wakes up only with what passes its filter', async () => {
    const { cursor, clock } = setup();
    const c = cursor.current;
    const all = observe(cursor.wait(c));
    const s2 = observe(cursor.wait(c, { filters: { sessionIds: ['s2'] } }));
    const accountB = observe(cursor.wait(c, { filters: { accountIds: ['b'] } }));
    const noAccount = observe(cursor.wait(c, { filters: { accountIds: [null] } }));
    const plans = observe(cursor.wait(c, { filters: { types: ['plan'] } }));
    const many = Array.from({ length: 100 }, () => observe(cursor.wait(c, { filters: { types: ['decision'] } })));
    assert.equal(cursor.openWaits, 105);

    cursor.record(sessionChange('s1', { accountId: 'a' }));
    await tick();
    assert.ok(all.value);
    assert.equal(s2.value, null);
    assert.equal(accountB.value, null);
    assert.equal(noAccount.value, null);
    assert.equal(plans.value, null);

    cursor.record({ type: 'plan', key: 's2', sessionId: 's2', accountId: 'b' });
    await tick();
    assert.deepEqual((s2.value as WaitResult | null)?.changes.map((m) => m.type), ['plan']);
    assert.deepEqual((accountB.value as WaitResult | null)?.changes.map((m) => m.key), ['s2']);
    assert.deepEqual((plans.value as WaitResult | null)?.changes.map((m) => m.key), ['s2']);
    assert.equal(noAccount.value, null);
    assert.equal(cursor.openWaits, 101);

    cursor.record({ type: 'decision', key: 'd1', sessionId: 's3', accountId: null });
    await tick();
    assert.ok(noAccount.value);
    assert.ok(many.every((m) => m.value?.changes[0]?.key === 'd1'));
    assert.equal(cursor.openWaits, 0);
    assert.equal(clock.timers.size, 0, 'whoever answered disarms the timer');
  });

  test('batches a burst into a single answer', async () => {
    const { cursor, clock } = setup({ batchMs: 50 });
    const waiter = observe(cursor.wait(cursor.current));
    for (let i = 0; i < 30; i++) cursor.record(sessionChange(`s${i % 3}`));
    await tick();
    assert.equal(waiter.value, null);
    assert.equal(clock.timers.size, 1, 'the timeout became the batching timer');
    clock.advance(50);
    const r = await waiter.p;
    assert.equal(r.cursor, 'g1.30');
    assert.deepEqual(r.changes.map((m) => m.key), ['s0', 's1', 's2']);
  });

  test('minimum interval: with non-stop hooks, the loop wakes up at most once per interval', async () => {
    const { cursor, clock } = setup({ batchMs: 50, minIntervalMs: 1000 });
    let answers = 0;
    let waiter = observe(cursor.wait(cursor.current));
    // 10 s of hooks, one every 100 ms, with a client in a long polling loop.
    for (let ms = 0; ms < 10_000; ms += 100) {
      cursor.record(sessionChange('s1'));
      clock.advance(100);
      await tick();
      const v = waiter.value as WaitResult | null;
      if (v) {
        answers++;
        waiter = observe(cursor.wait(v.cursor));
      }
    }
    assert.ok(answers <= 10, `${answers} answers in 10 s`);
    assert.ok(answers >= 9, `${answers} answers in 10 s`);
  });

  test('cap on open waits', async () => {
    const { cursor } = setup({ maxWaiters: 2 });
    void cursor.wait(cursor.current);
    void cursor.wait(cursor.current);
    await assert.rejects(cursor.wait(cursor.current), TooManyWaitersError);
    assert.equal((await cursor.wait(null)).reset, true, 'no cursor answers at once, even when full');
    cursor.close();
  });

  test('a cursor older than the queue asks for a reset', async () => {
    const { cursor } = setup({ capacity: 4 });
    const old = cursor.current;
    const almost = (() => {
      cursor.record(sessionChange('s1'));
      return cursor.current;
    })();
    for (let i = 0; i < 4; i++) cursor.record(sessionChange(`x${i}`));
    assert.equal((await cursor.wait(old)).reset, true);
    const r = await cursor.wait(almost);
    assert.equal(r.reset, false);
    assert.equal(r.changes.length, 4);
  });

  test('abort and close answer at once and release the wait', async () => {
    const { cursor, clock } = setup();
    const ac = new AbortController();
    const waiter = cursor.wait(cursor.current, { signal: ac.signal });
    ac.abort();
    assert.equal((await waiter).timedOut, false);
    const other = cursor.wait(cursor.current);
    cursor.close();
    await other;
    assert.equal(cursor.openWaits, 0);
    assert.equal(clock.timers.size, 0);
  });

  test('idle, with no changes: no internal polling, only one timer per open wait', async () => {
    const { cursor, clock } = setup();
    const waiters = Array.from({ length: 50 }, () => cursor.wait(cursor.current, { timeoutMs: 25_000 }));
    assert.equal(clock.timers.size, 50);
    clock.advance(24_999);
    assert.equal(clock.timers.size, 50, 'no new timer while waiting');
    clock.advance(1);
    const rs = await Promise.all(waiters);
    assert.ok(rs.every((r) => r.timedOut));
    assert.equal(clock.timers.size, 0);
  });
});

describe('change sources', () => {
  test('the wrapped port records session, plan and account, and the rest goes straight through', async () => {
    const { cursor } = setup();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = withChanges(sqlite, cursor);
    const c0 = cursor.current;
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript' }));
    await storage.putAgent(agent({ id: 's1:main', sessionId: 's1' }));
    await storage.putPlan({ sessionId: 's1', source: 'TodoWrite', steps: [], done: 0, total: 0, currentStepId: null, changedAt: T0, metadata: {} });
    const acct = account();
    await storage.putAccount(acct);
    // A hook that only moves updatedAt and metadata forward wakes nobody up.
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript', updatedAt: T0.replace('12:00', '12:05'), metadata: { transcriptPath: '/x.jsonl' } }));
    assert.ok(storage.db, 'the SQLite db is still reachable');
    assert.equal((await storage.getSession('s1'))?.accountId, 'conta-a');
    const r = await cursor.wait(c0);
    assert.deepEqual(
      r.changes.map((m) => [m.type, m.key, m.sessionId, m.accountId]),
      [
        ['session', 's1', 's1', 'conta-a'],
        ['plan', 's1', 's1', 'conta-a'],
        ['account', acct.id, null, acct.id],
      ],
    );
    await storage.close();
  });

  test('an agent that enters or changes status records its session; updatedAt alone does not (#31)', async () => {
    const { cursor } = setup();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = withChanges(sqlite, cursor);
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript' }));
    const a = agent({ id: 's1:a1', sessionId: 's1', type: 'subagent', status: 'working' });
    await storage.putAgent(a);
    const c1 = cursor.current;
    await storage.putAgent({ ...a, updatedAt: T0.replace('12:00', '12:05') });
    assert.equal(cursor.current, c1, 'updatedAt alone is not a change');
    await storage.putAgent({ ...a, status: 'completed', endedAt: T0.replace('12:00', '12:06') });
    const r = await cursor.wait(c1);
    assert.deepEqual(r.changes.map((m) => [m.type, m.key, m.accountId]), [['session', 's1', 'conta-a']]);
    await storage.close();
  });

  test('a written decision and a machine state change become changes, with the session account', async () => {
    const { cursor } = setup();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const accounts = new SessionAccounts(sqlite);
    await sqlite.putSession(session({ id: 's1', accountId: 'conta-b', accountSource: 'transcript' }));
    await sqlite.putAgent(agent({ id: 's1:main', sessionId: 's1' }));
    const storage = withChanges(sqlite, cursor, accounts);
    const decisions = decisionsWithChanges(new SqliteDecisionStore(sqlite.db), cursor, accounts);
    const c0 = cursor.current;
    await registerDecision(decisions, draft({ sessionId: 's1' }), T0);
    const d = await cursor.wait(c0, { filters: { types: ['decision'] } });
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0].accountId, 'conta-b');

    const machine = new SessionStateMachine({ storage, probe: null, now: () => new Date(T0), onChange: onMachineChange(cursor, accounts), log: () => {} });
    const c1 = cursor.current;
    const waiter = cursor.wait(c1, { filters: { types: ['needs-you'] }, timeoutMs: 1000 });
    await machine.apply({ id: 'h1', sessionId: 's1', agentId: null, type: 'Notification', toolName: null, summary: null, data: { notification_type: 'permission_prompt', message: 'Permitir?' }, createdAt: T0 });
    const r = await waiter;
    assert.deepEqual(r.changes.map((m) => [m.type, m.key, m.accountId]), [['needs-you', 's1', 'conta-b']]);
    const all = await cursor.wait(c1);
    assert.deepEqual(new Set(all.changes.map((m) => m.type)), new Set(['session', 'state', 'needs-you']));
    await sqlite.close();
  });
});

describe('HTTP route', () => {
  test('reads and validates the parameters', () => {
    // The old parameter names pass through the alias map, as on the server.
    const p = (q: string) => parseChangesRequest(normalizeLegacyUrl(new URL(`http://x/api/mudancas?${q}`)));
    assert.deepEqual(p('desde=g1.3&espera=5&sessao=s1,s2&conta=a&conta=sem-conta&tipo=plano'), {
      cursor: 'g1.3',
      timeoutMs: 5000,
      filters: { sessionIds: ['s1', 's2'], accountIds: ['a', null], types: ['plan'] },
    });
    // "No account" is `no-account` on the new route; the old `sem-conta` is still accepted on both.
    const parseNew = (q: string) => parseChangesRequest(normalizeLegacyUrl(new URL(`http://x/api/changes?${q}`)));
    for (const q of ['account=a,no-account', 'account=a,sem-conta'])
      assert.deepEqual((parseNew(q) as Exclude<ReturnType<typeof parseNew>, string>).filters.accountIds, ['a', null], q);
    assert.equal(NO_ACCOUNT, 'no-account');
    assert.equal((p('') as { timeoutMs: number }).timeoutMs, DEFAULT_WAIT_MS);
    assert.equal(typeof p('tipo=outro'), 'string');
    assert.equal(typeof p('espera=-1'), 'string');
    assert.equal(typeof p('sessao=a b'), 'string');
  });

  test('GET /api/changes holds until the change and releases when the client gives up', async () => {
    const cursor = new ChangeCursor({ batchMs: 0, minIntervalMs: 0, maxWaiters: 2 });
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = withChanges(sqlite, cursor);
    const work = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const builder = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: work });
    const api = await iniciarApiLocal({ montador: builder, hooks: { storage }, port: 0, log: () => {}, mudancas: cursor });
    try {
      const start = (await (await fetch(`${api.url}/api/changes`)).json()) as WaitResult;
      assert.equal(start.reset, true);
      assert.equal((await fetch(`${api.url}/api/changes?type=x`)).status, 400);

      const request = fetch(`${api.url}/api/changes?since=${start.cursor}&wait=20&session=sess-http`).then((r) => r.json() as Promise<WaitResult>);
      while (cursor.openWaits === 0) await tick();
      const hook = { session_id: 'sess-http', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
      const h = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
      assert.equal(h.status, 202);
      const r = await request;
      assert.deepEqual(r.changes.map((m) => [m.type, m.key]), [['session', 'sess-http']]);

      const ac = new AbortController();
      const quitter = fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`, { signal: ac.signal }).catch(() => null);
      while (cursor.openWaits === 0) await tick();
      ac.abort();
      await quitter;
      while (cursor.openWaits > 0) await tick();
      const load = (await (await fetch(`${api.url}/api/load`)).json()) as { openWaits: number };
      assert.equal(load.openWaits, 0);

      const open = [1, 2].map(() => fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`));
      while (cursor.openWaits < 2) await tick();
      const full = await fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`);
      assert.equal(full.status, 503);
      assert.equal(full.headers.get('retry-after'), '5');
      cursor.close();
      await Promise.all(open);
    } finally {
      await api.close();
      await sqlite.close();
    }
  });
});

describe('MCP tool wait_for_changes', () => {
  const newSignal = () => new AbortController().signal;
  const ctx = () => ({ sinal: newSignal(), versao: null });

  test('same wait, account by label (never the id) and filter by label', async () => {
    const { cursor } = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const team = account({ n: 1, label: 'equipe' });
    const client = account({ n: 2, label: 'cliente' });
    await storage.putAccount(team);
    await storage.putAccount(client);
    const f = waitForChanges({ changes: cursor, accounts: new Contas({ storage, arquivo: null }) });
    assert.equal(f.nome, WAIT_FOR_CHANGES);

    const first = await f.executar({}, ctx());
    assert.equal(first.dados.reset, true);
    const c = first.dados.cursor as string;

    const pending = f.executar({ cursor: c, timeout: 30, account: 'cliente', types: ['plano', 'decisao'] }, ctx());
    cursor.record({ type: 'plan', key: 's1', sessionId: 's1', accountId: team.id });
    cursor.record(sessionChange('s2', { accountId: client.id }));
    cursor.record({ type: 'decision', key: 'd9', sessionId: 's2', accountId: client.id });
    const r = await pending;
    assert.deepEqual(r.dados, {
      cursor: 'g1.3',
      reset: false,
      timedOut: false,
      changes: [{ type: 'decision', sessionId: 's2', decisionId: 'd9', account: { label: 'cliente', color: (r.dados.changes as any)[0].account.color } }],
    });
    assert.ok(!JSON.stringify(r.dados).includes(client.accountUuid), 'the account id does not go out');
    assert.match(r.texto, /1 mudança\(s\): decision 1/);

    const noAccount = f.executar({ cursor: 'g1.3', timeout: 30, account: 'none' }, ctx());
    cursor.record(sessionChange('s3'));
    assert.deepEqual(((await noAccount).dados.changes as any[]).map((m) => [m.type, m.sessionId, m.account]), [['session', 's3', null]]);
    await storage.close();
  });

  test('#173 phase 2b: `types` takes the English names and still the old ones; the answer is English', async () => {
    const { cursor } = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ changes: cursor, accounts: new Contas({ storage, arquivo: null }) });
    const c = cursor.current;
    cursor.record({ type: 'plan', key: 's1', sessionId: 's1', accountId: null });
    cursor.record({ type: 'needs-you', key: 's2', sessionId: 's2', accountId: null });
    cursor.record(sessionChange('s3'));
    const typesOf = async (types: string[]) => ((await f.executar({ cursor: c, timeout: 0, types }, ctx())).dados.changes as { type: string }[]).map((m) => m.type);
    assert.deepEqual(await typesOf(['plan', 'needs-you']), ['plan', 'needs-you']);
    assert.deepEqual(await typesOf(['plano', 'precisa-de-voce']), ['plan', 'needs-you'], 'the old names');
    assert.deepEqual(await typesOf(['sessao', 'state']), ['session'], 'a mix');
    const typeEnum = ((f.entrada as any).properties.types.items.enum as string[]).sort();
    assert.deepEqual(typeEnum, ['account', 'alert', 'conta', 'decisao', 'decision', 'estado', 'needs-you', 'plan', 'plano', 'precisa-de-voce', 'sessao', 'session', 'state']);
    assert.deepEqual((f.saida as any).properties.changes.items.properties.type.enum, ['session', 'state', 'needs-you', 'plan', 'decision', 'account', 'alert']);
    await storage.close();
  });

  test('a `repos` change neither wakes the wait nor shows up, without a filter or with account "none"; and it is not a valid type', async () => {
    const { cursor } = setup();
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ changes: cursor, accounts: new Contas({ storage, arquivo: null }) });
    const c = cursor.current;
    const noFilter = observe(f.executar({ cursor: c, timeout: 30 }, ctx()).then((r) => r.dados as unknown as WaitResult));
    const noAccount = observe(f.executar({ cursor: c, timeout: 30, account: 'none' }, ctx()).then((r) => r.dados as unknown as WaitResult));
    cursor.record({ type: 'repos', key: LIST_CHANGE_KEY, sessionId: null, accountId: null });
    cursor.record({ type: 'repos', key: 'org/repo', sessionId: null, accountId: null });
    await tick();
    assert.equal(noFilter.value, null, 'woke up with `repos`');
    assert.equal(noAccount.value, null, 'woke up with `repos` on account "none"');
    cursor.record(sessionChange('s1'));
    const [a, b] = (await Promise.all([noFilter.p, noAccount.p])) as unknown as { changes: { type: string }[] }[];
    assert.deepEqual(a.changes.map((x) => x.type), ['session']);
    assert.deepEqual(b.changes.map((x) => x.type), ['session']);
    // Recorded before the request already: it does not go out either.
    const later = await f.executar({ cursor: c, timeout: 0 }, ctx());
    assert.ok(!JSON.stringify(later.dados).includes('repos'));
    await assert.rejects(f.executar({ types: ['repos'] }, ctx()), ErroDeArgumento);
    assert.ok(!JSON.stringify(f.entrada).includes('"repos"') && !JSON.stringify(f.saida).includes('"repos"'));
    await storage.close();
  });

  test('a wrong argument and a full cursor come back as a tool error; the signal releases the wait', async () => {
    const { cursor } = setup({ maxWaiters: 1 });
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ changes: cursor, accounts: new Contas({ storage, arquivo: null }) });
    for (const args of [{ types: ['x'] }, { timeout: -1 }, { sessions: ['a b'] }, { account: [] }, { outro: 1 }]) {
      await assert.rejects(f.executar(args as never, ctx()), ErroDeArgumento, JSON.stringify(args));
    }
    const ac = new AbortController();
    const openCall = f.executar({ cursor: cursor.current }, { sinal: ac.signal, versao: null });
    await tick();
    await assert.rejects(f.executar({ cursor: cursor.current }, ctx()), (e: Error) => e instanceof ErroDaFerramenta && /esperas abertas demais/.test(e.message));
    ac.abort();
    assert.equal((await openCall).dados.timedOut, false);
    assert.equal(cursor.openWaits, 0);
    await storage.close();
  });
});
