// #96 e #97: a montagem dos Workflows (KPIs, runs, grafo de orquestração) e da aba Workflow da sessão
// (grafo dos agentes, laço dev → review → ajustes, linha do tempo), como funções puras.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ajustesDe, montarWorkflows, papelDe, workflowDaSessao, type SessaoDosWorkflows } from '../../src/api/workflows.ts';
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
});

describe('#97 workflowDaSessao: o grafo dos agentes da sessão', () => {
  const s = session({ startedAt: T0, status: 'active', model: 'claude-opus-5-5' });

  test('#97/AC-1 cada agente é um nó com nome, tarefa, tempo e estado; o principal leva o modelo', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.deepEqual(
      w.nos.map((n) => [n.nome, n.rodada, n.tarefa, n.estado]),
      [
        ['Principal', null, null, 'ativo'],
        ['Explore', null, 'mapear o módulo', 'concluido'],
        ['Plan', null, 'plano', 'concluido'],
        ['dev', 1, 'implementa', 'concluido'],
        ['review', 1, 'revisa o diff', 'concluido'],
        ['dev', 2, 'corrige', 'concluido'],
        ['review', 2, 'revisa a v2', 'ativo'],
        ['test-runner', null, 'bateria', 'ativo'],
        ['Explore', null, 'achar usos', 'ativo'],
      ],
    );
    assert.equal(w.nos[0].modelo, 'claude-opus-5-5');
    assert.equal(w.nos[1].modelo, null);
    assert.equal(w.nos[0].duracaoMs, 28 * MIN);
    assert.equal(w.nos[3].duracaoMs, 8 * MIN);
    assert.equal(w.nos[6].duracaoMs, 6 * MIN, 'o que roda conta até agora');
    assert.equal(w.duracaoMs, 28 * MIN);
  });

  test('#97/AC-1 #97/AC-2 as arestas: quem abriu, quem entregou e a volta do review para o dev', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.deepEqual(
      w.arestas.map((e) => [e.de.slice(3), e.para.slice(3), e.tipo, e.rotulo]),
      [
        ['main', 'ex1', 'abriu', null],
        ['main', 'pl', 'abriu', null],
        ['pl', 'd1', 'entregou', 'plano'],
        ['d1', 'r1', 'entregou', 'diff'],
        ['r1', 'd2', 'ajustes', 'ajustes'],
        ['d2', 'r2', 'entregou', 'v2'],
        ['d2', 'tr', 'entregou', null],
        ['main', 'ex2', 'abriu', null],
      ],
    );
  });

  test('#97/AC-2 #97/AC-4 o review mostra a rodada e os ajustes; a sessão, as rodadas e o total de ajustes', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA, pr: 90 });
    const r1 = w.nos.find((n) => n.id === 's1:r1')!;
    assert.deepEqual([r1.rodada, r1.ajustes], [1, 3]);
    assert.equal(w.nos.find((n) => n.id === 's1:r2')!.ajustes, null, 'o review que ainda roda não disse');
    assert.equal(w.nos.find((n) => n.id === 's1:d1')!.ajustes, null, 'só review pede ajustes');
    assert.deepEqual([w.rodadasDeReview, w.ajustes], [2, 3]);
    assert.equal(w.resumo, 'dev → review até aprovar · termina no PR #90');
  });

  test('#97/AC-2 um review que aprova (0 ajustes) não volta para o dev: o dev seguinte foi aberto pela sessão', () => {
    const agentes = [principal(), sub('d1', 'general-purpose', 0, 5), sub('r1', 'code-reviewer', 5, 7, { metadata: { ajustes: 0 } }), sub('d2', 'general-purpose', 8, 9)];
    const w = workflowDaSessao(s, agentes, [], { agora: AGORA });
    assert.deepEqual(w.arestas.find((e) => e.para === 's1:d2'), { de: 's1:main', para: 's1:d2', tipo: 'abriu', rotulo: null });
    assert.equal(w.resumo, 'dev → review', 'aprovado na primeira rodada: sem laço');
    assert.equal(w.ajustes, 0);
  });

  test('#97/AC-1 o subagente aninhado sai do subagente que o disparou', () => {
    const agentes = [principal(), sub('gp', 'Explore', 0, 10), sub('ex', 'Explore', 1, 2, { parentAgentId: 's1:gp' })];
    const w = workflowDaSessao(s, agentes, [], { agora: AGORA });
    assert.deepEqual(w.arestas.map((e) => [e.de, e.para]), [['s1:main', 's1:gp'], ['s1:gp', 's1:ex']]);
  });

  test('#97/AC-3 a linha do tempo tem uma faixa por agente, na escala da sessão; o mesmo rótulo junta os trechos', () => {
    const w = workflowDaSessao(s, LACO, [], { agora: AGORA });
    assert.equal(w.linhaDoTempo.inicio, T0);
    assert.equal(w.linhaDoTempo.fim, at(28), 'a sessão viva vai até agora');
    assert.deepEqual(w.linhaDoTempo.faixas.map((f) => f.rotulo), ['Agente principal', 'Explore', 'Plan', 'dev · r1', 'review · r1', 'dev · r2', 'review · r2', 'test-runner']);
    const explore = w.linhaDoTempo.faixas[1];
    assert.deepEqual(explore.trechos.map((t) => [t.inicio, t.fim, t.estado]), [[at(0), at(2), 'concluido'], [at(26), null, 'ativo']]);
    assert.equal(explore.noId, 's1:ex1');
  });

  test('sem subagentes, só o principal; sem review, resumo nulo; a sessão que acabou tem fim', () => {
    const fim = session({ status: 'completed', endedAt: at(10) });
    const w = workflowDaSessao(fim, [principal()], [], { agora: AGORA });
    assert.deepEqual(w.nos.map((n) => [n.nome, n.estado, n.fim]), [['Principal', 'concluido', at(10)]]);
    assert.deepEqual([w.arestas, w.resumo, w.rodadasDeReview, w.ajustes], [[], null, 0, 0]);
    assert.equal(w.linhaDoTempo.fim, at(10));
    assert.equal(w.duracaoMs, 10 * MIN);
  });

  test('sem o agente principal gravado, o nó sai da sessão; a sessão com erro dá o principal com erro', () => {
    const w = workflowDaSessao(session({ status: 'error', endedAt: at(3) }), [sub('a', 'Explore', 0, 1, { status: 'error' })], [], { agora: AGORA });
    assert.deepEqual(w.nos.map((n) => [n.id, n.estado]), [['s1:main', 'erro'], ['s1:a', 'erro']]);
    assert.equal(w.arestas[0].de, 's1:main');
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
    assert.equal(kpis.profundidadeMedia, 2);
    assert.equal(kpis.subagentesPorSessao, (6 + 3 + 0) / 3);
    // Terminados: w1 tem 4 concluídos (ex, d1, r1, d2); a tem 2 concluídos e 1 erro.
    assert.equal(kpis.sucessoSubagentes, 6 / 7);
    assert.deepEqual(kpis.fluxoComum, { rotulo: 'dev → review', fracao: 2 / 3 });
    assert.equal(kpis.rodadasPorPr, (2 + 1) / 2);
    // w1 roda há 28 min (desde T0); a e b duraram 10.
    assert.equal(kpis.duracaoMediaMs, ((28 + 10 + 10) / 3) * MIN);
  });

  test('#96/AC-1 sem sessões, os KPIs são nulos, não zero', () => {
    const r = montarWorkflows([], { agora: AGORA });
    assert.deepEqual(r.kpis, { profundidadeMedia: null, subagentesPorSessao: null, sucessoSubagentes: null, fluxoComum: null, rodadasPorPr: null, duracaoMediaMs: null });
    assert.deepEqual([r.runs, r.grafo.nos, r.grafo.arestas, r.sessoes], [[], [], [], 0]);
    assert.equal(r.grafo.colunas.length, 5);
  });
});

describe('#96 montarWorkflows: os runs do Workflow tool', () => {
  test('#96/AC-2 o run traz nome, estado, modelo, projeto, as fases e a tabela agente, fase, estado, tokens, ferramentas e duração', () => {
    const [run] = montarWorkflows([comRun()], { agora: AGORA }).runs;
    assert.equal(run.id, 'toolu_1');
    assert.deepEqual([run.nome, run.estado, run.modelo, run.projeto, run.sessaoId, run.inicio, run.fim], ['dev-review', 'ativa', 'claude-opus-5-5', 'motor-de-regras', 'w1', at(1), null]);
    assert.deepEqual(run.fases.map((f) => f.nome), ['Implementar', 'Revisar', 'Corrigir', 'Testar']);
    assert.equal(run.volta, 'volta para Corrigir enquanto o review pedir ajustes');
    assert.deepEqual(
      run.agentes.map((a) => [a.rotulo, a.tipo, a.fase, a.estado, a.ajustes]),
      [
        ['dev:r1', 'general-purpose', 'Implementar', 'concluido', null],
        ['review:r1', 'code-reviewer', 'Revisar', 'ajustes', 3],
        ['dev:r2', 'general-purpose', 'Corrigir', 'concluido', null],
        ['review:r2', 'code-reviewer', 'Revisar', 'rodando', null],
        ['test', 'test-runner', 'Testar', 'rodando', null],
      ],
    );
    const d1 = run.agentes[0];
    // input + output + escrita de cache das duas mensagens; a leitura de cache não entra.
    assert.equal(d1.tokens, 1000 + 500 + 10 + 2000 + 500 + 10);
    assert.equal(d1.ferramentas, 2, 'hook e transcript contam a mesma chamada: vale o maior');
    assert.equal(d1.duracaoMs, 8 * MIN);
    assert.deepEqual([run.tokens, run.ferramentas, run.duracaoMs], [4020, 3, 27 * MIN]);
  });

  test('#96/AC-2 o fim da chamada fecha o run; a falha dá erro; sem a chamada, nome e fases dos metadados', () => {
    const base = comRun();
    const fim = event({ id: 'w1-fim', sessionId: 'w1', agentId: 'w1:main', type: 'PostToolUse', toolName: 'Workflow', createdAt: at(27), data: { tool_use_id: 'toolu_1' } });
    const fechado = montarWorkflows([{ ...base, eventos: [...base.eventos!, fim] }], { agora: AGORA }).runs[0];
    assert.deepEqual([fechado.estado, fechado.fim, fechado.duracaoMs], ['concluida', at(27), 26 * MIN]);
    const falhou = montarWorkflows([{ ...base, eventos: [...base.eventos!, { ...fim, type: 'PostToolUseFailure' }] }], { agora: AGORA }).runs[0];
    assert.equal(falhou.estado, 'erro');

    const sid = 'w2';
    const semChamada: SessaoDosWorkflows = {
      ...concluida(sid),
      agentes: [principal(sid), sub('a', 'Explore', 1, 3, wf('toolu_9', 'Coletar', { nome: 'triagem-de-bugs' }), sid), sub('b', 'general-purpose', 3, 6, wf('toolu_9', 'Classificar'), sid)],
    };
    const run = montarWorkflows([semChamada], { agora: AGORA }).runs[0];
    assert.deepEqual([run.nome, run.estado, run.fim, run.modelo, run.volta], ['triagem-de-bugs', 'concluida', at(6), 'claude-opus-5-5', null]);
    assert.deepEqual(run.fases.map((f) => f.nome), ['Coletar', 'Classificar']);
    assert.deepEqual(run.agentes.map((a) => [a.tokens, a.ferramentas]), [[0, 0], [0, 0]], 'sem eventos, zero, não inventado');
  });

  test('#96/AC-2 sessão sem subagente marcado não tem run; os ativos vêm primeiro', () => {
    const r = montarWorkflows([concluida('x', { agentes: [principal('x'), sub('a', 'Explore', 1, 2, wf('t2', 'F'), 'x')] }), comRun(), concluida('y')], { agora: AGORA });
    assert.deepEqual(r.runs.map((x) => [x.sessaoId, x.estado]), [['w1', 'ativa'], ['x', 'concluida']]);
  });
});

describe('#96 montarWorkflows: o grafo de orquestração', () => {
  const sessoes = () => [
    comRun(),
    concluida('a', { source: 'resume', compactou: true, agentes: [principal('a'), sub('e1', 'Explore', 1, 2, {}, 'a'), sub('e2', 'Explore', 2, 3, {}, 'a')] }),
    concluida('b', { status: 'error' }),
  ];

  test('#96/AC-3 colunas origem, principal, tipos de subagente, compactação e resultado, com o volume de cada nó e aresta', () => {
    const { grafo } = montarWorkflows(sessoes(), { agora: AGORA });
    assert.deepEqual(grafo.colunas.map((c) => c.id), ['origem', 'principal', 'subagente', 'compactacao', 'resultado']);
    assert.deepEqual(
      grafo.nos.map((n) => [n.id, n.rotulo, n.volume]),
      [
        ['origem:prompt', 'Prompt novo', 2],
        ['origem:retomada', 'Retomada', 1],
        ['principal', 'Agente principal', 3],
        ['subagente:Explore', 'Explore', 3],
        ['subagente:code-reviewer', 'code-reviewer', 2],
        ['subagente:general-purpose', 'general-purpose', 2],
        ['subagente:test-runner', 'test-runner', 1],
        ['compactacao:sem', 'Sem compactação', 2],
        ['compactacao:compactou', 'Compactou', 1],
        ['resultado:concluida', 'Concluída', 1],
        ['resultado:erro', 'Com erro', 1],
        ['resultado:andamento', 'Em andamento', 1],
      ],
    );
    const aresta = (de: string, para: string) => grafo.arestas.find((e) => e.de === de && e.para === para)?.volume ?? 0;
    assert.equal(aresta('origem:prompt', 'principal'), 2);
    assert.equal(aresta('principal', 'subagente:Explore'), 3, 'principal → tipo conta subagentes');
    assert.equal(aresta('subagente:Explore', 'compactacao:compactou'), 1, 'tipo → compactação conta sessões');
    assert.equal(aresta('subagente:Explore', 'compactacao:sem'), 1);
    assert.equal(aresta('principal', 'compactacao:sem'), 1, 'a sessão sem subagente vai direto');
    assert.equal(aresta('compactacao:sem', 'resultado:erro'), 1);
    assert.equal(aresta('compactacao:compactou', 'resultado:concluida'), 1);
  });

  test('#96/AC-3 clicar num nó filtra a tela: KPIs, runs e o grafo só das sessões que passam por ele', () => {
    const r = montarWorkflows(sessoes(), { agora: AGORA, no: 'subagente:Explore' });
    assert.equal(r.no, 'subagente:Explore');
    assert.equal(r.sessoes, 2);
    assert.equal(r.grafo.nos.find((n) => n.id === 'principal')!.volume, 2);
    assert.equal(r.runs.length, 1);
    const retomada = montarWorkflows(sessoes(), { agora: AGORA, no: 'origem:retomada' });
    assert.deepEqual([retomada.sessoes, retomada.runs.length, retomada.kpis.subagentesPorSessao], [1, 0, 2]);
    assert.equal(montarWorkflows(sessoes(), { agora: AGORA, no: 'principal' }).sessoes, 3);
  });

  test('#96/AC-4 o filtro Todas, Só ativas e Concluídas vale para a tela inteira', () => {
    const ativas = montarWorkflows(sessoes(), { agora: AGORA, filtro: 'ativas' });
    assert.deepEqual([ativas.filtro, ativas.sessoes, ativas.runs.length], ['ativas', 1, 1]);
    assert.deepEqual(ativas.grafo.nos.filter((n) => n.coluna === 'resultado').map((n) => n.id), ['resultado:andamento']);
    const concl = montarWorkflows(sessoes(), { agora: AGORA, filtro: 'concluidas' });
    assert.deepEqual([concl.sessoes, concl.runs.length, concl.kpis.duracaoMediaMs], [2, 0, 10 * MIN]);
    assert.equal(montarWorkflows(sessoes(), { agora: AGORA }).sessoes, 3);
  });
});
