// Plano da sessão (item 1.9) com eventos de hook e transcripts sintéticos de cada ferramenta.
// Os campos seguem o formato do Claude Code; nenhum conteúdo real entra no repositório.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { importHistory } from '../src/ingest/historico/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { aplicarAoPlano, type SessionPlan } from '../src/plano/index.ts';
import { at, event } from './fixtures.ts';

const SID = 'sess-plano-1';
const common = { session_id: SID, cwd: '/repo/app', transcript_path: '/home/dev/.claude/projects/-repo-app/sess-plano-1.jsonl' };

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

/** Pre e Post de uma chamada, pelos hooks. */
async function hook(
  minuto: number,
  tool_name: string,
  tool_input: unknown,
  id: string,
  extra: { agent_id?: string; tool_response?: unknown; so?: 'pre' | 'post' } = {},
): Promise<void> {
  const base = { ...common, tool_name, tool_input, tool_use_id: id, ...(extra.agent_id ? { agent_id: extra.agent_id } : {}) };
  if (extra.so !== 'post') await ingestHook(store, { ...base, hook_event_name: 'PreToolUse' }, { receivedAt: at(minuto) });
  if (extra.so !== 'pre') {
    await ingestHook(
      store,
      { ...base, hook_event_name: 'PostToolUse', tool_response: extra.tool_response ?? {} },
      { receivedAt: at(minuto) },
    );
  }
}

const resumo = (p: SessionPlan | null) =>
  p && { done: p.done, total: p.total, atual: p.steps.find((s) => s.id === p.currentStepId)?.text ?? null, passos: p.steps.map((s) => [s.id, s.text, s.status]) };

describe('plano pelos hooks: TodoWrite', () => {
  test('a lista inteira vira o plano, com feitos/total, passo atual e hora da mudança', async () => {
    await hook(1, 'TodoWrite', {
      todos: [
        { content: 'Ler o código', status: 'completed', activeForm: 'Lendo o código' },
        { content: 'Escrever o teste', status: 'in_progress', activeForm: 'Escrevendo o teste' },
        { content: 'Abrir o PR', status: 'pending', activeForm: 'Abrindo o PR' },
      ],
    }, 'toolu_t1');
    const p = await store.getPlan(SID);
    assert.deepEqual(resumo(p), {
      done: 1,
      total: 3,
      atual: 'Escrever o teste',
      passos: [['1', 'Ler o código', 'completed'], ['2', 'Escrever o teste', 'in_progress'], ['3', 'Abrir o PR', 'pending']],
    });
    assert.equal(p!.source, 'TodoWrite');
    assert.equal(p!.changedAt, at(1));
    assert.equal(p!.steps[1].activeText, 'Escrevendo o teste');
    assert.deepEqual(p!.steps[0].owner, { kind: 'main', agentId: `${SID}:main`, name: null });
  });

  test('reescrita substitui a lista; passo que não mudou mantém a hora', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, 'toolu_t1');
    await hook(3, 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, 'toolu_t2');
    const p = await store.getPlan(SID);
    assert.deepEqual(resumo(p), { done: 1, total: 3, atual: null, passos: [['1', 'A', 'completed'], ['2', 'B', 'pending'], ['3', 'C', 'pending']] });
    assert.deepEqual(p!.steps.map((s) => s.updatedAt), [at(3), at(1), at(3)]);
    assert.equal(p!.changedAt, at(3));
  });

  test('lista do subagente é dele e não troca o plano da sessão', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'Principal', status: 'in_progress' }] }, 'toolu_t1');
    await hook(2, 'TodoWrite', { todos: [{ content: 'Do subagente', status: 'pending' }] }, 'toolu_t2', { agent_id: 'agent-9' });
    assert.deepEqual(resumo(await store.getPlan(SID))!.passos, [['1', 'Principal', 'in_progress']]);
  });

  test('chamada com erro é desfeita', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }, 'toolu_t1');
    await hook(2, 'TodoWrite', { todos: [{ content: 'X', status: 'pending' }] }, 'toolu_t2', { tool_response: { is_error: true } });
    assert.deepEqual(resumo(await store.getPlan(SID))!.passos, [['1', 'A', 'pending']]);
  });

  test('sem nenhuma ferramenta de plano, não há plano', async () => {
    await hook(1, 'Bash', { command: 'ls' }, 'toolu_b1');
    assert.equal(await store.getPlan(SID), null);
  });
});

describe('plano pelos hooks: TaskCreate e TaskUpdate', () => {
  test('passos incrementais com o id do resultado, estado e dono', async () => {
    await hook(1, 'TaskCreate', { subject: 'Mapear o esquema', description: 'd', activeForm: 'Mapeando' }, 'toolu_c1', {
      tool_response: { task: { id: '1', subject: 'Mapear o esquema' } },
    });
    await hook(2, 'TaskCreate', { subject: 'Migrar', description: 'd' }, 'toolu_c2', { tool_response: { task: { id: '2', subject: 'Migrar' } } });
    await hook(3, 'TaskCreate', { subject: 'Revisar', description: 'd' }, 'toolu_c3', { tool_response: { task: { id: '3', subject: 'Revisar' } } });
    await hook(4, 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_u1');
    // Um subagente pega o passo 2: vira o dono.
    await hook(5, 'TaskUpdate', { taskId: '2', status: 'in_progress' }, 'toolu_u2', { agent_id: 'agent-7' });
    // Dono dado pela ferramenta.
    await hook(6, 'TaskUpdate', { taskId: '3', owner: 'revisor' }, 'toolu_u3');

    const p = (await store.getPlan(SID))!;
    assert.equal(p.source, 'Task');
    assert.deepEqual(resumo(p), {
      done: 1,
      total: 3,
      atual: 'Migrar',
      passos: [['1', 'Mapear o esquema', 'completed'], ['2', 'Migrar', 'in_progress'], ['3', 'Revisar', 'pending']],
    });
    assert.deepEqual(p.steps.map((s) => s.owner), [
      { kind: 'main', agentId: `${SID}:main`, name: null },
      { kind: 'subagent', agentId: `${SID}:agent-7`, name: null },
      { kind: 'subagent', agentId: null, name: 'revisor' },
    ]);
    assert.equal(p.steps[0].activeText, 'Mapeando');
    assert.equal(p.changedAt, at(6));
  });

  test('o id do resultado corrige o provisório; deleted tira o passo', async () => {
    await hook(1, 'TaskCreate', { subject: 'A', description: 'd' }, 'toolu_c1', { tool_response: { task: { id: '7', subject: 'A' } } });
    await hook(2, 'TaskCreate', { subject: 'B', description: 'd' }, 'toolu_c2', { so: 'pre' });
    assert.deepEqual(resumo(await store.getPlan(SID))!.passos, [['7', 'A', 'pending'], ['8', 'B', 'pending']]);
    await hook(3, 'TaskUpdate', { taskId: '7', status: 'deleted' }, 'toolu_u1');
    assert.deepEqual(resumo(await store.getPlan(SID))!.passos, [['8', 'B', 'pending']]);
  });

  test('só o PostToolUse (sem o Pre) também cria o passo', async () => {
    await hook(1, 'TaskCreate', { subject: 'A', description: 'd' }, 'toolu_c1', { so: 'post', tool_response: { task: { id: '4', subject: 'A' } } });
    assert.deepEqual(resumo(await store.getPlan(SID))!.passos, [['4', 'A', 'pending']]);
  });

  test('TaskUpdate de tarefa desconhecida não cria plano', async () => {
    await hook(1, 'TaskUpdate', { taskId: '9', status: 'completed' }, 'toolu_u1');
    assert.equal(await store.getPlan(SID), null);
  });
});

describe('plano pelos hooks: update_plan', () => {
  const UP = 'mcp__ccd_turn__update_plan';

  test('items reescreve, advance, done e start andam; session é o dono delegado', async () => {
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
    assert.deepEqual(resumo(p)!.passos.map((x) => x[2]), ['completed', 'in_progress', 'pending', 'pending']);

    await hook(3, UP, { done: [2, 3], start: 4 }, 'toolu_p3');
    p = (await store.getPlan(SID))!;
    assert.deepEqual(resumo(p), {
      done: 3,
      total: 4,
      atual: 'Abrir o PR',
      passos: [['1', 'Ler', 'completed'], ['2', 'Implementar', 'completed'], ['3', 'Revisar', 'completed'], ['4', 'Abrir o PR', 'in_progress']],
    });
    assert.equal(p.changedAt, at(3));
  });

  test('vale o update_plan de qualquer plugin', async () => {
    await hook(1, 'mcp__outro__update_plan', { items: [{ content: 'Um', status: 'pending' }] }, 'toolu_p1');
    assert.equal((await store.getPlan(SID))!.total, 1);
  });
});

describe('plano: /clear', () => {
  test('SessionStart de clear esvazia o plano; o próximo começa do zero', async () => {
    await hook(1, 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }] }, 'toolu_t1');
    await ingestHook(store, { ...common, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: at(2) });
    let p = (await store.getPlan(SID))!;
    assert.deepEqual([p.done, p.total, p.currentStepId, p.changedAt], [0, 0, null, at(2)]);
    await hook(3, 'TaskCreate', { subject: 'Novo', description: 'd' }, 'toolu_c1', { so: 'pre' });
    p = (await store.getPlan(SID))!;
    assert.deepEqual(resumo(p)!.passos, [['1', 'Novo', 'pending']]);
  });

  test('prompt /clear do transcript também esvazia', () => {
    const cheio = aplicarAoPlano(null, SID, event({ sessionId: SID, agentId: null, type: 'ToolUse', toolName: 'TodoWrite', createdAt: at(1), data: { toolUseId: 't1', tool_input: { todos: [{ content: 'A', status: 'pending' }] } } }))!;
    const limpo = aplicarAoPlano(cheio, SID, event({ sessionId: SID, agentId: null, type: 'UserPrompt', createdAt: at(2), summary: '<command-name>/clear</command-name> <command-message>clear</command-message>' }))!;
    assert.equal(limpo.total, 0);
    assert.equal(aplicarAoPlano(limpo, SID, event({ sessionId: SID, agentId: null, type: 'UserPrompt', createdAt: at(3), summary: 'oi' })), null);
  });
});

describe('plano pelo transcript (importador e seguidor)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ahrena-plano-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const S = '00000000-0000-4000-8000-0000000000a1';
  const A = 'a9999999999999999';
  let linha = 0;
  const uuid = () => `00000000-0000-4000-9000-${String(++linha).padStart(12, '0')}`;
  const ts = (m: number) => at(m);
  const usar = (m: number, id: string, name: string, input: unknown, agentId?: string) =>
    JSON.stringify({
      type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: ts(m), sessionId: S, cwd: '/repo/app',
      ...(agentId ? { isSidechain: true, agentId } : {}),
      message: { id: `msg_${linha}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
  const resultado = (m: number, id: string, texto: string, toolUseResult?: unknown, agentId?: string) =>
    JSON.stringify({
      type: 'user', uuid: uuid(), parentUuid: null, timestamp: ts(m), sessionId: S,
      ...(agentId ? { isSidechain: true, agentId } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: texto }] },
      ...(toolUseResult ? { toolUseResult } : {}),
    });

  function projeto(nome: string, linhas: string[]): { root: string; arquivo: string; sub: string } {
    const root = join(tmp, nome);
    mkdirSync(join(root, '-repo-app', S, 'subagents'), { recursive: true });
    const arquivo = join(root, '-repo-app', `${S}.jsonl`);
    writeFileSync(arquivo, linhas.map((l) => `${l}\n`).join(''));
    return { root, arquivo, sub: join(root, '-repo-app', S, 'subagents', `agent-${A}.jsonl`) };
  }

  test('TaskCreate, TaskUpdate do subagente do transcript, e o seguidor só acrescenta', async () => {
    const { root, arquivo, sub } = projeto('tarefas', [
      usar(1, 'toolu_c1', 'TaskCreate', { subject: 'Ler', description: 'd', activeForm: 'Lendo' }),
      resultado(1, 'toolu_c1', 'Task #1 created successfully: Ler', { task: { id: '1', subject: 'Ler' } }),
      usar(2, 'toolu_c2', 'TaskCreate', { subject: 'Testar', description: 'd' }),
      // Sem toolUseResult: o id sai do texto.
      resultado(2, 'toolu_c2', 'Task #2 created successfully: Testar'),
      usar(3, 'toolu_u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      resultado(3, 'toolu_u1', 'Updated task #1 status'),
    ]);
    writeFileSync(sub, `${usar(4, 'toolu_u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, A)}\n`);

    await importHistory({ storage: store, root });
    let p = (await store.getPlan(S))!;
    assert.deepEqual(resumo(p), { done: 1, total: 2, atual: 'Testar', passos: [['1', 'Ler', 'completed'], ['2', 'Testar', 'in_progress']] });
    assert.deepEqual(p.steps[1].owner, { kind: 'subagent', agentId: `${S}:${A}`, name: null });
    assert.equal(p.changedAt, ts(4));

    // Rodada sem mudança não regrava; linha nova anda o plano (o seguidor chama o mesmo importador).
    await importHistory({ storage: store, root });
    assert.deepEqual(await store.getPlan(S), p);
    appendFileSync(arquivo, `${usar(5, 'toolu_u3', 'TaskUpdate', { taskId: '2', status: 'completed' })}\n`);
    await importHistory({ storage: store, root });
    p = (await store.getPlan(S))!;
    assert.deepEqual([p.done, p.total, p.currentStepId, p.changedAt], [2, 2, null, ts(5)]);
  });

  test('TodoWrite e update_plan com erro no resultado', async () => {
    const { root } = projeto('todo', [
      usar(1, 'toolu_t1', 'TodoWrite', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Fazendo A' }, { content: 'B', status: 'pending', activeForm: 'Fazendo B' }] }),
      resultado(1, 'toolu_t1', 'Todos have been modified successfully', { oldTodos: [], newTodos: [] }),
      usar(2, 'toolu_p1', 'mcp__ccd_turn__update_plan', { advance: true }),
      resultado(2, 'toolu_p1', 'Plan updated'),
      usar(3, 'toolu_p2', 'mcp__ccd_turn__update_plan', { done: [2] }),
      JSON.stringify({
        type: 'user', uuid: uuid(), timestamp: ts(3), sessionId: S,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p2', content: 'erro', is_error: true }] },
      }),
    ]);
    await importHistory({ storage: store, root });
    const p = (await store.getPlan(S))!;
    assert.equal(p.source, 'update_plan');
    assert.deepEqual(resumo(p), { done: 1, total: 2, atual: 'B', passos: [['1', 'A', 'completed'], ['2', 'B', 'in_progress']] });
  });

  test('a mesma chamada pelo hook e pelo transcript conta uma vez', async () => {
    await ingestHook(
      store,
      { ...common, session_id: S, hook_event_name: 'PreToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'Único', description: 'd' }, tool_use_id: 'toolu_c1' },
      { receivedAt: ts(1) },
    );
    const { root } = projeto('duplo', [
      usar(1, 'toolu_c1', 'TaskCreate', { subject: 'Único', description: 'd' }),
      resultado(1, 'toolu_c1', 'Task #1 created successfully: Único', { task: { id: '1', subject: 'Único' } }),
    ]);
    await importHistory({ storage: store, root });
    assert.deepEqual(resumo(await store.getPlan(S))!.passos, [['1', 'Único', 'pending']]);
  });
});

describe('migração 3: plano da sessão', () => {
  test('banco da versão 2 ganha a tabela session_plans', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2));
    assert.equal(schemaVersion(db), 2);
    assert.deepEqual(migrate(db), [3]);
    const cols = (db.prepare('PRAGMA table_info(session_plans)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['session_id', 'source', 'steps', 'done', 'total', 'current_step_id', 'changed_at', 'metadata']);
    db.close();
  });
});
