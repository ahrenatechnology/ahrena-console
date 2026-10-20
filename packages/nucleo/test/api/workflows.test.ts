// #96 e #97: a montagem dos Workflows (KPIs, runs, grafo de orquestração) e da aba Workflow da sessão
// (grafo dos agentes, laço dev → review → ajustes, linha do tempo), como funções puras.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ajustesDe, lerSessoesDosWorkflows, montarWorkflows, papelDe, tokensDe, workflowDaSessao, type SessaoDosWorkflows } from '../../src/api/workflows.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import type { Agent, SessionEvent } from '../../src/model.ts';
import { T0, agent, at, event, session } from '../fixtures.ts';

const AGORA = Date.parse(at(28));
const MIN = 60_000;

const principal = (sid = 's1', over: Partial<Agent> = {}) => agent({ id: `${sid}:main`, sessionId: sid, type: 'main', name: null, ...over });
function sub(id: string, tipo: string, ini: number, fim: number | null, over: Partial<Agent> = {}, sid = 's1'): Agent {
  return agent({
    id: `${sid}:${id}`, sessionId: sid, type: 'subagent', subagentType: tipo, name: id, parentAgentId: `${sid}:main`,
    status: fim === null ? 'working' : 'completed', startedAt: at(ini), endedAt: fim === null ? null : at(fim), ...over,
  });
}

// A sessão do wireframe C7: Explore e Plan antes, dev r1, review r1 pedindo 3 ajustes, dev r2, review r2 e
// o test-runner rodando, e um Explore no fim.
const LACO = [
  principal(),
  sub('ex1', 'Explore', 0, 2, { name: 'mapear o módulo' }),
  sub('pl', 'Plan', 1, 4, { name: 'plano' }),
  sub('d1', 'general-purpose', 4, 12, { name: 'implementa' }),
  sub('r1', 'code-reviewer', 12, 15, { name: 'revisa o diff', metadata: { ajustes: 3 } }),
  sub('d2', 'general-purpose', 15, 22, { name: 'corrige' }),
  sub('r2', 'code-reviewer', 22, null, { name: 'revisa a v2' }),
  sub('tr', 'test-runner', 25, null, { name: 'bateria' }),
  sub('ex2', 'Explore', 26, null, { name: 'achar usos' }),
];

describe('papel e ajustes de um subagente', () => {
  test('o papel vem dos metadados; sem eles, review pelo tipo, general-purpose é dev, o resto é o tipo', () => {
    assert.equal(papelDe(sub('a', 'code-reviewer', 0, 1)), 'review');
    assert.equal(papelDe(sub('a', 'general-purpose', 0, 1)), 'dev');
    assert.equal(papelDe(sub('a', 'Explore', 0, 1)), 'Explore');
    assert.equal(papelDe(sub('a', 'general-purpose', 0, 1, { metadata: { workflow: { papel: 'review' } } })), 'review');
    assert.equal(papelDe(sub('a', 'x', 0, 1, { subagentType: null })), 'subagente');
  });

  test('os ajustes vêm dos metadados, ou da última mensagem do review; sem nada, null', () => {
    const r = sub('r', 'code-reviewer', 0, 1);
    const msg = (summary: string, n: number): SessionEvent => event({ id: `m${n}`, agentId: r.id, type: 'AssistantMessage', toolName: null, summary, createdAt: at(n) });
    assert.equal(ajustesDe({ ...r, metadata: { workflow: { ajustes: 2 } } }), 2);
    assert.equal(ajustesDe(r, [msg('olhando o diff', 0), msg('Pedi 4 ajustes no serviço', 1)]), 4);
    assert.equal(ajustesDe(r, [msg('Aprovado, pode seguir', 1)]), 0);
    assert.equal(ajustesDe(r, [msg('olhando', 1)]), null);
    assert.equal(ajustesDe(r, []), null);
  });

  test('a negação não aprova; com dois números, vale o último antes de "ajustes"; os metadados mandam', () => {
    const r = sub('r', 'code-reviewer', 0, 1);
    const msg = (summary: string): SessionEvent[] => [event({ id: 'm', agentId: r.id, type: 'AssistantMessage', toolName: null, summary, createdAt: at(1) })];
    assert.equal(ajustesDe(r, msg('Não aprovado: faltam testes')), null);
    assert.equal(ajustesDe(r, msg('nao aprovado ainda')), null);
    assert.equal(ajustesDe(r, msg('Not approved: missing tests')), null);
    assert.equal(ajustesDe(r, msg('Revisei 12 changes e peço 2 ajustes')), 2);
    assert.equal(ajustesDe(r, msg('3 pequenos ajustes e depois mais 1 ajuste')), 1);
    assert.equal(ajustesDe(r, msg('Found 4 issues')), 4);
    assert.equal(ajustesDe(r, msg('Sem ajustes, aprovado')), 0);
    assert.equal(ajustesDe({ ...r, metadata: { workflow: { ajustes: 5 } } }, msg('Aprovado')), 5);
    assert.equal(ajustesDe({ ...r, metadata: { ajustes: 0 } }, msg('Revisei 12 changes e peço 2 ajustes')), 0);
  });
});

describe('#97 workflowDaSessao: o grafo dos agentes da sessão', () => {
  const s = session({ startedAt: T0, status: 'active', model: 'claude-opus-5-5' });

  test('#97/AC-1 cada agente é um nó com nome, tarefa, tempo e estado; o principal leva o modelo', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.deepEqual(
      w.nodes.map((n) => [n.name, n.round, n.task, n.state]),
      [
        ['Principal', null, null, 'active'],
        ['Explore', null, 'mapear o módulo', 'completed'],
        ['Plan', null, 'plano', 'completed'],
        ['dev', 1, 'implementa', 'completed'],
        ['review', 1, 'revisa o diff', 'completed'],
        ['dev', 2, 'corrige', 'completed'],
        ['review', 2, 'revisa a v2', 'active'],
        ['test-runner', null, 'bateria', 'active'],
        ['Explore', null, 'achar usos', 'active'],
      ],
    );
    assert.equal(w.nodes[0].model, 'claude-opus-5-5');
    assert.equal(w.nodes[1].model, null);
    assert.equal(w.nodes[0].durationMs, 28 * MIN);
    assert.equal(w.nodes[3].durationMs, 8 * MIN);
    assert.equal(w.nodes[6].durationMs, 6 * MIN, 'o que roda conta até agora');
    assert.equal(w.durationMs, 28 * MIN);
  });

  test('#97/AC-1 #97/AC-2 as arestas: quem abriu, quem entregou e a volta do review para o dev', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.deepEqual(
      w.edges.map((e) => [e.from.slice(3), e.to.slice(3), e.type, e.label]),
      [
        ['main', 'ex1', 'opened', null],
        ['main', 'pl', 'opened', null],
        ['pl', 'd1', 'delivered', 'plano'],
        ['d1', 'r1', 'delivered', 'diff'],
        ['r1', 'd2', 'changes-requested', 'ajustes'],
        ['d2', 'r2', 'delivered', 'v2'],
        ['d2', 'tr', 'delivered', null],
        ['main', 'ex2', 'opened', null],
      ],
    );
  });

  test('#97/AC-2 #97/AC-4 o review mostra a rodada e os ajustes; a sessão, as rodadas e o total de ajustes', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA, pr: 90 });
    const r1 = w.nodes.find((n) => n.id === 's1:r1')!;
    assert.deepEqual([r1.round, r1.changesRequested], [1, 3]);
    assert.equal(w.nodes.find((n) => n.id === 's1:r2')!.changesRequested, null, 'o review que ainda roda não disse');
    assert.equal(w.nodes.find((n) => n.id === 's1:d1')!.changesRequested, null, 'só review pede ajustes');
    assert.deepEqual([w.reviewRounds, w.changesRequested], [2, 3]);
    assert.equal(w.summary, 'dev → review até aprovar · termina no PR #90');
  });

  test('#97/AC-2 um review que aprova (0 ajustes) não volta para o dev: o dev seguinte foi aberto pela sessão', () => {
    const agentes = [principal(), sub('d1', 'general-purpose', 0, 5), sub('r1', 'code-reviewer', 5, 7, { metadata: { ajustes: 0 } }), sub('d2', 'general-purpose', 8, 9)];
    const w = workflowDaSessao(s, agentes, [], { agora: AGORA });
    assert.deepEqual(w.edges.find((e) => e.to === 's1:d2'), { from: 's1:main', to: 's1:d2', type: 'opened', label: null });
    assert.equal(w.summary, 'dev → review', 'aprovado na primeira rodada: sem laço');
    assert.equal(w.changesRequested, 0);
  });

  test('#97/AC-1 o subagente aninhado sai do subagente que o disparou', () => {
    const agentes = [principal(), sub('gp', 'Explore', 0, 10), sub('ex', 'Explore', 1, 2, { parentAgentId: 's1:gp' })];
    const w = workflowDaSessao(s, agentes, [], { agora: AGORA });
    assert.deepEqual(w.edges.map((e) => [e.from, e.to]), [['s1:main', 's1:gp'], ['s1:gp', 's1:ex']]);
  });

  test('#97/AC-3 a linha do tempo tem uma faixa por agente, na escala da sessão; o mesmo rótulo junta os trechos', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.equal(w.timeline.start, T0);
    assert.equal(w.timeline.end, at(28), 'a sessão viva vai até agora');
    assert.deepEqual(w.timeline.lanes.map((f) => f.label), ['Agente principal', 'Explore', 'Plan', 'dev · r1', 'review · r1', 'dev · r2', 'review · r2', 'test-runner']);
    const explore = w.timeline.lanes[1];
    assert.deepEqual(explore.spans.map((t) => [t.start, t.end, t.state]), [[at(0), at(2), 'completed'], [at(26), null, 'active']]);
    assert.equal(explore.nodeId, 's1:ex1');
  });

  test('sem subagentes, só o principal; sem review, resumo nulo; a sessão que acabou tem fim', () => {
    const fim = session({ status: 'completed', endedAt: at(10) });
    const w = workflowDaSessao(fim, [principal()], [], { agora: AGORA });
    assert.deepEqual(w.nodes.map((n) => [n.name, n.state, n.end]), [['Principal', 'completed', at(10)]]);
    assert.deepEqual([w.edges, w.summary, w.reviewRounds, w.changesRequested], [[], null, 0, 0]);
    assert.equal(w.timeline.end, at(10));
    assert.equal(w.durationMs, 10 * MIN);
  });

  test('sem o agente principal gravado, o nó sai da sessão; a sessão com erro dá o principal com erro', () => {
    const w = workflowDaSessao(session({ status: 'error', endedAt: at(3) }), [sub('a', 'Explore', 0, 1, { status: 'error' })], [], { agora: AGORA });
    assert.deepEqual(w.nodes.map((n) => [n.id, n.state]), [['s1:main', 'error'], ['s1:a', 'error']]);
    assert.equal(w.edges[0].from, 's1:main');
  });
});

// ---------- #96 ----------

const usoDe = (agentId: string, sid: string, n: number, input: number, output: number): SessionEvent =>
  event({ id: `${sid}-u${n}`, sessionId: sid, agentId, type: 'AssistantMessage', toolName: null, summary: null, createdAt: at(n), data: { usage: { tokens: { input, output, cacheRead: 99_999, cacheWrite5m: 10, cacheWrite1h: 0 } } } });
const ferramenta = (agentId: string, sid: string, n: number, type = 'PreToolUse'): SessionEvent =>
  event({ id: `${sid}-f${n}-${type}`, sessionId: sid, agentId, type, toolName: 'Read', createdAt: at(n) });
const wf = (run: string, fase: string, extra: Record<string, unknown> = {}) => ({ metadata: { workflow: { run, fase, ...extra } } });

function comRun(): SessaoDosWorkflows {
  const sid = 'w1';
  const agentes = [
    principal(sid),
    sub('d1', 'general-purpose', 1, 9, wf('toolu_1', 'Implementar'), sid),
    sub('r1', 'code-reviewer', 9, 12, wf('toolu_1', 'Revisar', { ajustes: 3 }), sid),
    sub('d2', 'general-purpose', 12, 19, wf('toolu_1', 'Corrigir'), sid),
    sub('r2', 'code-reviewer', 19, null, wf('toolu_1', 'Revisar'), sid),
    sub('t', 'test-runner', 25, null, wf('toolu_1', 'Testar', { rotulo: 'test' }), sid),
    sub('ex', 'Explore', 0, 1, {}, sid),
  ];
  const eventos: SessionEvent[] = [
    event({ id: 'w1-wf', sessionId: sid, agentId: `${sid}:main`, type: 'PreToolUse', toolName: 'Workflow', createdAt: at(1), data: { tool_use_id: 'toolu_1', tool_input: { name: 'dev-review', fases: ['Implementar', 'Revisar', 'Corrigir', 'Testar'], model: 'claude-opus-5-5' } } }),
    usoDe(`${sid}:d1`, sid, 2, 1000, 500),
    usoDe(`${sid}:d1`, sid, 3, 2000, 500),
    ferramenta(`${sid}:d1`, sid, 2),
    ferramenta(`${sid}:d1`, sid, 3),
    ferramenta(`${sid}:d1`, sid, 3, 'ToolUse'),
    ferramenta(`${sid}:r1`, sid, 10),
  ];
  return { session: session({ id: sid, cwd: '/simulacao/motor-de-regras', status: 'active', model: 'claude-opus-5-5' }), agentes, compactou: false, eventos };
}

function concluida(id: string, over: Partial<SessaoDosWorkflows> & { status?: 'completed' | 'error' | 'abandoned'; source?: string } = {}): SessaoDosWorkflows {
  const { status = 'completed', source = 'startup', ...resto } = over;
  return {
    session: session({ id, status, source, startedAt: at(0), endedAt: at(10), cwd: `/simulacao/${id}` }),
    agentes: [principal(id)],
    compactou: false,
    ...resto,
  };
}

describe('#96 montarWorkflows: KPIs de orquestração', () => {
  test('#96/AC-1 profundidade, subagentes por sessão, sucesso, fluxo comum, rodadas e duração média', () => {
    const sessoes = [
      comRun(),
      concluida('a', { agentes: [principal('a'), sub('d', 'general-purpose', 1, 3, {}, 'a'), sub('r', 'code-reviewer', 3, 5, { status: 'error' }, 'a'), sub('n', 'Explore', 4, 5, { parentAgentId: 'a:r' }, 'a')] }),
      concluida('b'),
    ];
    const { kpis } = montarWorkflows(sessoes, { agora: AGORA });
    // w1: 2 níveis; a: 3 (o Explore aninhado no review); b: 1.
    assert.equal(kpis.averageDepth, 2);
    assert.equal(kpis.subagentsPerSession, (6 + 3 + 0) / 3);
    // Terminados: w1 tem 4 concluídos (ex, d1, r1, d2); a tem 2 concluídos e 1 erro.
    assert.equal(kpis.subagentSuccess, 6 / 7);
    assert.deepEqual(kpis.commonFlow, { label: 'dev → review', fraction: 2 / 3 });
    assert.equal(kpis.roundsPerPr, (2 + 1) / 2);
    // w1 roda há 28 min (desde T0); a e b duraram 10.
    assert.equal(kpis.averageDurationMs, ((28 + 10 + 10) / 3) * MIN);
  });

  test('#96/AC-1 sem sessões, os KPIs são nulos, não zero', () => {
    const r = montarWorkflows([], { agora: AGORA });
    assert.deepEqual(r.kpis, { averageDepth: null, subagentsPerSession: null, subagentSuccess: null, commonFlow: null, roundsPerPr: null, averageDurationMs: null });
    assert.deepEqual([r.runs, r.graph.nodes, r.graph.edges, r.sessions], [[], [], [], 0]);
    assert.equal(r.truncated, false);
    assert.equal(montarWorkflows([], { agora: AGORA, truncado: true }).truncated, true);
    assert.equal(r.graph.columns.length, 5);
  });
});

describe('#96 montarWorkflows: os runs do Workflow tool', () => {
  test('#96/AC-2 o run traz nome, estado, modelo, projeto, as fases e a tabela agente, fase, estado, tokens, ferramentas e duração', () => {
    const [run] = montarWorkflows([comRun()], { agora: AGORA }).runs;
    assert.equal(run.id, 'toolu_1');
    assert.deepEqual([run.name, run.state, run.model, run.project, run.sessionId, run.start, run.end], ['dev-review', 'active', 'claude-opus-5-5', 'motor-de-regras', 'w1', at(1), null]);
    assert.deepEqual(run.phases.map((f) => f.name), ['Implementar', 'Revisar', 'Corrigir', 'Testar']);
    assert.equal(run.loop, 'volta para Corrigir enquanto o review pedir ajustes');
    assert.deepEqual(
      run.agents.map((a) => [a.label, a.type, a.phase, a.state, a.changesRequested]),
      [
        ['dev:r1', 'general-purpose', 'Implementar', 'completed', null],
        ['review:r1', 'code-reviewer', 'Revisar', 'changes-requested', 3],
        ['dev:r2', 'general-purpose', 'Corrigir', 'completed', null],
        ['review:r2', 'code-reviewer', 'Revisar', 'running', null],
        ['test', 'test-runner', 'Testar', 'running', null],
      ],
    );
    const d1 = run.agents[0];
    // input + output + escrita de cache das duas mensagens; a leitura de cache não entra.
    assert.equal(d1.tokens, 1000 + 500 + 10 + 2000 + 500 + 10);
    assert.equal(d1.tools, 2, 'hook e transcript contam a mesma chamada: vale o maior');
    assert.equal(d1.durationMs, 8 * MIN);
    assert.deepEqual([run.tokens, run.tools, run.durationMs], [4020, 3, 27 * MIN]);
  });

  test('#96/AC-2 o fim da chamada fecha o run; a falha dá erro; sem a chamada, nome e fases dos metadados', () => {
    const base = comRun();
    const fim = event({ id: 'w1-fim', sessionId: 'w1', agentId: 'w1:main', type: 'PostToolUse', toolName: 'Workflow', createdAt: at(27), data: { tool_use_id: 'toolu_1' } });
    const fechado = montarWorkflows([{ ...base, eventos: [...base.eventos!, fim] }], { agora: AGORA }).runs[0];
    assert.deepEqual([fechado.state, fechado.end, fechado.durationMs], ['completed', at(27), 26 * MIN]);
    const falhou = montarWorkflows([{ ...base, eventos: [...base.eventos!, { ...fim, type: 'PostToolUseFailure' }] }], { agora: AGORA }).runs[0];
    assert.equal(falhou.state, 'error');

    const sid = 'w2';
    const semChamada: SessaoDosWorkflows = {
      ...concluida(sid),
      agentes: [principal(sid), sub('a', 'Explore', 1, 3, wf('toolu_9', 'Coletar', { nome: 'triagem-de-bugs' }), sid), sub('b', 'general-purpose', 3, 6, wf('toolu_9', 'Classificar'), sid)],
    };
    const run = montarWorkflows([semChamada], { agora: AGORA }).runs[0];
    assert.deepEqual([run.name, run.state, run.end, run.model, run.loop], ['triagem-de-bugs', 'completed', at(6), 'claude-opus-5-5', null]);
    assert.deepEqual(run.phases.map((f) => f.name), ['Coletar', 'Classificar']);
    assert.deepEqual(run.agents.map((a) => [a.tokens, a.tools]), [[0, 0], [0, 0]], 'sem eventos, zero, não inventado');
  });

  test('#96/AC-2 sessão sem subagente marcado não tem run; os ativos vêm primeiro', () => {
    const r = montarWorkflows([concluida('x', { agentes: [principal('x'), sub('a', 'Explore', 1, 2, wf('t2', 'F'), 'x')] }), comRun(), concluida('y')], { agora: AGORA });
    assert.deepEqual(r.runs.map((x) => [x.sessionId, x.state]), [['w1', 'active'], ['x', 'completed']]);
  });
});

describe('#96 montarWorkflows: o grafo de orquestração', () => {
  const sessoes = () => [
    comRun(),
    concluida('a', { source: 'resume', compactou: true, agentes: [principal('a'), sub('e1', 'Explore', 1, 2, {}, 'a'), sub('e2', 'Explore', 2, 3, {}, 'a')] }),
    concluida('b', { status: 'error' }),
  ];

  test('#96/AC-3 colunas origem, principal, tipos de subagente, compactação e resultado, com o volume de cada nó e aresta', () => {
    const { graph } = montarWorkflows(sessoes(), { agora: AGORA });
    assert.deepEqual(graph.columns.map((c) => c.id), ['origin', 'main', 'subagent', 'compaction', 'outcome']);
    assert.deepEqual(
      graph.nodes.map((n) => [n.id, n.label, n.volume]),
      [
        ['origin:prompt', 'Prompt novo', 2],
        ['origin:resume', 'Retomada', 1],
        ['main', 'Agente principal', 3],
        ['subagent:Explore', 'Explore', 3],
        ['subagent:code-reviewer', 'code-reviewer', 2],
        ['subagent:general-purpose', 'general-purpose', 2],
        ['subagent:test-runner', 'test-runner', 1],
        ['compaction:none', 'Sem compactação', 2],
        ['compaction:compacted', 'Compactou', 1],
        ['outcome:completed', 'Concluída', 1],
        ['outcome:error', 'Com erro', 1],
        ['outcome:active', 'Em andamento', 1],
      ],
    );
    const aresta = (de: string, para: string) => graph.edges.find((e) => e.from === de && e.to === para)?.volume ?? 0;
    assert.equal(aresta('origin:prompt', 'main'), 2);
    assert.equal(aresta('main', 'subagent:Explore'), 3, 'principal → tipo conta subagentes');
    assert.equal(aresta('subagent:Explore', 'compaction:compacted'), 1, 'tipo → compactação conta sessões');
    assert.equal(aresta('subagent:Explore', 'compaction:none'), 1);
    assert.equal(aresta('main', 'compaction:none'), 1, 'a sessão sem subagente vai direto');
    assert.equal(aresta('compaction:none', 'outcome:error'), 1);
    assert.equal(aresta('compaction:compacted', 'outcome:completed'), 1);
  });

  test('#96/AC-3 clicar num nó filtra a tela: KPIs, runs e o grafo só das sessões que passam por ele', () => {
    const r = montarWorkflows(sessoes(), { agora: AGORA, no: 'subagent:Explore' });
    assert.equal(r.node, 'subagent:Explore');
    assert.equal(r.sessions, 2);
    assert.equal(r.graph.nodes.find((n) => n.id === 'main')!.volume, 2);
    assert.equal(r.runs.length, 1);
    const retomada = montarWorkflows(sessoes(), { agora: AGORA, no: 'origin:resume' });
    assert.deepEqual([retomada.sessions, retomada.runs.length, retomada.kpis.subagentsPerSession], [1, 0, 2]);
    assert.equal(montarWorkflows(sessoes(), { agora: AGORA, no: 'main' }).sessions, 3);
  });

  test('#96/AC-4 o filtro Todas, Só ativas e Concluídas vale para a tela inteira', () => {
    const ativas = montarWorkflows(sessoes(), { agora: AGORA, filtro: 'active' });
    assert.deepEqual([ativas.filter, ativas.sessions, ativas.runs.length], ['active', 1, 1]);
    assert.deepEqual(ativas.graph.nodes.filter((n) => n.column === 'outcome').map((n) => n.id), ['outcome:active']);
    const concl = montarWorkflows(sessoes(), { agora: AGORA, filtro: 'completed' });
    assert.deepEqual([concl.sessions, concl.runs.length, concl.kpis.averageDurationMs], [2, 0, 10 * MIN]);
    assert.equal(montarWorkflows(sessoes(), { agora: AGORA }).sessions, 3);
  });
});

// ---------- Rodada 2 (achados do Argos) ----------

describe('ajustes lidos da mensagem do review (M1)', () => {
  const r = sub('r', 'code-reviewer', 0, 1);
  const com = (summary: string) => ajustesDe(r, [event({ id: 'm', agentId: r.id, type: 'AssistantMessage', toolName: null, summary })]);
  test('o número logo antes de "ajustes", com até duas palavras no meio', () => {
    assert.equal(com('Pedi 3 pequenos ajustes'), 3);
    assert.equal(com('Rodada 2: pedi 4 ajustes no serviço'), 4);
    assert.equal(com('5 changes requested'), 5);
    assert.equal(com('Rodada 2: pequenos ajustes'), null, 'o número da rodada não é a contagem');
  });
  test('aprovado negado não é zero; "sem ajustes" é zero; os metadados continuam valendo primeiro', () => {
    assert.equal(com('Não aprovado: falta teste'), null);
    assert.equal(com('Reprovado'), null);
    assert.equal(com('not approved yet'), null);
    assert.equal(com('Aprovado, sem ajustes'), 0);
    assert.equal(com('Nenhum ajuste'), 0);
    assert.equal(com('LGTM'), 0);
    assert.equal(ajustesDe({ ...r, metadata: { workflow: { ajustes: 2 } } }, [event({ id: 'm', agentId: r.id, type: 'AssistantMessage', toolName: null, summary: 'Aprovado' })]), 2);
  });
});

describe('a volta review → dev só quando o review terminou (I3)', () => {
  const s = session({ status: 'active' });
  test('#97/AC-2 review ainda rodando: o dev seguinte foi aberto, não é volta', () => {
    const agentes = [principal(), sub('d1', 'general-purpose', 0, 5), sub('r1', 'code-reviewer', 5, null), sub('d2', 'general-purpose', 7, null)];
    const w = workflowDaSessao(s, agentes, [], { agora: AGORA });
    assert.deepEqual(w.edges.find((e) => e.to === 's1:d2'), { from: 's1:main', to: 's1:d2', type: 'opened', label: null });
  });
  test('#97/AC-2 review que terminou depois de o dev começar também não é volta; antes, com ajustes desconhecidos, é', () => {
    const depois = [principal(), sub('d1', 'general-purpose', 0, 5), sub('r1', 'code-reviewer', 5, 9), sub('d2', 'general-purpose', 7, null)];
    assert.equal(workflowDaSessao(s, depois, [], { agora: AGORA }).edges.find((e) => e.to === 's1:d2')!.type, 'opened');
    const antes = [principal(), sub('d1', 'general-purpose', 0, 5), sub('r1', 'code-reviewer', 5, 7), sub('d2', 'general-purpose', 7, null)];
    assert.equal(workflowDaSessao(s, antes, [], { agora: AGORA }).edges.find((e) => e.to === 's1:d2')!.type, 'changes-requested');
  });
});

describe('tokens de um agente sem contar duas vezes (I2)', () => {
  const linha = (n: number, messageId: string | null, output: number) =>
    event({ id: `u${n}`, agentId: 's1:a', type: 'AssistantMessage', toolName: null, summary: null, createdAt: at(n), data: { usage: { messageId, requestId: null, tokens: { input: 100, output, cacheRead: 5_000, cacheWrite5m: 20, cacheWrite1h: 0 } } } });
  const a = sub('a', 'general-purpose', 0, 5);
  test('as linhas de streaming da mesma mensagem contam uma vez, a de mais saída', () => {
    assert.equal(tokensDe(a, [linha(1, 'msg_1', 10), linha(2, 'msg_1', 50), linha(3, 'msg_1', 100), linha(4, 'msg_2', 7)]), 100 + 100 + 20 + (100 + 7 + 20));
  });
  test('os tokens gravados pelo importer (metadata.tokens) valem antes dos eventos', () => {
    const gravado = { ...a, metadata: { tokens: { input: 1_000, output: 200, cacheRead: 90_000, cacheWrite5m: 30, cacheWrite1h: 5 } } };
    assert.equal(tokensDe(gravado, [linha(1, 'msg_1', 999)]), 1_235);
  });
});

describe('runs com o formato que o importer grava (B1)', () => {
  // O importer: o subagente leva `metadata.toolUseId` (a chamada que o abriu) e `metadata.tokens`; a
  // chamada é um `ToolUse` com `data.toolUseId`, sem o `tool_input` da Workflow; o fim, um `ToolResult`.
  const sid = 'imp';
  const tokens = (input: number, output: number) => ({ input, output, cacheRead: 50_000, cacheWrite5m: 0, cacheWrite1h: 0 });
  const toolUse = (id: string, nome: string, n: number): SessionEvent =>
    event({ id: `${sid}-tu-${id}`, sessionId: sid, agentId: `${sid}:main`, type: 'ToolUse', toolName: nome, summary: null, createdAt: at(n), data: { parentUuid: null, transcriptAgentId: null, toolUseId: id } });
  const resultado = (id: string, n: number, isError = false): SessionEvent =>
    event({ id: `${sid}-tr-${id}`, sessionId: sid, agentId: `${sid}:main`, type: 'ToolResult', toolName: 'Workflow', summary: null, createdAt: at(n), data: { parentUuid: null, transcriptAgentId: null, toolUseId: id, isError } });
  const base = (eventos: SessionEvent[]): SessaoDosWorkflows => ({
    session: session({ id: sid, status: 'completed', endedAt: at(20), model: 'claude-opus-5-5', cwd: '/simulacao/gateway-sandbox' }),
    agentes: [
      principal(sid),
      sub('a', 'general-purpose', 2, 6, { metadata: { toolUseId: 'toolu_wf', tokens: tokens(1_000, 100) } }, sid),
      sub('b', 'code-reviewer', 6, 8, { metadata: { toolUseId: 'toolu_wf', tokens: tokens(500, 50) } }, sid),
      sub('c', 'Explore', 9, 10, { metadata: { toolUseId: 'toolu_agent', tokens: tokens(10, 1) } }, sid),
    ],
    compactou: false,
    eventos,
  });

  test('#96/AC-2 o subagente aberto por uma chamada Workflow entra no run; o aberto pela Agent, não', () => {
    const r = montarWorkflows([base([toolUse('toolu_wf', 'Workflow', 1), toolUse('toolu_agent', 'Agent', 9), resultado('toolu_wf', 12)])], { agora: AGORA });
    assert.equal(r.runs.length, 1);
    const run = r.runs[0];
    assert.deepEqual([run.id, run.name, run.state, run.start, run.end, run.model, run.project], ['toolu_wf', 'workflow', 'completed', at(1), at(12), 'claude-opus-5-5', 'gateway-sandbox']);
    assert.deepEqual(run.phases, [], 'sem tool_input nem fase nos agentes: nenhuma fase, não inventada');
    assert.deepEqual(run.agents.map((a) => [a.id, a.label, a.tokens]), [['imp:a', 'dev:r1', 1_100], ['imp:b', 'review:r1', 550]]);
    assert.equal(run.tokens, 1_650);
  });

  test('#96/AC-2 o ToolResult com erro fecha o run com erro; sem a chamada Workflow, não há run', () => {
    const erro = montarWorkflows([base([toolUse('toolu_wf', 'Workflow', 1), resultado('toolu_wf', 12, true)])], { agora: AGORA });
    assert.equal(erro.runs[0].state, 'error');
    assert.deepEqual(montarWorkflows([base([toolUse('toolu_wf', 'Agent', 1)])], { agora: AGORA }).runs, []);
  });

  test('#96/AC-2 com o tool_input gravado, nome e fases vêm dele', () => {
    const chamada = toolUse('toolu_wf', 'Workflow', 1);
    chamada.data = { ...(chamada.data as object), tool_input: { name: 'dev-review', phases: [{ name: 'Implementar' }, { name: 'Revisar' }] } };
    const run = montarWorkflows([base([chamada])], { agora: AGORA }).runs[0];
    assert.deepEqual([run.name, run.phases.map((f) => f.name)], ['dev-review', ['Implementar', 'Revisar']]);
  });
});

describe('o teto de sessões (M5)', () => {
  test('#96 truncado diz que o teto cortou a leitura', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    for (let i = 0; i < 3; i++) await storage.putSession(session({ id: `t${i}`, updatedAt: at(i) }));
    const cortada = await lerSessoesDosWorkflows(storage, 'all', 2);
    assert.deepEqual([cortada.sessoes.length, cortada.truncado], [2, true]);
    const inteira = await lerSessoesDosWorkflows(storage, 'all', 3);
    assert.deepEqual([inteira.sessoes.length, inteira.truncado], [3, false]);
    assert.equal(montarWorkflows(cortada.sessoes, { agora: AGORA, truncado: cortada.truncado }).truncated, true);
    assert.equal(montarWorkflows(inteira.sessoes, { agora: AGORA }).truncated, false);
    await storage.close();
  });
});
