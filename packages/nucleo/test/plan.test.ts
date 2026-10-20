// Session plan (item 1.9) with hook events and synthetic transcripts of each tool.
// The fields follow the Claude Code format; no real content enters the repository.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { importHistory } from '../src/ingest/history/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { applyToPlan, type SessionPlan } from '../src/plan/index.ts';
import { at, event } from './fixtures.ts';

const SID = 'sess-plano-1';
const common = { session_id: SID, cwd: '/repo/app', transcript_path: '/home/dev/.claude/projects/-repo-app/sess-plano-1.jsonl' };

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

/** Pre and Post of a call, through the hooks. */
async function hook(
  minute: number,
  tool_name: string,
  tool_input: unknown,
  id: string,
  extra: { agent_id?: string; tool_response?: unknown; only?: 'pre' | 'post' } = {},
): Promise<void> {
  const base = { ...common, tool_name, tool_input, tool_use_id: id, ...(extra.agent_id ? { agent_id: extra.agent_id } : {}) };
  if (extra.only !== 'post') await ingestHook(store, { ...base, hook_event_name: 'PreToolUse' }, { receivedAt: at(minute) });
  if (extra.only !== 'pre') {
    await ingestHook(
      store,
      { ...base, hook_event_name: 'PostToolUse', tool_response: extra.tool_response ?? {} },
      { receivedAt: at(minute) },
    );
  }
}

const summary = (p: SessionPlan | null) =>
  p && { done: p.done, total: p.total, current: p.steps.find((s) => s.id === p.currentStepId)?.text ?? null, steps: p.steps.map((s) => [s.id, s.text, s.status]) };

describe('plan from the hooks: TodoWrite', () => {
  test('the whole list becomes the plan, with done/total, current step and change time', async () => {
    await hook(1, 'TodoWrite', {
      todos: [
        { content: 'Ler o código', status: 'completed', activeForm: 'Lendo o código' },
        { content: 'Escrever o teste', status: 'in_progress', activeForm: 'Escrevendo o teste' },
        { content: 'Abrir o PR', status: 'pending', activeForm: 'Abrindo o PR' },
      ],
    }, 'toolu_t1');
    const p = await store.getPlan(SID);
    assert.deepEqual(summary(p), {
      done: 1,
      total: 3,
      current: 'Escrever o teste',
      steps: [['1', 'Ler o código', 'completed'], ['2', 'Escrever o teste', 'in_progress'], ['3', 'Abrir o PR', 'pending']],
    });
    assert.equal(p!.source, 'TodoWrite');
    assert.equal(p!.changedAt, at(1));
    assert.equal(p!.steps[1].activeText, 'Escrevendo o teste');
    assert.deepEqual(p!.steps[0].owner, { kind: 'main', agentId: `${SID}:main`, name: null });
  });

  test('a rewrite replaces the list; a step that did not change keeps its time', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, 'toolu_t1');
    await hook(3, 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, 'toolu_t2');
    const p = await store.getPlan(SID);
    assert.deepEqual(summary(p), { done: 1, total: 3, current: null, steps: [['1', 'A', 'completed'], ['2', 'B', 'pending'], ['3', 'C', 'pending']] });
    assert.deepEqual(p!.steps.map((s) => s.updatedAt), [at(3), at(1), at(3)]);
    assert.equal(p!.changedAt, at(3));
  });

  test('a subagent list is its own and does not replace the session plan', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'Principal', status: 'in_progress' }] }, 'toolu_t1');
    await hook(2, 'TodoWrite', { todos: [{ content: 'Do subagente', status: 'pending' }] }, 'toolu_t2', { agent_id: 'agent-9' });
    assert.deepEqual(summary(await store.getPlan(SID))!.steps, [['1', 'Principal', 'in_progress']]);
  });

  test('a call with an error is undone', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }, 'toolu_t1');
    await hook(2, 'TodoWrite', { todos: [{ content: 'X', status: 'pending' }] }, 'toolu_t2', { tool_response: { is_error: true } });
    assert.deepEqual(summary(await store.getPlan(SID))!.steps, [['1', 'A', 'pending']]);
  });

  test('without any plan tool, there is no plan', async () => {
    await hook(1, 'Bash', { command: 'ls' }, 'toolu_b1');
    assert.equal(await store.getPlan(SID), null);
  });
});

describe('plan from the hooks: TaskCreate and TaskUpdate', () => {
  test('incremental steps with the result id, status and owner', async () => {
    await hook(1, 'TaskCreate', { subject: 'Mapear o esquema', description: 'd', activeForm: 'Mapeando' }, 'toolu_c1', {
      tool_response: { task: { id: '1', subject: 'Mapear o esquema' } },
    });
    await hook(2, 'TaskCreate', { subject: 'Migrar', description: 'd' }, 'toolu_c2', { tool_response: { task: { id: '2', subject: 'Migrar' } } });
    await hook(3, 'TaskCreate', { subject: 'Revisar', description: 'd' }, 'toolu_c3', { tool_response: { task: { id: '3', subject: 'Revisar' } } });
    await hook(4, 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_u1');
    // A subagent picks up step 2: it becomes the owner.
    await hook(5, 'TaskUpdate', { taskId: '2', status: 'in_progress' }, 'toolu_u2', { agent_id: 'agent-7' });
    // Owner given by the tool.
    await hook(6, 'TaskUpdate', { taskId: '3', owner: 'revisor' }, 'toolu_u3');

    const p = (await store.getPlan(SID))!;
    assert.equal(p.source, 'Task');
    assert.deepEqual(summary(p), {
      done: 1,
      total: 3,
      current: 'Migrar',
      steps: [['1', 'Mapear o esquema', 'completed'], ['2', 'Migrar', 'in_progress'], ['3', 'Revisar', 'pending']],
    });
    assert.deepEqual(p.steps.map((s) => s.owner), [
      { kind: 'main', agentId: `${SID}:main`, name: null },
      { kind: 'subagent', agentId: `${SID}:agent-7`, name: null },
      { kind: 'subagent', agentId: null, name: 'revisor' },
    ]);
    assert.equal(p.steps[0].activeText, 'Mapeando');
    assert.equal(p.changedAt, at(6));
  });

  test('the result id fixes the provisional one; deleted removes the step', async () => {
    await hook(1, 'TaskCreate', { subject: 'A', description: 'd' }, 'toolu_c1', { tool_response: { task: { id: '7', subject: 'A' } } });
    await hook(2, 'TaskCreate', { subject: 'B', description: 'd' }, 'toolu_c2', { only: 'pre' });
    assert.deepEqual(summary(await store.getPlan(SID))!.steps, [['7', 'A', 'pending'], ['8', 'B', 'pending']]);
    await hook(3, 'TaskUpdate', { taskId: '7', status: 'deleted' }, 'toolu_u1');
    assert.deepEqual(summary(await store.getPlan(SID))!.steps, [['8', 'B', 'pending']]);
  });

  test('PostToolUse alone (without Pre) also creates the step', async () => {
    await hook(1, 'TaskCreate', { subject: 'A', description: 'd' }, 'toolu_c1', { only: 'post', tool_response: { task: { id: '4', subject: 'A' } } });
    assert.deepEqual(summary(await store.getPlan(SID))!.steps, [['4', 'A', 'pending']]);
  });

  test('TaskUpdate of an unknown task does not create a plan', async () => {
    await hook(1, 'TaskUpdate', { taskId: '9', status: 'completed' }, 'toolu_u1');
    assert.equal(await store.getPlan(SID), null);
  });
});

describe('plan from the hooks: update_plan', () => {
  const UP = 'mcp__ccd_turn__update_plan';

  test('items rewrites, advance, done and start move along; session is the delegated owner', async () => {
    await hook(1, UP, {
      items: [
        { content: 'Ler', status: 'in_progress' },
        { content: 'Implementar', status: 'pending' },
        { content: 'Revisar', status: 'pending', session: 'revisao-19' },
        { content: 'Abrir o PR', status: 'pending' },
      ],
      scope: 'first_task',
    }, 'toolu_p1');
    let p = (await store.getPlan(SID))!;
    assert.equal(p.source, 'update_plan');
    assert.deepEqual(p.steps[2].owner, { kind: 'session', agentId: null, name: 'revisao-19' });

    await hook(2, UP, { advance: true }, 'toolu_p2');
    p = (await store.getPlan(SID))!;
    assert.deepEqual(summary(p)!.steps.map((x) => x[2]), ['completed', 'in_progress', 'pending', 'pending']);

    await hook(3, UP, { done: [2, 3], start: 4 }, 'toolu_p3');
    p = (await store.getPlan(SID))!;
    assert.deepEqual(summary(p), {
      done: 3,
      total: 4,
      current: 'Abrir o PR',
      steps: [['1', 'Ler', 'completed'], ['2', 'Implementar', 'completed'], ['3', 'Revisar', 'completed'], ['4', 'Abrir o PR', 'in_progress']],
    });
    assert.equal(p.changedAt, at(3));
  });

  test('update_plan from any plugin counts', async () => {
    await hook(1, 'mcp__outro__update_plan', { items: [{ content: 'Um', status: 'pending' }] }, 'toolu_p1');
    assert.equal((await store.getPlan(SID))!.total, 1);
  });
});

describe('plan: /clear', () => {
  test('SessionStart from clear empties the plan; the next one starts from scratch', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }] }, 'toolu_t1');
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(2) });
    let p = (await store.getPlan(SID))!;
    assert.deepEqual([p.done, p.total, p.currentStepId, p.changedAt], [0, 0, null, at(2)]);
    await hook(3, 'TaskCreate', { subject: 'Novo', description: 'd' }, 'toolu_c1', { only: 'pre' });
    p = (await store.getPlan(SID))!;
    assert.deepEqual(summary(p)!.steps, [['1', 'Novo', 'pending']]);
  });

  test('a /clear prompt from the transcript also empties it', () => {
    const full = applyToPlan(null, SID, event({ sessionId: SID, agentId: null, type: 'ToolUse', toolName: 'TodoWrite', createdAt: at(1), data: { toolUseId: 't1', tool_input: { todos: [{ content: 'A', status: 'pending' }] } } }))!;
    const cleared = applyToPlan(full, SID, event({ sessionId: SID, agentId: null, type: 'UserPrompt', createdAt: at(2), summary: '<command-name>/clear</command-name> <command-message>clear</command-message>' }))!;
    assert.equal(cleared.total, 0);
    assert.equal(applyToPlan(cleared, SID, event({ sessionId: SID, agentId: null, type: 'UserPrompt', createdAt: at(3), summary: 'oi' })), null);
  });
});

describe('plan from the transcript (importer and follower)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-plan-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S = '00000000-0000-4000-8000-0000000000a1';
  const A = 'a9999999999999999';
  let line = 0;
  const uuid = () => `00000000-0000-4000-9000-${String(++line).padStart(12, '0')}`;
  const ts = (m: number) => at(m);
  const toolUse = (m: number, id: string, name: string, input: unknown, agentId?: string) =>
    JSON.stringify({
      type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: ts(m), sessionId: S, cwd: '/repo/app',
      ...(agentId ? { isSidechain: true, agentId } : {}),
      message: { id: `msg_${line}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
  const toolResult = (m: number, id: string, text: string, toolUseResult?: unknown, agentId?: string) =>
    JSON.stringify({
      type: 'user', uuid: uuid(), parentUuid: null, timestamp: ts(m), sessionId: S,
      ...(agentId ? { isSidechain: true, agentId } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
      ...(toolUseResult ? { toolUseResult } : {}),
    });

  function project(name: string, lines: string[]): { root: string; file: string; sub: string } {
    const root = join(tmp, name);
    mkdirSync(join(root, '-repo-app', S, 'subagents'), { recursive: true });
    const file = join(root, '-repo-app', `${S}.jsonl`);
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    return { root, file, sub: join(root, '-repo-app', S, 'subagents', `agent-${A}.jsonl`) };
  }

  test('TaskCreate, the subagent TaskUpdate from the transcript, and the follower only appends', async () => {
    const { root, file, sub } = project('tarefas', [
      toolUse(1, 'toolu_c1', 'TaskCreate', { subject: 'Ler', description: 'd', activeForm: 'Lendo' }),
      toolResult(1, 'toolu_c1', 'Task #1 created successfully: Ler', { task: { id: '1', subject: 'Ler' } }),
      toolUse(2, 'toolu_c2', 'TaskCreate', { subject: 'Testar', description: 'd' }),
      // No toolUseResult: the id comes from the text.
      toolResult(2, 'toolu_c2', 'Task #2 created successfully: Testar'),
      toolUse(3, 'toolu_u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      toolResult(3, 'toolu_u1', 'Updated task #1 status'),
    ]);
    writeFileSync(sub, `${toolUse(4, 'toolu_u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, A)}\n`);

    await importHistory({ storage: store, root });
    let p = (await store.getPlan(S))!;
    assert.deepEqual(summary(p), { done: 1, total: 2, current: 'Testar', steps: [['1', 'Ler', 'completed'], ['2', 'Testar', 'in_progress']] });
    assert.deepEqual(p.steps[1].owner, { kind: 'subagent', agentId: `${S}:${A}`, name: null });
    assert.equal(p.changedAt, ts(4));

    // A run without a change does not rewrite; a new line moves the plan (the follower calls the same importer).
    await importHistory({ storage: store, root });
    assert.deepEqual(await store.getPlan(S), p);
    appendFileSync(file, `${toolUse(5, 'toolu_u3', 'TaskUpdate', { taskId: '2', status: 'completed' })}\n`);
    await importHistory({ storage: store, root });
    p = (await store.getPlan(S))!;
    assert.deepEqual([p.done, p.total, p.currentStepId, p.changedAt], [2, 2, null, ts(5)]);
  });

  test('TodoWrite and update_plan with an error in the result', async () => {
    const { root } = project('todo', [
      toolUse(1, 'toolu_t1', 'TodoWrite', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Fazendo A' }, { content: 'B', status: 'pending', activeForm: 'Fazendo B' }] }),
      toolResult(1, 'toolu_t1', 'Todos have been modified successfully', { oldTodos: [], newTodos: [] }),
      toolUse(2, 'toolu_p1', 'mcp__ccd_turn__update_plan', { advance: true }),
      toolResult(2, 'toolu_p1', 'Plan updated'),
      toolUse(3, 'toolu_p2', 'mcp__ccd_turn__update_plan', { done: [2] }),
      JSON.stringify({
        type: 'user', uuid: uuid(), timestamp: ts(3), sessionId: S,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p2', content: 'erro', is_error: true }] },
      }),
    ]);
    await importHistory({ storage: store, root });
    const p = (await store.getPlan(S))!;
    assert.equal(p.source, 'update_plan');
    assert.deepEqual(summary(p), { done: 1, total: 2, current: 'B', steps: [['1', 'A', 'completed'], ['2', 'B', 'in_progress']] });
  });

  test('the same call from the hook and the transcript counts once', async () => {
    await ingestHook(
      store,
      { ...common, session_id: S, hook_event_name: 'PreToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'Único', description: 'd' }, tool_use_id: 'toolu_c1' },
      { receivedAt: ts(1) },
    );
    const { root } = project('duplo', [
      toolUse(1, 'toolu_c1', 'TaskCreate', { subject: 'Único', description: 'd' }),
      toolResult(1, 'toolu_c1', 'Task #1 created successfully: Único', { task: { id: '1', subject: 'Único' } }),
    ]);
    await importHistory({ storage: store, root });
    assert.deepEqual(summary(await store.getPlan(S))!.steps, [['1', 'Único', 'pending']]);
  });
});

describe('migration 3: session plan', () => {
  test('a version 2 database gets the session_plans table', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2));
    assert.equal(schemaVersion(db), 2);
    assert.deepEqual(migrate(db, MIGRATIONS.filter((m) => m.version <= 3)), [3]);
    const cols = (db.prepare('PRAGMA table_info(session_plans)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['session_id', 'source', 'steps', 'done', 'total', 'current_step_id', 'changed_at', 'metadata']);
    db.close();
  });
});
