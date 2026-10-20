import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Contas,
  IndiceDoDesktop,
  MontadorDoPainel,
  ResumosDeSessao,
  TrabalhoPorBranch,
  aplicarEvento,
  iniciarApiLocal,
  issueDoBranch,
  repoDoRemote,
  resumoVazio,
  type Painel,
} from '../../src/api/index.ts';
import type { WorkSource } from '../../src/github/source.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, type CenarioDoPainel } from '../../src/simulador/painel.ts';
import { parseLine } from '../../src/ingest/historico/transcript.ts';
import { ingestHook } from '../../src/ingest/hooks/index.ts';
import { T0, at, event, session } from '../fixtures.ts';
import type { SessionPlan } from '../../src/plano/modelo.ts';

const AGORA = Date.parse(T0);

async function cenario(nome: CenarioDoPainel, extra: { local?: string; conta?: string; org?: string; modelo?: string; cwd?: string } = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  await semearCenariosDoPainel(storage, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
  // O primeiro pedido dispara o trabalho por trás; o segundo já o traz.
  await montador.montar({ sessionId: 'qualquer', ...extra });
  await trabalho.esperar();
  const painel = await montador.montar({ sessionId: 'qualquer', ...extra });
  return { storage, montador, painel };
}

describe('resumo dos eventos', () => {
  test('conta os turnos, guarda o plano, a pergunta, o erro e o contexto do principal', () => {
    const r = resumoVazio();
    const ev = (over: Parameters<typeof event>[0]) => aplicarEvento(r, event(over));
    ev({ type: 'UserPromptSubmit' });
    ev({ type: 'UserPrompt' });
    ev({ type: 'UserPromptSubmit' });
    ev({
      type: 'PreToolUse',
      toolName: 'TodoWrite',
      data: { tool_input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] } },
    });
    ev({ type: 'PreToolUse', toolName: 'AskUserQuestion', data: { tool_input: { questions: [{ question: 'SQLite ou Postgres?', options: [{}, {}] }] } } });
    ev({ type: 'APIError', summary: 'API 529' });
    ev({ type: 'AssistantMessage', agentId: 's1:main', summary: 'Rodo os testes?', data: { usage: { tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    ev({ type: 'AssistantMessage', agentId: 's1:a9', data: { usage: { tokens: { input: 99_999, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    assert.equal(Math.max(r.promptsHook, r.promptsTranscript), 2);
    assert.deepEqual(r.plano?.map((i) => i.status), ['completed', 'in_progress', 'pending']);
    assert.deepEqual(r.ultimaPergunta && { texto: r.ultimaPergunta.texto, opcoes: r.ultimaPergunta.opcoes }, { texto: 'SQLite ou Postgres?', opcoes: 2 });
    assert.equal(r.ultimoErro?.texto, 'API 529');
    assert.equal(r.ultimaMensagem, 'Rodo os testes?');
    assert.equal(r.contexto, 115, 'o subagente não muda o contexto do principal');
  });

  test('sem mudança na sessão, nada é lido; com mudança, só os eventos novos', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session());
    for (let i = 0; i < 3; i++) await storage.appendEvent(event({ id: `e${i}`, type: 'UserPromptSubmit', createdAt: at(i) }));
    const resumos = new ResumosDeSessao(storage, { agora: () => AGORA });
    assert.equal((await resumos.ler('s1', at(2))).promptsHook, 3);
    assert.equal(resumos.eventosLidos, 3);
    await resumos.ler('s1', at(2));
    assert.equal(resumos.eventosLidos, 3, 'o mesmo updatedAt não lê nada');
    await storage.appendEvent(event({ id: 'e9', type: 'UserPromptSubmit', createdAt: at(9) }));
    assert.equal((await resumos.ler('s1', at(9))).promptsHook, 4);
    assert.equal(resumos.eventosLidos, 4, 'lê só o evento novo');
    await storage.close();
  });
});

describe('trabalho pelo branch', () => {
  test('número da issue e repositório', () => {
    assert.equal(issueDoBranch('feat/35-painel-por-sessao-17b5d0'), 35);
    assert.equal(issueDoBranch('35-painel'), 35);
    assert.equal(issueDoBranch('fix/issue-116'), 116);
    assert.equal(issueDoBranch('claude/painel-17b5d0'), null);
    assert.equal(issueDoBranch('main'), null);
    assert.equal(repoDoRemote('git@github.com:exemplo/simulacao.git'), 'exemplo/simulacao');
    assert.equal(repoDoRemote('https://github.com/exemplo/simulacao'), 'exemplo/simulacao');
    assert.equal(repoDoRemote('https://gitlab.com/x/y.git'), null);
  });

  test('o pedido não espera o GitHub; a falha vira aviso e guarda o último dado', async () => {
    let falhar = false;
    const base = new FonteDeTrabalhoDoSimulador();
    const fonte: WorkSource = {
      listShallow: () => base.listShallow(),
      nodes: (k) => (falhar ? Promise.reject(new Error('fora do ar')) : base.nodes(k)),
      children: () => base.children(),
      detail: (k) => base.detail(k),
    };
    const storage = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(storage, 'p5', AGORA);
    let agora = AGORA;
    const t = new TrabalhoPorBranch({ fonte, git: FonteDeTrabalhoDoSimulador.git, agora: () => agora });
    assert.equal(t.ler('/simulacao/x', null), null, 'a primeira leitura não espera');
    await t.esperar();
    const lido = t.ler('/simulacao/x', null);
    assert.equal(lido?.issue?.number, 47);
    assert.deepEqual(lido?.pr && { state: lido.pr.state, ci: lido.pr.ci, review: lido.pr.review }, { state: 'open', ci: 'failed', review: 'changes-requested' });
    falhar = true;
    agora += 10 * 60_000;
    t.ler('/simulacao/x', null);
    await t.esperar();
    assert.equal(t.ler('/simulacao/x', null)?.issue?.number, 47, 'o último dado bom continua');
    await storage.close();
  });
});

describe('painel por cenário (P1 a P7)', () => {
  test('P1: sessão ativa, plano, subagentes, trabalho e duas que precisam de você', async () => {
    const { painel: p, storage } = await cenario('p1');
    assert.equal(p.version, 1);
    assert.equal(p.session?.title, 'Kanban de sessões no artefato');
    assert.equal(p.session?.state, 'active');
    assert.equal(p.session?.activity.text, 'rodando Bash · npm test');
    assert.equal(p.session?.turn, 18);
    assert.equal(p.context?.pct, 31);
    assert.ok(p.cost?.usd && Math.abs(p.cost.usd - 1.84) < 0.05, `custo ${p.cost?.usd}`);
    assert.ok((p.cost?.series.length ?? 0) >= 2);
    assert.deepEqual(p.background, { total: 2, first: 'npm run dev' });
    // O plano atual do histórico (#131): dois anteriores, um concluído e um abandonado.
    const { steps, ...plano } = p.plan!;
    assert.deepEqual(plano, { done: 3, total: 6, current: 'Rodar a bateria', next: 'Abrir o PR', remaining: 1, currentOwner: { type: 'main', name: null, agentId: `${SESSAO_DO_PAINEL}:main` }, changedAt: at(-0.5) });
    assert.deepEqual(
      p.plans.map((x) => [x.number, x.outcome, x.summary, `${x.done}/${x.total}`, x.current, x.end === null]),
      [
        [3, 'current', 'Ler o artefato', '3/6', 'Rodar a bateria', true],
        [2, 'abandoned', 'Prototipar o arrastar', '1/4', null, false],
        [1, 'completed', 'Ler o wireframe do kanban', '3/3', null, false],
      ],
    );
    assert.equal(steps.length, 6);
    assert.equal(p.subagents.active, 1);
    assert.equal(p.subagents.items[0]?.name, 'Explore');
    assert.equal(p.work?.issue?.number, 42);
    assert.equal(p.work?.pr?.state, 'draft');
    // #140: a permissão precisa de você; a interrompida (Esc) é só a sua vez, fora da contagem.
    assert.equal(p.needYou.total, 1);
    assert.equal(p.needYou.yourTurn, 1);
    assert.deepEqual(p.needYou.machine.map((i) => [i.title, i.level, i.why]), [['motor-de-regras', 'needs', 'permission'], ['app-receitas', 'your-turn', 'interrupted']]);
    await storage.close();
  });

  test('P2 e P3: a faixa mostra a pergunta inteira ou o pedido de permissão', async () => {
    const p2 = await cenario('p2');
    assert.equal(p2.painel.session?.banner?.type, 'question');
    assert.match(p2.painel.session?.banner?.text ?? '', /SQLite em memória/);
    assert.equal(p2.painel.session?.banner?.footer, '3 opções · responda na conversa ao lado');
    assert.equal(p2.painel.work?.notPushed, true);
    assert.equal(p2.painel.work?.pr, null);
    assert.equal(p2.painel.needYou.total, 0);
    const p3 = await cenario('p3');
    assert.equal(p3.painel.session?.banner?.text, 'Bash quer rodar npm run migrate em /simulacao/motor-de-regras');
    assert.equal(p3.painel.session?.activity.text, 'Bash: npm run migrate');
    assert.equal(p3.painel.session?.urgent, true);
    await p2.storage.close();
    await p3.storage.close();
  });

  test('P4: delegando a três subagentes, com três sessões filhas e uma que espera você', async () => {
    const { painel: p, storage } = await cenario('p4');
    assert.equal(p.session?.state, 'delegating');
    assert.equal(p.session?.activity.text, 'esperando 3 subagentes');
    assert.equal(p.subagents.active, 3);
    assert.deepEqual(p.children.map((f) => [f.title, f.state]), [
      ['fila-de-tarefas', 'waiting'],
      ['catalogo-exemplo', 'active'],
      ['blog-estatico', 'completed'],
    ]);
    assert.deepEqual(p.needYou.family.map((i) => [i.title, i.relation]), [['fila-de-tarefas', 'child']]);
    await storage.close();
  });

  test('P5: com erro, a faixa traz o erro e o CI falhou', async () => {
    const { painel: p, storage } = await cenario('p5');
    assert.equal(p.session?.status, 'error');
    assert.equal(p.session?.banner?.type, 'error');
    assert.match(p.session?.banner?.text ?? '', /^API 529/);
    assert.equal(p.context?.pct, 84);
    assert.equal(p.work?.pr?.ci, 'failed');
    assert.equal(p.subagents.items.find((s) => s.status === 'error')?.name, 'test-runner');
    await storage.close();
  });

  test('P6: a sessão que o núcleo ainda não viu espera o primeiro prompt, com o modelo e a pasta do painel', async () => {
    const { painel: p, storage } = await cenario('p6', { modelo: 'claude-sonnet-5-5', cwd: '/simulacao/cli-de-notas' });
    assert.equal(p.session?.reason, 'session_start');
    assert.equal(p.session?.model, 'claude-sonnet-5-5');
    assert.equal(p.session?.turn, 0);
    assert.equal(p.plan, null);
    assert.equal(p.subagents.items.length, 0);
    assert.equal(p.work?.branch, 'main');
    assert.equal(p.work?.issue, null);
    // Permissão e erro precisam de você; a interrompida é a sua vez.
    assert.equal(p.needYou.total, 2);
    assert.equal(p.needYou.yourTurn, 1);
    await storage.close();
  });

  test('P7: família e máquina inteira, urgentes primeiro; a divisão por conta nunca mistura contas', async () => {
    const { painel: p, storage } = await cenario('p7');
    assert.deepEqual(p.needYou.family.map((i) => [i.title, i.relation]), [
      ['motor-de-regras', 'parent'],
      ['fila-de-tarefas', 'child'],
    ]);
    assert.deepEqual(p.needYou.machine.map((i) => [i.title, i.level]), [['motor-de-regras', 'needs'], ['painel-de-metricas', 'needs'], ['fila-de-tarefas', 'your-turn']]);
    // A divisão por conta conta só as que precisam de você: a sua vez (fila-de-tarefas) não soma.
    assert.deepEqual(
      p.needYou.byAccount.map((d) => [d.account?.label, d.n]),
      [
        ['equipe', 1],
        ['cliente-exemplo', 1],
      ],
    );
    await storage.close();
  });
});

describe('conta da sessão (decisão 0006)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ahrena-contas-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const UUID_A = '00000000-0000-4000-8000-00000000000a';
  const ORG_A = '00000000-0000-4000-8000-0000000000aa';
  const UUID_B = '00000000-0000-4000-8000-00000000000b';
  const ORG_B = '00000000-0000-4000-8000-0000000000bb';

  test('vale a fonte de menor ordem: ambiente, porta (config), Desktop só com uma pasta; sem fonte, "Sem conta"', async () => {
    const arquivo = join(dir, 'contas.json');
    writeFileSync(arquivo, JSON.stringify({ [`${UUID_B}/${ORG_B}`]: { rotulo: 'cliente', cor: '#1baf7a' } }));
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putAccount({
      id: `${UUID_A}/${ORG_A}`, accountUuid: UUID_A, organizationUuid: ORG_A, organizationName: null, organizationType: null,
      label: 'equipe', color: '#df285d', configDirs: [], firstSeenAt: T0, lastSeenAt: T0, metadata: {},
    });
    const contas = new Contas({ storage, arquivo });
    await contas.atualizar();
    const s = (over: Partial<{ accountId: string | null; accountSource: 'config' | 'env' | null }> = {}) => ({ id: 's1', accountId: null, accountSource: null, ...over });
    const desktop = (escopos: string[]) => ({ localId: 'local_x', cliSessionId: 's1', titulo: null, branch: null, cwd: null, maeLocalId: null, arquivada: false, contas: escopos });
    assert.equal(contas.daSessao(s(), desktop([`${UUID_A}/${ORG_A}`, `${UUID_B}/${ORG_B}`])), null, 'duas pastas: a pasta não diz a conta');
    assert.deepEqual(contas.daSessao(s(), desktop([`${UUID_B}/${ORG_B}`])), { id: `${UUID_B}/${ORG_B}`, label: 'cliente', color: '#1baf7a', source: 'desktop' });
    const daPorta = contas.daSessao(s({ accountId: `${UUID_A}/${ORG_A}`, accountSource: 'config' }), desktop([`${UUID_B}/${ORG_B}`]));
    assert.deepEqual(daPorta && [daPorta.label, daPorta.color, daPorta.source], ['equipe', '#df285d', 'config'], 'config vence desktop');
    contas.informar('s1', UUID_B, ORG_B);
    const env = contas.daSessao(s({ accountId: `${UUID_A}/${ORG_A}`, accountSource: 'config' }), null);
    assert.deepEqual(env && [env.label, env.source], ['cliente', 'env'], 'o ambiente vence a porta gravada com fonte pior');
    contas.informar('s2', 'não é uuid', ORG_A);
    assert.equal(contas.daSessao({ id: 's2', accountId: null, accountSource: null }, null), null);
    await storage.close();
  });

  test('índice do Desktop: título, branch, mãe e conta pela pasta, relendo só o que mudou', async () => {
    const pasta = (conta: string, org: string) => {
      const p = join(dir, conta, org);
      mkdirSync(p, { recursive: true });
      return p;
    };
    const a = pasta(UUID_A, ORG_A);
    const b = pasta(UUID_B, ORG_B);
    const local = (p: string, id: string, extra: object) => writeFileSync(join(p, `${id}.json`), JSON.stringify({ sessionId: id, ...extra }));
    local(a, 'local_mae', { cliSessionId: 'cli-mae', title: 'Mãe', branch: 'feat/1-x' });
    local(a, 'local_filha', { cliSessionId: 'cli-filha', title: 'Filha', spawnedFrom: { sessionId: 'local_mae' } });
    local(b, 'local_filha', { cliSessionId: 'cli-filha', title: 'Filha', spawnedFrom: { sessionId: 'local_mae' } });
    local(a, 'local_velha', { cliSessionId: 'cli-velha', title: 'Velha', isArchived: true, spawnedFrom: { sessionId: 'local_mae' } });
    const indice = new IndiceDoDesktop({ raiz: dir, intervaloMs: 0 });
    await indice.atualizar();
    assert.equal(indice.sessaoPorCli('cli-mae')?.branch, 'feat/1-x');
    // #145: a arquivada vem junto, marcada.
    assert.deepEqual(indice.filhasDe('local_mae').map((f) => [f.titulo, f.arquivada]).sort(), [['Filha', false], ['Velha', true]]);
    assert.equal(indice.sessaoPorCli('cli-filha')?.contas.length, 2);
    const lidos = indice.lidos;
    await indice.atualizar(true);
    assert.equal(indice.lidos, lidos, 'sem mudança, nenhum arquivo é relido');
    local(a, 'local_mae', { cliSessionId: 'cli-mae', title: 'Mãe renomeada' });
    utimesSync(join(a, 'local_mae.json'), new Date(), new Date(Date.now() + 5000));
    await indice.atualizar(true);
    assert.equal(indice.lidos, lidos + 1);
    assert.equal(indice.sessaoPorCli('cli-mae')?.titulo, 'Mãe renomeada');
  });
});

describe('servidor da API local', () => {
  let storage: SqliteStorage;
  beforeEach(() => {
    storage = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => storage.close());

  test('hooks e painel na mesma porta; Origin ou Host de fora dá 403', async () => {
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null });
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      assert.equal((await fetch(`${api.url}/api/overview`)).status, 200);
      assert.equal((await fetch(`${api.url}/api/overview`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
      assert.equal((await fetch(`${api.url}/api/panel/${encodeURIComponent('id com espaço')}`)).status, 400);

      const antes = (await (await fetch(`${api.url}/api/panel/sess-api-1?model=claude-opus-5-5`)).json()) as Painel;
      assert.equal(antes.session?.reason, 'session_start', 'ainda não visto: sessão nova');

      const hook = { session_id: 'sess-api-1', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
      const r = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
      assert.equal(r.status, 202);
      const depois = (await (await fetch(`${api.url}/api/panel/sess-api-1`)).json()) as Painel;
      assert.equal(depois.session?.cwd, '/repo/app');
      const carga = (await (await fetch(`${api.url}/api/carga`)).json()) as { painel: number };
      assert.equal(carga.painel, 2);
    } finally {
      await api.close();
    }
  });
});

describe('contrato com o plugin', () => {
  test('o plugin leva o mesmo encaminhador e os mesmos hooks do núcleo', () => {
    const ler = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(ler('../../../../plugins/ahrena-console/hooks/forward.mjs'), ler('../../src/ingest/hooks/plugin/hooks/forward.mjs'));
    const doPlugin = JSON.parse(ler('../../../../plugins/ahrena-console/hooks/hooks.json'));
    const doNucleo = JSON.parse(ler('../../src/ingest/hooks/plugin/hooks/hooks.json'));
    assert.deepEqual(doPlugin.hooks, doNucleo.hooks);
    assert.deepEqual(doPlugin.modules, ['./register.tsx']);
  });

  test('o transcript guarda a entrada do TodoWrite e do AskUserQuestion, e só delas', () => {
    const linha = (name: string, input: object) =>
      JSON.stringify({ type: 'assistant', uuid: `u-${name}`, timestamp: T0, sessionId: 's1', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] } });
    const todo = parseLine(linha('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] }), new Map());
    assert.deepEqual((todo?.events[0]?.data as { tool_input?: unknown }).tool_input, { todos: [{ content: 'a', status: 'pending' }] });
    const bash = parseLine(linha('Bash', { command: 'segredo=1 npm test' }), new Map());
    assert.equal((bash?.events[0]?.data as { tool_input?: unknown }).tool_input, undefined);
  });

  test('a versão do rodapé do plugin é a do plugin.json e a do marketplace', () => {
    const ler = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const versao = JSON.parse(ler('../../../../plugins/ahrena-console/.claude-plugin/plugin.json')).version;
    const doMarketplace = JSON.parse(ler('../../../../.claude-plugin/marketplace.json')).plugins.find((p: { name: string }) => p.name === 'ahrena-console').version;
    assert.equal(/PLUGIN_VERSION = '([^']+)'/.exec(ler('../../../../plugins/ahrena-console/hooks/render.tsx'))?.[1], versao);
    assert.equal(doMarketplace, versao);
  });

  // #187: the mod reads the new route (`/api/panel/<id>`), so its types cover the English body as is.
  test('todo campo da resposta está nos tipos do plugin', async () => {
    const { painel, storage } = await cenario('p4');
    const tipos = readFileSync(new URL('../../../../plugins/ahrena-console/types/index.d.ts', import.meta.url), 'utf8');
    const chaves = new Set<string>();
    const juntar = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(juntar);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (chaves.add(k), juntar(x));
    };
    juntar(painel);
    const faltando = [...chaves].filter((k) => !new RegExp(`\\b${k}\\??:`).test(tipos));
    assert.deepEqual(faltando, []);
    await storage.close();
  });
});

describe('card Plano pelo plano gravado (item 1.9)', () => {
  test('feitos/total, atual, próximo e o dono de cada passo, com o nome do subagente', async () => {
    const { storage, montador } = await cenario('p4');
    // Banco de antes do histórico (#131): o card lê o plano gravado.
    storage.db.exec('DELETE FROM session_plan_history');
    const sub = (await storage.listAgents(SESSAO_DO_PAINEL)).find((a) => a.type === 'subagent')!;
    const passo = (id: string, text: string, status: 'pending' | 'in_progress' | 'completed', owner: SessionPlan['steps'][number]['owner']) =>
      ({ id, text, activeText: null, status, owner, updatedAt: at(1) });
    await storage.putPlan({
      sessionId: SESSAO_DO_PAINEL,
      source: 'Task',
      steps: [
        passo('1', 'Mapear', 'completed', { kind: 'main', agentId: `${SESSAO_DO_PAINEL}:main`, name: null }),
        passo('2', 'Extrair a cobrança', 'in_progress', { kind: 'subagent', agentId: sub.id, name: null }),
        passo('3', 'Revisar', 'pending', { kind: 'session', agentId: null, name: 'revisao' }),
        passo('4', 'Abrir o PR', 'pending', { kind: 'subagent', agentId: null, name: 'revisor' }),
      ],
      done: 1,
      total: 4,
      currentStepId: '2',
      changedAt: at(2),
      metadata: {},
    });
    const p = (await montador.montar({ sessionId: 'qualquer' })).plan!;
    assert.deepEqual([p.done, p.total, p.current, p.next, p.remaining, p.changedAt], [1, 4, 'Extrair a cobrança', 'Revisar', 1, at(2)]);
    assert.deepEqual(p.currentOwner, { type: 'subagent', name: sub.subagentType ?? sub.name, agentId: sub.id });
    assert.deepEqual(
      p.steps.map((x) => [x.text, x.state, x.owner.type, x.owner.name]),
      [
        ['Mapear', 'completed', 'main', null],
        ['Extrair a cobrança', 'in_progress', 'subagent', sub.subagentType ?? sub.name],
        ['Revisar', 'pending', 'session', 'revisao'],
        ['Abrir o PR', 'pending', 'subagent', 'revisor'],
      ],
    );
    await storage.close();
  });

  test('plano gravado vazio (depois do /clear) é "sem plano"', async () => {
    const { storage, montador } = await cenario('p1');
    storage.db.exec('DELETE FROM session_plan_history');
    await storage.putPlan({ sessionId: SESSAO_DO_PAINEL, source: 'TodoWrite', steps: [], done: 0, total: 0, currentStepId: null, changedAt: at(3), metadata: {} });
    assert.equal((await montador.montar({ sessionId: 'qualquer' })).plan, null);
    await storage.close();
  });
});

describe('histórico dos planos no painel (#131)', () => {
  test('depois do /clear não há plano atual, mas os anteriores continuam, do mais recente para o mais antigo', async () => {
    const { storage, montador } = await cenario('p1');
    await ingestHook(storage, { session_id: SESSAO_DO_PAINEL, hook_event_name: 'SessionStart', source: 'clear' }, { receivedAt: new Date(T0).toISOString() });
    const p = await montador.montar({ sessionId: 'qualquer' });
    assert.equal(p.plan, null);
    assert.deepEqual(p.plans.map((x) => [x.number, x.outcome, `${x.done}/${x.total}`]), [[3, 'abandoned', '3/6'], [2, 'abandoned', '1/4'], [1, 'completed', '3/3']]);
    await storage.close();
  });

  test('sessão sem plano nenhum: lista vazia', async () => {
    const { storage, montador } = await cenario('p7');
    assert.deepEqual((await montador.montar({ sessionId: 'qualquer' })).plans, []);
    await storage.close();
  });
});
