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
import { T0, at, event, session } from '../fixtures.ts';

const AGORA = Date.parse(T0);

async function cenario(nome: CenarioDoPainel, extra: { local?: string; conta?: string; org?: string; modelo?: string; cwd?: string } = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  await semearCenariosDoPainel(storage, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ arquivo: null }), desktop: null, trabalho, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
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
    assert.equal(lido?.issue?.numero, 47);
    assert.deepEqual(lido?.pr && { estado: lido.pr.estado, ci: lido.pr.ci, review: lido.pr.review }, { estado: 'aberto', ci: 'falhou', review: 'ajustes' });
    falhar = true;
    agora += 10 * 60_000;
    t.ler('/simulacao/x', null);
    await t.esperar();
    assert.equal(t.ler('/simulacao/x', null)?.issue?.numero, 47, 'o último dado bom continua');
    await storage.close();
  });
});

describe('painel por cenário (P1 a P7)', () => {
  test('P1: sessão ativa, plano, subagentes, trabalho e duas que precisam de você', async () => {
    const { painel: p, storage } = await cenario('p1');
    assert.equal(p.versao, 1);
    assert.equal(p.sessao?.titulo, 'Kanban de sessões no artefato');
    assert.equal(p.sessao?.estado, 'active');
    assert.equal(p.sessao?.atividade.texto, 'rodando Bash · npm test');
    assert.equal(p.sessao?.turno, 18);
    assert.equal(p.contexto?.pct, 31);
    assert.ok(p.custo?.usd && Math.abs(p.custo.usd - 1.84) < 0.05, `custo ${p.custo?.usd}`);
    assert.ok((p.custo?.serie.length ?? 0) >= 2);
    assert.deepEqual(p.background, { total: 2, primeiro: 'npm run dev' });
    assert.deepEqual(p.plano, { feitos: 3, total: 6, atual: 'Rodar a bateria', proximo: 'Abrir o PR', restantes: 1 });
    assert.equal(p.subagentes.ativos, 1);
    assert.equal(p.subagentes.itens[0]?.nome, 'Explore');
    assert.equal(p.trabalho?.issue?.numero, 42);
    assert.equal(p.trabalho?.pr?.estado, 'rascunho');
    assert.equal(p.precisam.total, 2);
    assert.deepEqual(p.precisam.maquina.map((i) => i.titulo), ['motor-de-regras', 'app-receitas']);
    await storage.close();
  });

  test('P2 e P3: a faixa mostra a pergunta inteira ou o pedido de permissão', async () => {
    const p2 = await cenario('p2');
    assert.equal(p2.painel.sessao?.faixa?.tipo, 'pergunta');
    assert.match(p2.painel.sessao?.faixa?.texto ?? '', /SQLite em memória/);
    assert.equal(p2.painel.sessao?.faixa?.rodape, '3 opções · responda na conversa ao lado');
    assert.equal(p2.painel.trabalho?.semPush, true);
    assert.equal(p2.painel.trabalho?.pr, null);
    assert.equal(p2.painel.precisam.total, 0);
    const p3 = await cenario('p3');
    assert.equal(p3.painel.sessao?.faixa?.texto, 'Bash quer rodar npm run migrate em /simulacao/motor-de-regras');
    assert.equal(p3.painel.sessao?.atividade.texto, 'Bash: npm run migrate');
    assert.equal(p3.painel.sessao?.urgente, true);
    await p2.storage.close();
    await p3.storage.close();
  });

  test('P4: delegando a três subagentes, com três sessões filhas e uma que espera você', async () => {
    const { painel: p, storage } = await cenario('p4');
    assert.equal(p.sessao?.estado, 'delegating');
    assert.equal(p.sessao?.atividade.texto, 'esperando 3 subagentes');
    assert.equal(p.subagentes.ativos, 3);
    assert.deepEqual(p.filhas.map((f) => [f.titulo, f.estado]), [
      ['fila-de-tarefas', 'waiting'],
      ['catalogo-exemplo', 'active'],
      ['blog-estatico', 'completed'],
    ]);
    assert.deepEqual(p.precisam.familia.map((i) => [i.titulo, i.relacao]), [['fila-de-tarefas', 'filha']]);
    await storage.close();
  });

  test('P5: com erro, a faixa traz o erro e o CI falhou', async () => {
    const { painel: p, storage } = await cenario('p5');
    assert.equal(p.sessao?.status, 'error');
    assert.equal(p.sessao?.faixa?.tipo, 'erro');
    assert.match(p.sessao?.faixa?.texto ?? '', /^API 529/);
    assert.equal(p.contexto?.pct, 84);
    assert.equal(p.trabalho?.pr?.ci, 'falhou');
    assert.equal(p.subagentes.itens.find((s) => s.status === 'error')?.nome, 'test-runner');
    await storage.close();
  });

  test('P6: a sessão que o núcleo ainda não viu espera o primeiro prompt, com o modelo e a pasta do painel', async () => {
    const { painel: p, storage } = await cenario('p6', { modelo: 'claude-sonnet-5-5', cwd: '/simulacao/cli-de-notas' });
    assert.equal(p.sessao?.motivo, 'session_start');
    assert.equal(p.sessao?.modelo, 'claude-sonnet-5-5');
    assert.equal(p.sessao?.turno, 0);
    assert.equal(p.plano, null);
    assert.equal(p.subagentes.itens.length, 0);
    assert.equal(p.trabalho?.branch, 'main');
    assert.equal(p.trabalho?.issue, null);
    assert.equal(p.precisam.total, 3);
    await storage.close();
  });

  test('P7: família e máquina inteira, urgentes primeiro; a divisão por conta nunca mistura contas', async () => {
    const { painel: p, storage } = await cenario('p7');
    assert.deepEqual(p.precisam.familia.map((i) => [i.titulo, i.relacao]), [
      ['motor-de-regras', 'mae'],
      ['fila-de-tarefas', 'filha'],
    ]);
    assert.deepEqual(p.precisam.maquina.map((i) => i.titulo), ['motor-de-regras', 'painel-de-metricas', 'fila-de-tarefas']);
    assert.deepEqual(
      p.precisam.porConta.map((d) => [d.conta?.rotulo, d.n]),
      [
        ['equipe', 2],
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

  test('o ambiente do painel vale primeiro; o Desktop só com uma pasta; sem fonte, "Sem conta"', async () => {
    const arquivo = join(dir, 'contas.json');
    writeFileSync(arquivo, JSON.stringify({ [`${UUID_B}/${ORG_B}`]: { rotulo: 'cliente', cor: 'green' } }));
    const contas = new Contas({ arquivo });
    await contas.atualizar();
    const desktop = (escopos: string[]) => ({ localId: 'local_x', cliSessionId: 's1', titulo: null, branch: null, cwd: null, maeLocalId: null, arquivada: false, contas: escopos });
    assert.equal(contas.daSessao({ id: 's1', metadata: {} }, desktop([`${UUID_A}/${ORG_A}`, `${UUID_B}/${ORG_B}`])), null, 'duas pastas: a pasta não diz a conta');
    assert.equal(contas.daSessao({ id: 's1', metadata: {} }, desktop([`${UUID_B}/${ORG_B}`]))?.rotulo, 'cliente');
    contas.informar('s1', UUID_A, ORG_A);
    const a = contas.daSessao({ id: 's1', metadata: {} }, desktop([`${UUID_B}/${ORG_B}`]));
    assert.deepEqual(a && { fonte: a.fonte, rotulo: a.rotulo }, { fonte: 'env', rotulo: 'conta 2' });
    contas.informar('s2', 'não é uuid', ORG_A);
    assert.equal(contas.daSessao({ id: 's2', metadata: {} }, null), null);
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
    const indice = new IndiceDoDesktop({ raiz: dir, intervaloMs: 0 });
    await indice.atualizar();
    assert.equal(indice.sessaoPorCli('cli-mae')?.branch, 'feat/1-x');
    assert.deepEqual(indice.filhasDe('local_mae').map((f) => f.titulo), ['Filha']);
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
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ arquivo: null }), desktop: null, trabalho: null });
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      assert.equal((await fetch(`${api.url}/api/overview`)).status, 200);
      assert.equal((await fetch(`${api.url}/api/overview`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
      assert.equal((await fetch(`${api.url}/api/painel/${encodeURIComponent('id com espaço')}`)).status, 400);

      const antes = (await (await fetch(`${api.url}/api/painel/sess-api-1?modelo=claude-opus-5-5`)).json()) as Painel;
      assert.equal(antes.sessao?.motivo, 'session_start', 'ainda não visto: sessão nova');

      const hook = { session_id: 'sess-api-1', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
      const r = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
      assert.equal(r.status, 202);
      const depois = (await (await fetch(`${api.url}/api/painel/sess-api-1`)).json()) as Painel;
      assert.equal(depois.sessao?.cwd, '/repo/app');
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
