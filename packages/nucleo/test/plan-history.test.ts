// History of the session's plans (issue #131), with hook events and synthetic transcripts.
// No real content enters the repository.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { importHistory } from '../src/ingest/history/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { updatePlan, splitPlan, type PlanRecord, type PlanStep } from '../src/plan/index.ts';
import { at, event } from './fixtures.ts';

const SID = 'sess-historico-1';
const common = { session_id: SID, cwd: '/repo/app', transcript_path: '/home/dev/.claude/projects/-repo-app/sess-historico-1.jsonl' };

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

let callCount = 0;
async function hook(minute: number, tool_name: string, tool_input: unknown, tool_response: unknown = {}): Promise<void> {
  const base = { ...common, tool_name, tool_input, tool_use_id: `toolu_h${++callCount}` };
  await ingestHook(store, { ...base, hook_event_name: 'PreToolUse' }, { receivedAt: at(minute) });
  await ingestHook(store, { ...base, hook_event_name: 'PostToolUse', tool_response }, { receivedAt: at(minute) });
}

type St = 'pending' | 'in_progress' | 'completed';
const todos = (minute: number, ...items: [string, St][]) =>
  hook(minute, 'TodoWrite', { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) });

/** The plans as rows easy to compare, newest first. */
const planHistory = async () =>
  (await store.listPlanRecords(SID)).map((r) => ({
    seq: r.seq,
    result: r.result,
    progress: `${r.done}/${r.total}`,
    steps: r.steps.map((s) => s.text),
    start: r.startedAt,
    end: r.endedAt,
  }));

const step = (text: string, status: St = 'pending', id = text): PlanStep => ({
  id, text, activeText: null, status, owner: { kind: 'main', agentId: null, name: null }, updatedAt: at(0),
});

describe('CA1: splitting the plans (pure function)', () => {
  const abc = [step('Ler', 'completed'), step('Escrever', 'in_progress'), step('Testar')];

  test('adjustments stay in the plan: check, reorder, append and rename', () => {
    assert.equal(splitPlan(abc, [step('Ler', 'completed'), step('Escrever', 'completed'), step('Testar', 'in_progress')]), 'continue');
    assert.equal(splitPlan(abc, [abc[2], abc[0], abc[1]]), 'continue');
    assert.equal(splitPlan(abc, [...abc, step('Abrir o PR'), step('Pedir review')]), 'continue');
    assert.equal(splitPlan(abc, [abc[0], step('Escrever o teste', 'in_progress'), abc[2]]), 'continue');
    assert.equal(splitPlan(abc, [abc[0], abc[1]]), 'continue');
  });

  test('the list swapped for a substantially different one is a new plan', () => {
    assert.equal(splitPlan(abc, [step('Medir'), step('Cachear'), step('Ler')]), 'new');
    assert.equal(splitPlan(abc, [step('Outra coisa')]), 'new');
  });

  test('the previous one finished and another comes: new plan; unchecking or renaming a done step continues', () => {
    const finished = abc.map((s) => ({ ...s, status: 'completed' as const }));
    assert.equal(splitPlan(finished, [...finished, step('Publicar')]), 'new');
    assert.equal(splitPlan(finished, finished.map((s) => ({ ...s, status: 'pending' as const }))), 'new');
    assert.equal(splitPlan(finished, [finished[0], finished[1], step('Testar', 'in_progress')]), 'continue');
    assert.equal(splitPlan(finished, [finished[0], finished[1], step('Testar tudo', 'completed')]), 'continue');
  });

  test('a one-step change (TaskCreate, TaskUpdate) never replaces an unfinished plan', () => {
    assert.equal(splitPlan([step('Ler', 'in_progress')], [step('Ler', 'in_progress'), step('A'), step('B')], true), 'continue');
    assert.equal(splitPlan([step('Ler', 'in_progress')], [step('Ler de novo', 'in_progress', 'Ler')], true), 'continue');
    assert.equal(splitPlan([step('Ler', 'completed')], [step('Ler', 'completed'), step('A')], true), 'new');
  });

  test('an empty list closes the plan; the first plan starts from nothing', () => {
    assert.equal(splitPlan(abc, []), 'end');
    assert.equal(splitPlan([], []), 'continue');
    assert.equal(splitPlan([], abc), 'new');
  });
});

describe('CA1 and CA2: several plans in a session, from the hooks', () => {
  test('each plan with start, end, steps, done/total and result', async () => {
    await todos(1, ['Ler o código', 'in_progress'], ['Escrever o teste', 'pending'], ['Abrir o PR', 'pending']);
    await todos(2, ['Ler o código', 'completed'], ['Escrever o teste', 'in_progress'], ['Abrir o PR', 'pending']);
    // Changed its mind: another list, the first one is abandoned with 1 of 3.
    await todos(3, ['Medir a consulta', 'in_progress'], ['Criar o índice', 'pending']);
    await todos(4, ['Medir a consulta', 'completed'], ['Criar o índice', 'completed']);
    // The second one finished; another comes.
    await todos(5, ['Atualizar a doc', 'in_progress']);

    assert.deepEqual(await planHistory(), [
      { seq: 3, result: 'current', progress: '0/1', steps: ['Atualizar a doc'], start: at(5), end: null },
      { seq: 2, result: 'completed', progress: '2/2', steps: ['Medir a consulta', 'Criar o índice'], start: at(3), end: at(5) },
      { seq: 1, result: 'abandoned', progress: '1/3', steps: ['Ler o código', 'Escrever o teste', 'Abrir o PR'], start: at(1), end: at(3) },
    ]);
    // The session plan is still the current list.
    assert.equal((await store.getPlan(SID))!.total, 1);
  });

  test('a rewrite that only adjusts (checks, reorders, appends, renames) stays in the same plan', async () => {
    await todos(1, ['Ler', 'in_progress'], ['Escrever', 'pending'], ['Testar', 'pending']);
    await todos(2, ['Ler', 'completed'], ['Testar', 'pending'], ['Escrever', 'in_progress']);
    await todos(3, ['Ler', 'completed'], ['Testar tudo', 'pending'], ['Escrever', 'in_progress'], ['Abrir o PR', 'pending']);
    const h = await planHistory();
    assert.equal(h.length, 1);
    assert.deepEqual(h[0], { seq: 1, result: 'current', progress: '1/4', steps: ['Ler', 'Testar tudo', 'Escrever', 'Abrir o PR'], start: at(1), end: null });
  });

  test('a finished plan stays the current one until another comes', async () => {
    await todos(1, ['Ler', 'completed'], ['Escrever', 'completed']);
    assert.deepEqual((await planHistory()).map((r) => [r.result, r.progress]), [['current', '2/2']]);
  });

  test('TaskCreate after the done tasks opens a plan with only the new ones', async () => {
    await hook(1, 'TaskCreate', { subject: 'Ler', description: 'd' }, { task: { id: '1' } });
    await hook(2, 'TaskCreate', { subject: 'Testar', description: 'd' }, { task: { id: '2' } });
    await hook(3, 'TaskUpdate', { taskId: '1', status: 'completed' });
    await hook(4, 'TaskUpdate', { taskId: '2', status: 'completed' });
    await hook(5, 'TaskCreate', { subject: 'Publicar', description: 'd' }, { task: { id: '3' } });
    await hook(6, 'TaskUpdate', { taskId: '3', status: 'in_progress' });
    await hook(7, 'TaskCreate', { subject: 'Avisar o time', description: 'd' }, { task: { id: '4' } });
    assert.deepEqual(await planHistory(), [
      { seq: 2, result: 'current', progress: '0/2', steps: ['Publicar', 'Avisar o time'], start: at(5), end: null },
      { seq: 1, result: 'completed', progress: '2/2', steps: ['Ler', 'Testar'], start: at(1), end: at(5) },
    ]);
    // The old tasks stay in the tool's list, but the current plan is made of the new ones.
    assert.equal((await store.getPlan(SID))!.total, 4);
    const current = (await store.listPlanRecords(SID))[0];
    assert.equal(current.steps.find((s) => s.id === current.currentStepId)?.text, 'Publicar');
  });

  test('update_plan: items opens the plan, advance moves along it', async () => {
    await hook(1, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Ler', status: 'in_progress' }, { content: 'Fazer', status: 'pending' }] });
    await hook(2, 'mcp__ccd_turn__update_plan', { advance: true });
    await hook(3, 'mcp__ccd_turn__update_plan', { advance: true });
    await hook(4, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Revisar o PR', status: 'in_progress' }] });
    assert.deepEqual((await planHistory()).map((r) => [r.seq, r.result, r.progress]), [[2, 'current', '0/1'], [1, 'completed', '2/2']]);
  });
});

describe('CA1: /clear', () => {
  test('/clear closes the plan (abandoned with X of Y); the next one is another plan', async () => {
    await todos(1, ['Ler', 'completed'], ['Escrever', 'in_progress'], ['Testar', 'pending']);
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(2) });
    assert.deepEqual((await planHistory()).map((r) => [r.seq, r.result, r.progress, r.end]), [[1, 'abandoned', '1/3', at(2)]]);
    // The same list after /clear is another plan, from scratch.
    await todos(3, ['Ler', 'in_progress'], ['Escrever', 'pending'], ['Testar', 'pending']);
    assert.deepEqual((await planHistory()).map((r) => [r.seq, r.result, r.progress, r.start]), [[2, 'current', '0/3', at(3)], [1, 'abandoned', '1/3', at(1)]]);
  });

  test('/clear without a plan creates nothing', async () => {
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(1) });
    assert.deepEqual(await store.listPlanRecords(SID), []);
  });
});

describe('CA2: written through the port, additive migration', () => {
  test('a plan stored before the history becomes the first one on the next change', async () => {
    await store.putPlan({
      sessionId: SID, source: 'TodoWrite', steps: [{ ...step('Ler', 'in_progress', '1') }, { ...step('Escrever', 'pending', '2') }],
      done: 0, total: 2, currentStepId: '1', changedAt: at(1), metadata: {},
    });
    await todos(4, ['Ler', 'completed'], ['Escrever', 'in_progress']);
    assert.deepEqual(await planHistory(), [{ seq: 1, result: 'current', progress: '1/2', steps: ['Ler', 'Escrever'], start: at(1), end: null }]);
  });

  test('several events at once write the same history as one by one', async () => {
    const tw = (m: number, ...items: [string, St][]) =>
      event({ sessionId: SID, agentId: null, type: 'ToolUse', toolName: 'TodoWrite', createdAt: at(m), data: { toolUseId: `t${m}`, tool_input: { todos: items.map(([content, status]) => ({ content, status })) } } });
    await updatePlan(store, SID, [tw(1, ['A', 'completed']), tw(2, ['B', 'in_progress']), tw(3, ['B', 'completed'], ['C', 'pending'])]);
    assert.deepEqual((await planHistory()).map((r) => [r.seq, r.result, r.steps]), [[2, 'current', ['B', 'C']], [1, 'completed', ['A']]]);
  });

  test('a version 4 database gets the session_plan_history table, without touching what exists', () => {
    const m = MIGRATIONS.find((x) => x.sql.includes('CREATE TABLE session_plan_history'))!;
    assert.doesNotMatch(m.sql, /\b(DROP|ALTER)\b/);
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((x) => x.version < m.version));
    assert.deepEqual(migrate(db, MIGRATIONS.filter((x) => x.version <= m.version)), [m.version]);
    assert.equal(schemaVersion(db), m.version);
    const cols = (db.prepare('PRAGMA table_info(session_plan_history)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['session_id', 'seq', 'source', 'started_at', 'ended_at', 'result', 'steps', 'done', 'total', 'current_step_id', 'changed_at', 'metadata']);
    db.close();
  });
});

describe('CA1: from the transcript (importer)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-plan-history-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S = '00000000-0000-4000-8000-0000000000b1';
  let line = 0;
  const uuid = () => `00000000-0000-4000-9000-${String(++line).padStart(12, '0')}`;
  const todoWrite = (m: number, items: [string, St][]) =>
    JSON.stringify({
      type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: S, cwd: '/repo/app',
      message: { id: `msg_${line}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_t${line}`, name: 'TodoWrite', input: { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) } }] },
    });
  const clear = (m: number) =>
    JSON.stringify({ type: 'user', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: S, message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } });

  test('rewrite, /clear and new plan come from the transcript', async () => {
    const root = join(tmp, 'projetos');
    mkdirSync(join(root, '-repo-app'), { recursive: true });
    writeFileSync(
      join(root, '-repo-app', `${S}.jsonl`),
      [
        todoWrite(1, [['Ler', 'in_progress'], ['Escrever', 'pending']]),
        todoWrite(2, [['Ler', 'completed'], ['Escrever', 'completed']]),
        todoWrite(3, [['Publicar', 'in_progress'], ['Avisar', 'pending']]),
        clear(4),
        todoWrite(5, [['Recomeçar', 'in_progress']]),
      ].map((l) => `${l}\n`).join(''),
    );
    await importHistory({ storage: store, root });
    const r: PlanRecord[] = await store.listPlanRecords(S);
    assert.deepEqual(
      r.map((x) => [x.seq, x.result, `${x.done}/${x.total}`, x.startedAt, x.endedAt]),
      [
        [3, 'current', '0/1', at(5), null],
        [2, 'abandoned', '0/2', at(3), at(4)],
        [1, 'completed', '2/2', at(1), at(3)],
      ],
    );
  });
});
