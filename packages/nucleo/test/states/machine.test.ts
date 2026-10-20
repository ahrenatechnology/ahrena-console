// The machine end to end: hooks through the HTTP receiver, saved in SQLite, watcher with a fake clock and probe.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SessionStateMachine, readInbox, readMemory, fixedProbe, type StateChange } from '../../src/states/index.ts';
import { importHistory } from '../../src/ingest/historico/importer.ts';
import { ingestHook, startHookReceiver, type HookReceiver } from '../../src/ingest/hooks/index.ts';
import { displayStatus } from '../../src/model.ts';
import { at } from '../fixtures.ts';
import { HOOK_PAYLOADS } from '../ingest/hook-payloads.ts';

const SID = 'sess-hooks-1';
const seconds = (s: number) => new Date(Date.parse(at(0)) + s * 1000).toISOString();

describe('machine with SQLite', () => {
  let store: SqliteStorage;
  let clock: Date;
  let liveDirs: string[] | null;
  let changes: StateChange[];
  let machine: SessionStateMachine;

  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
    clock = new Date(at(0));
    liveDirs = ['/repo/app'];
    changes = [];
    machine = new SessionStateMachine({
      storage: store,
      now: () => clock,
      probe: { liveDirs: async () => (liveDirs ? new Set(liveDirs) : null) },
      onChange: (m) => changes.push(m),
      log: () => {},
    });
  });
  afterEach(() => store.close());

  /** Saves the hook as the receiver would and passes it through the machine. */
  async function hook(payload: object, when: string) {
    const r = await ingestHook(store, payload, { receivedAt: when, deliveryId: `${when}-${JSON.stringify(payload).length}` });
    return machine.apply(r.event);
  }
  const session = async () => (await store.getSession(SID))!;
  const agents = () => store.listAgents(SID);

  test('lifecycle: start, prompt, permission, tool, end of turn, end', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    assert.equal((await session()).awaitingReason, 'session_start');
    assert.equal((await agents())[0].id, `${SID}:main`);

    await hook(HOOK_PAYLOADS.UserPromptSubmit, seconds(5));
    assert.equal(displayStatus(await session()), 'active');

    await hook(HOOK_PAYLOADS.PreToolUse, seconds(6));
    await hook(HOOK_PAYLOADS.Notification, seconds(7));
    let s = await session();
    assert.equal(s.awaitingReason, 'notification');
    assert.equal(readInbox(s, await agents()).urgent, true);

    await hook(HOOK_PAYLOADS.PostToolUse, seconds(20));
    assert.equal((await session()).awaitingReason, null);

    await hook(HOOK_PAYLOADS.Stop, seconds(30));
    s = await session();
    assert.equal(s.awaitingReason, 'stop');
    assert.equal(s.status, 'active');

    await hook(HOOK_PAYLOADS.SessionEnd, seconds(40));
    s = await session();
    assert.equal(s.status, 'completed');
    assert.equal(s.endedAt, seconds(40));
    assert.ok((await agents()).every((a) => a.status === 'completed'));

    assert.deepEqual(
      changes.map((m) => `${m.before}→${m.after}`),
      ['active→waiting', 'waiting→active', 'active→waiting', 'waiting→active', 'active→waiting', 'waiting→completed'],
    );
  });

  test('the machine keeps what the receiver and the importer save', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    const s = await session();
    assert.equal(s.metadata.transcriptPath, HOOK_PAYLOADS.SessionStart.transcript_path);
    assert.equal(s.cwd, '/repo/app');
    assert.equal(s.model, 'claude-opus-5-5');
    assert.ok(readMemory(s).ultimoEvento);
  });

  test('watcher: a dead turn becomes waiting interrupted and leaves an Interrupted event', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    await hook(HOOK_PAYLOADS.UserPromptSubmit, seconds(5));

    clock = new Date(seconds(100));
    assert.deepEqual(await machine.sweep(), []);

    clock = new Date(seconds(125));
    const [m] = await machine.sweep();
    assert.equal(m.rule, 'dead_turn');
    assert.equal(m.after, 'waiting');
    const s = await session();
    assert.equal(s.awaitingReason, 'interrupted');
    assert.equal(s.updatedAt, seconds(5), 'the watcher does not count as activity');
    const events = (await store.listEvents(SID)).items;
    assert.equal(events.at(-1)?.type, 'Interrupted');

    // The watcher does not repeat.
    clock = new Date(seconds(200));
    assert.deepEqual(await machine.sweep(), []);

    // The turn was alive: the PostToolUse arrives.
    await hook(HOOK_PAYLOADS.PostToolUse, seconds(210));
    assert.equal((await session()).awaitingReason, null);
  });

  test('watcher: the probe with no process ends with a synthetic SessionEnd', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    liveDirs = [];
    clock = new Date(seconds(10));
    assert.deepEqual(await machine.sweep(), [], 'within the grace period');

    clock = new Date(seconds(40));
    const [m] = await machine.sweep();
    assert.equal(m.rule, 'probe');
    assert.equal((await session()).status, 'completed');
    const last = (await store.listEvents(SID)).items.at(-1);
    assert.equal(last?.type, 'SessionEnd');
    assert.deepEqual(last?.data, { sintetico: true, reason: 'processo_encerrado' });

    // It was a mistake (a different cwd, for example): the next hook reopens it.
    await hook(HOOK_PAYLOADS.UserPromptSubmit, seconds(50));
    assert.equal((await session()).status, 'active');
  });

  test('watcher: the probe off ends nothing; abandonment after 180 min', async () => {
    liveDirs = null;
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    await hook(HOOK_PAYLOADS.Stop, seconds(5));
    clock = new Date(at(180));
    assert.deepEqual(await machine.sweep(), []);
    clock = new Date(Date.parse(at(180)) + 5_000);
    const [m] = await machine.sweep();
    assert.equal(m.rule, 'abandonment');
    const s = await session();
    assert.equal(s.status, 'abandoned');
    assert.equal(s.awaitingInputSince, null);
  });

  test('error healing: the transcript went on after the error', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    await hook(HOOK_PAYLOADS.UserPromptSubmit, seconds(5));
    await hook({ ...HOOK_PAYLOADS.Stop, stop_reason: 'error' }, seconds(10));
    assert.equal((await session()).status, 'error');

    // The importer (or real time) saves what the transcript has after the error, without going through the machine.
    await store.appendEvent({ id: 'jsonl:retry', sessionId: SID, agentId: `${SID}:main`, type: 'AssistantMessage', toolName: null, summary: 'ok', data: null, createdAt: seconds(20) });
    await store.putSession({ ...(await session()), updatedAt: seconds(20) });

    clock = new Date(seconds(25));
    const [m] = await machine.sweep();
    assert.equal(m.before, 'error');
    assert.equal(m.after, 'active');
    assert.equal((await session()).status, 'active');
  });

  test('sync applies the events not seen yet, in order', async () => {
    await hook(HOOK_PAYLOADS.SessionStart, seconds(0));
    for (const [i, type] of ['UserPrompt', 'ToolUse', 'ToolResult', 'TurnDuration'].entries()) {
      await store.appendEvent({ id: `jsonl:${i}`, sessionId: SID, agentId: null, type, toolName: null, summary: null, data: null, createdAt: seconds(10 + i) });
    }
    const m = await machine.sync(SID);
    assert.equal(m?.cause, 'TurnDuration');
    assert.equal((await session()).awaitingReason, 'stop');
    assert.equal(await machine.sync(SID), null, 'nothing new the second time');
  });

  test('history backfill does not touch the live state nor reopen an imported session', async () => {
    const root = join(import.meta.dirname, '..', 'fixtures', 'historico', 'projects');
    await importHistory({ storage: store, root });
    const imported = (await store.listSessions()).items;
    assert.ok(imported.length > 0);
    clock = new Date('2030-01-01T00:00:00.000Z');
    assert.deepEqual(await machine.sweep(), []);
    for (const s of imported) assert.equal((await store.getSession(s.id))?.status, 'completed');
  });

  test('an event of a session that does not exist is ignored', async () => {
    assert.equal(
      await machine.apply({ id: 'x', sessionId: 'nao-existe', agentId: null, type: 'Stop', toolName: null, summary: null, data: null, createdAt: at(0) }),
      null,
    );
  });
});

describe('hooked on the hook receiver', () => {
  let store: SqliteStorage;
  let receiver: HookReceiver;
  let pending: Promise<void>;

  beforeEach(async () => {
    store = openSqliteStorage({ path: ':memory:' });
    const machine = new SessionStateMachine({ storage: store, probe: fixedProbe(null), log: () => {} });
    pending = Promise.resolve();
    receiver = await startHookReceiver({
      storage: store,
      port: 0,
      log: () => {},
      onEvent: (r) => {
        pending = pending.then(() => machine.onHook(r));
        return pending;
      },
    });
  });
  afterEach(async () => {
    await receiver.close();
    store.close();
  });

  async function post(payload: object, when: string) {
    const res = await fetch(`${receiver.url}/api/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ahrena-hook-at': when, 'x-ahrena-delivery-id': `${when}-${Math.random()}` },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 202);
    // onEvent runs after the response.
    await new Promise((r) => setTimeout(r, 20));
    await pending;
  }

  test('subagent: delegating while it runs, waiting for you after SubagentStop', async () => {
    await post(HOOK_PAYLOADS.SessionStart, seconds(0));
    await post(HOOK_PAYLOADS.UserPromptSubmit, seconds(1));
    await post({ ...HOOK_PAYLOADS.PreToolUse, tool_name: 'Agent', tool_use_id: 'tu-ag', tool_input: { description: 'explorar' } }, seconds(2));
    await post({ ...HOOK_PAYLOADS.PreToolUse, tool_use_id: 'tu-sub', agent_id: 'agent-7', agent_type: 'Explore' }, seconds(3));

    let s = (await store.getSession(SID))!;
    let ag = await store.listAgents(SID);
    assert.equal(readInbox(s, ag).state, 'delegating');
    assert.ok(ag.some((a) => a.id === `${SID}:agent-7` && a.status === 'working'));

    await post(HOOK_PAYLOADS.SubagentStop, seconds(10));
    await post({ ...HOOK_PAYLOADS.PostToolUse, tool_name: 'Agent', tool_use_id: 'tu-ag' }, seconds(11));
    await post(HOOK_PAYLOADS.Stop, seconds(12));

    s = (await store.getSession(SID))!;
    ag = await store.listAgents(SID);
    assert.equal(ag.find((a) => a.id === `${SID}:agent-7`)?.status, 'completed');
    const reading = readInbox(s, ag);
    assert.equal(reading.state, 'waiting');
    assert.equal(reading.needsYou, true);
  });
});
