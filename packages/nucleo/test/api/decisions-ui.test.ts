// The decisions in the core's /ui (#103): the C21 page (all decisions, grouped, with search), the
// Detail's C20 tab (scope, injection and MCP), the origin exception of the /ui itself writing (decision
// 0003) and the "Promover a registro". Simulator data (P9) and temporary folders, never the real repo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Accounts,
  DecisoesDaUi,
  MontadorDoPainel,
  startLocalApi,
  type LocalApi,
  type DecisaoDaUi,
  type DecisoesDaAba,
  type DecisoesDaPagina,
  type RascunhoDeRegistro,
} from '../../src/api/index.ts';
import { registerDecision } from '../../src/decisions/registry.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { P9_PARENT, PANEL_SESSION, seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const VITRINE = 'sim-panel-vitrine-demo';
const VITRINE_ONTEM = 'sim-panel-vitrine-yesterday';
const JSON_ = { 'content-type': 'application/json' };

/** O rascunho como a rota antiga `/api/decisoes/:id/promover` o responde: as chaves antigas (a nova responde `draft`, um `RascunhoDeRegistro`). */
type RascunhoAntigo = Omit<RascunhoDeRegistro, 'path' | 'canWrite' | 'reason'> & { caminho: string; podeGravar: boolean; motivo: string | null };

interface Cenario {
  storage: SqliteStorage;
  decisoes: SqliteDecisionStore;
  montador: MontadorDoPainel;
  /** As opções da `DecisoesDaUi` da API, para montar outra igual. */
  opcoes: ConstructorParameters<typeof DecisoesDaUi>[0];
  api: LocalApi;
  host: string;
  ler<T>(caminho: string, headers?: Record<string, string>): Promise<{ status: number; corpo: T }>;
  postar<T>(caminho: string, corpo: unknown, headers?: Record<string, string>): Promise<{ status: number; corpo: T }>;
  fechar(): Promise<void>;
}

async function cenario(opcoes: Partial<ConstructorParameters<typeof DecisoesDaUi>[0]> = {}): Promise<Cenario> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await seedPanelScenario(storage, 'p9', AGORA);
  await seedPanelDecisions(decisoes, 'p9', AGORA);
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, decisoes, agora: () => AGORA });
  const opcoesDaUi = { decisions: decisoes, storage, alvoDe: (id: string) => montador.alvoDaSessao(id), agora: () => AGORA, ...opcoes };
  const decisoesUi = new DecisoesDaUi(opcoesDaUi);
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, decisionsUi: decisoesUi });
  const host = new URL(api.url).host;
  const ler = async <T>(caminho: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${api.url}${caminho}`, { headers });
    return { status: r.status, corpo: (await r.json()) as T };
  };
  const postar = async <T>(caminho: string, corpo: unknown, headers: Record<string, string> = JSON_) => {
    const r = await fetch(`${api.url}${caminho}`, { method: 'POST', headers, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });
    return { status: r.status, corpo: (await r.json()) as T };
  };
  return {
    storage, decisoes, montador, opcoes: opcoesDaUi, api, host, ler, postar,
    fechar: async () => {
      await api.close();
      await storage.close();
    },
  };
}

const rotulos = (itens: DecisaoDaUi[]) => itens.map((i) => i.title);

describe('C21: GET /api/decisoes (todas as decisões)', () => {
  let c: Cenario;
  before(async () => {
    c = await cenario();
  });
  after(() => c.fechar());

  test('por branch (padrão): as contagens sobre tudo, os grupos mais recentes primeiro, até 3 itens', async () => {
    const { status, corpo } = await c.ler<DecisoesDaPagina>('/api/decisions');
    assert.equal(status, 200);
    assert.equal(corpo.groupBy, 'branch');
    assert.equal(corpo.state, 'all');
    assert.equal(corpo.q, null);
    assert.deepEqual(corpo.counts, { current: 17, branches: 4, toConfirm: 3, superseded30d: 4, promoted: 4 });
    assert.deepEqual(
      corpo.groups.map((g) => g.title),
      ['feat/42-kanban-de-sessoes', 'feat/42-kanban', 'refactor/pagamentos', 'perf/47-relatorio'],
    );
    const vitrine = corpo.groups[1]!;
    assert.equal(vitrine.type, 'branch');
    assert.equal(vitrine.repo, '/simulacao/vitrine-demo');
    assert.equal(vitrine.folder, 'vitrine-demo');
    assert.deepEqual([vitrine.current, vitrine.toConfirm, vitrine.total, vitrine.items.length, vitrine.more], [6, 1, 8, 3, 5]);
    assert.match(vitrine.key, /^[A-Za-z0-9_.-]+$/, 'a chave vai na URL sem escapar');
    assert.deepEqual(rotulos(vitrine.items), ['Esconder sessões encerradas há mais de 7 dias', 'SQLite em memória nos testes', 'Card com 3 linhas: título, branch e PR']);
    const sugerida = vitrine.items[0]!;
    assert.equal(sugerida.state, 'to_confirm');
    assert.equal(sugerida.origin, 'suggested');
    assert.equal(sugerida.sessionId, VITRINE);
    assert.equal(sugerida.scope, 'session');
    assert.equal(sugerida.session, 'this', 'na página não há sessão de referência');
    assert.equal(sugerida.conversation, `/ui/sessions/${VITRINE}`);
    assert.equal(sugerida.branch, 'feat/42-kanban');
    assert.equal(sugerida.repo, '/simulacao/vitrine-demo');
    const correcao = vitrine.items[1]!;
    assert.equal(correcao.origin, 'correction');
    assert.equal(correcao.label, 'D7');
    assert.equal(correcao.supersedes, 'D3');
    assert.deepEqual(correcao.rejected, ['Postgres no Docker']);
    const [refactor, perf] = [corpo.groups[2]!, corpo.groups[3]!];
    assert.deepEqual([refactor.folder, refactor.current, refactor.toConfirm], ['motor-de-regras', 4, 0]);
    assert.deepEqual([perf.folder, perf.current, perf.toConfirm], ['painel-de-metricas', 3, 1]);
  });

  test('a lista sai de todas as sessões, inclusive a mãe que só existe na porta das decisões', async () => {
    const { corpo } = await c.ler<DecisoesDaPagina>('/api/decisions?groupBy=session');
    const sessoes = corpo.groups.map((g) => g.key && g.items[0]!.sessionId);
    for (const s of [PANEL_SESSION, P9_PARENT, VITRINE, VITRINE_ONTEM, 'sim-panel-motor-de-regras', 'sim-panel-painel-de-metricas']) assert.ok(sessoes.includes(s), s);
    const vitrine = corpo.groups.find((g) => g.items[0]!.sessionId === VITRINE)!;
    assert.equal(vitrine.type, 'session');
    assert.equal(vitrine.title, 'Kanban da vitrine', 'o título da sessão gravada');
    assert.equal(corpo.groups.find((g) => g.items[0]!.sessionId === VITRINE_ONTEM)!.title, VITRINE_ONTEM, 'sem sessão gravada, o id');
  });

  test('por família: a mãe e a filha juntas, com o título de uma sessão gravada da família', async () => {
    const { corpo } = await c.ler<DecisoesDaPagina>('/api/decisions?groupBy=family');
    assert.equal(corpo.groupBy, 'family');
    assert.equal(corpo.groups.length, 4);
    const vitrine = corpo.groups.find((g) => g.title === 'Kanban da vitrine')!;
    assert.equal(vitrine.type, 'family');
    assert.equal(vitrine.total, 8);
    assert.equal(vitrine.folder, 'vitrine-demo');
    const todas = (await c.ler<DecisoesDaPagina>(`/api/decisions?groupBy=family&group=${vitrine.key}`)).corpo.groups[0]!;
    assert.ok(todas.items.some((i) => i.sessionId === VITRINE_ONTEM && i.title === 'Cards só leitura, sem arrastar'));
  });

  test('estado: vigentes e a confirmar filtram os itens e os números do grupo, não as contagens', async () => {
    const vigentes = (await c.ler<DecisoesDaPagina>('/api/decisions?state=current')).corpo;
    assert.equal(vigentes.state, 'current');
    assert.deepEqual(vigentes.counts.toConfirm, 3);
    for (const g of vigentes.groups) {
      assert.equal(g.toConfirm, 0);
      assert.equal(g.total, g.current);
      for (const i of g.items) assert.equal(i.state, 'current');
    }
    const aConfirmar = (await c.ler<DecisoesDaPagina>('/api/decisions?state=to_confirm')).corpo;
    assert.deepEqual(aConfirmar.groups.map((g) => [g.title, g.total]), [['feat/42-kanban-de-sessoes', 1], ['feat/42-kanban', 1], ['perf/47-relatorio', 1]]);
    // The old values still read the same on the new route (src/api/legacy-routes.ts).
    assert.deepEqual((await c.ler<DecisoesDaPagina>('/api/decisions?estado=vigentes&agrupar=sessao')).corpo, (await c.ler<DecisoesDaPagina>('/api/decisions?state=current&groupBy=session')).corpo);
    assert.deepEqual(await c.ler('/api/decisions?state=descartada'), { status: 400, corpo: { error: 'state: all, current ou to_confirm' } });
    assert.deepEqual(await c.ler('/api/decisions?groupBy=conta'), { status: 400, corpo: { error: 'groupBy: branch, family ou session' } });
  });

  test('busca sem acento e sem caixa: escolha, alternativas, branch e rótulo', async () => {
    const sqlite = (await c.ler<DecisoesDaPagina>('/api/decisions?q=SQLITE%20em%20memoria')).corpo;
    assert.equal(sqlite.q, 'SQLITE em memoria');
    assert.deepEqual(sqlite.counts.current, 17, 'as contagens não filtram');
    const achadas = sqlite.groups.flatMap((g) => g.items.map((i) => `${g.title} ${i.title}`));
    assert.deepEqual(achadas.sort(), [
      'feat/42-kanban Postgres no Docker nos testes',
      'feat/42-kanban SQLite em memória nos testes',
      'feat/42-kanban-de-sessoes Postgres no Docker nos testes',
      'feat/42-kanban-de-sessoes SQLite em memória nos testes',
    ]);
    const indice = (await c.ler<DecisoesDaPagina>('/api/decisions?q=indice')).corpo;
    assert.deepEqual(indice.groups.flatMap((g) => rotulos(g.items)), ['Índice composto em (mes, conta)']);
    const branch = (await c.ler<DecisoesDaPagina>('/api/decisions?q=refactor/pagamentos')).corpo;
    assert.deepEqual(branch.groups.map((g) => [g.title, g.total]), [['refactor/pagamentos', 5]]);
    const rotulo = (await c.ler<DecisoesDaPagina>('/api/decisions?q=D8')).corpo;
    assert.ok(rotulo.groups.flatMap((g) => g.items).every((i) => i.label === 'D8'));
    assert.equal((await c.ler(`/api/decisions?q=${'x'.repeat(201)}`)).status, 400);
  });

  test('grupo=: o "Ver todas" de um grupo, com todos os itens', async () => {
    const chave = (await c.ler<DecisoesDaPagina>('/api/decisions')).corpo.groups[1]!.key;
    const { corpo } = await c.ler<DecisoesDaPagina>(`/api/decisions?group=${chave}`);
    assert.equal(corpo.groups.length, 1);
    assert.equal(corpo.groups[0]!.title, 'feat/42-kanban');
    assert.equal(corpo.groups[0]!.items.length, 8);
    assert.equal(corpo.groups[0]!.more, 0);
    const vigentes = (await c.ler<DecisoesDaPagina>(`/api/decisions?group=${chave}&state=current`)).corpo;
    assert.equal(vigentes.groups[0]!.items.length, 6);
    assert.equal((await c.ler<DecisoesDaPagina>('/api/decisions?group=b.bmFkYQ')).corpo.groups.length, 0, 'chave que não existe: nenhum grupo');
    assert.deepEqual(await c.ler('/api/decisions?group=%3Cscript%3E'), { status: 400, corpo: { error: 'group inválido' } });
  });
});

describe('C21: a janela de 30 dias das substituídas', () => {
  test('uma substituída há 31 dias não conta; uma há 29, conta', async () => {
    const c = await cenario();
    try {
      const antes = (await c.ler<DecisoesDaPagina>('/api/decisions')).corpo.counts;
      const vigentes = (await c.decisoes.listDecisions({ sessionId: 'sim-panel-motor-de-regras', states: ['current'] })).items;
      assert.ok(vigentes.length >= 3);
      const ha = (dias: number) => new Date(AGORA - dias * 86_400_000).toISOString();
      const nova = vigentes[2]!.id;
      await c.decisoes.putDecision({ ...vigentes[0]!, state: 'superseded', supersededBy: nova, updatedAt: ha(31) });
      await c.decisoes.putDecision({ ...vigentes[1]!, state: 'superseded', supersededBy: nova, updatedAt: ha(29) });
      const depois = (await c.ler<DecisoesDaPagina>('/api/decisions')).corpo.counts;
      assert.equal(depois.current, antes.current - 2);
      assert.equal(depois.superseded30d, antes.superseded30d + 1, 'só a de 29 dias entra');
    } finally {
      await c.fechar();
    }
  });
});

describe('C20: GET /api/sessoes/<id>/decisoes (a aba do Detalhe)', () => {
  let c: Cenario;
  before(async () => {
    c = await cenario();
  });
  after(() => c.fechar());

  test('o escopo família (padrão): todos os itens do escopo, sem o limite do painel, e as contagens', async () => {
    const { status, corpo } = await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions`);
    assert.equal(status, 200);
    assert.equal(corpo.session, VITRINE);
    assert.equal(corpo.scope, 'family');
    assert.equal(corpo.state, 'all');
    assert.deepEqual(corpo.byScope, { session: 6, family: 7, branch: 7 });
    assert.equal(corpo.total, 7);
    assert.equal(corpo.items.length, 8, 'com a substituída');
    const mae = corpo.items.find((i) => i.sessionId === VITRINE_ONTEM)!;
    assert.equal(mae.session, 'parent', 'na aba, relativo à sessão aberta');
    assert.equal(mae.label, 'D1');
    assert.equal(mae.scope, 'family');
    const promovida = corpo.items.find((i) => i.promotedTo)!;
    assert.equal(promovida.title, 'Kanban atualiza por long polling');
    assert.equal(promovida.promotedTo, 'docs/decisoes/0003-kanban-por-long-polling.md');
  });

  test('escopo, estado e busca', async () => {
    const sessao = (await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions?scope=session`)).corpo;
    assert.equal(sessao.total, 6);
    assert.ok(sessao.items.every((i) => i.sessionId === VITRINE));
    const aConfirmar = (await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions?state=to_confirm`)).corpo;
    assert.deepEqual(rotulos(aConfirmar.items), ['Esconder sessões encerradas há mais de 7 dias']);
    assert.equal(aConfirmar.total, 7, 'o total da aba não depende do filtro');
    const busca = (await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions?q=long%20polling`)).corpo;
    assert.deepEqual(rotulos(busca.items), ['Kanban atualiza por long polling']);
    assert.equal((await c.ler(`/api/sessions/${VITRINE}/decisions?escopo=conta`)).status, 400);
    assert.deepEqual(await c.ler(`/api/sessions/${VITRINE}/decisions?state=x`), { status: 400, corpo: { error: 'state: all, current ou to_confirm' } });
    assert.deepEqual((await c.ler(`/api/sessions/${VITRINE}/decisions?estado=a_confirmar`)).corpo, aConfirmar, 'the old value still reads the same');
    assert.equal((await c.ler('/api/sessions/n%C3%A3o-existe/decisions')).status, 400);
    assert.equal((await c.ler('/api/sessions/nao-existe/decisions')).status, 404);
    assert.equal((await c.ler(`/api/sessions/${VITRINE_ONTEM}/decisions`)).status, 200, 'a sessão que só a porta das decisões conhece');
  });

  test('injeção e MCP: ainda não existem; o texto e a conta saem das vigentes do branch', async () => {
    const { corpo } = await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions`);
    assert.equal(corpo.injection.enabled, false);
    assert.equal(corpo.injection.scope, 'branch');
    assert.equal(corpo.injection.decisions, 6);
    const linhas = corpo.injection.text.split('\n');
    assert.equal(linhas[0], 'Decisões vigentes em feat/42-kanban:');
    assert.equal(linhas.length, 7);
    assert.equal(linhas[1], '- Cards só leitura, sem arrastar (D1)', 'da mais antiga para a mais nova');
    assert.ok(linhas.includes('- SQLite em memória nos testes (D7, substituiu D3)'));
    assert.equal(corpo.injection.tokens, Math.ceil(corpo.injection.text.length / 4));
    assert.equal(corpo.mcp.tool, 'session_decisions');
    assert.equal(corpo.mcp.exists, false);
    assert.equal(corpo.mcp.call, 'session_decisions branch: "feat/42-kanban"');
    assert.match(corpo.mcp.response, /6 vigentes/);
    assert.match(corpo.mcp.response, /D7 substituiu D3/);

    const esta = (await c.ler<DecisoesDaAba>(`/api/sessions/${PANEL_SESSION}/decisions`)).corpo;
    assert.match(esta.injection.text, /^Decisões vigentes em feat\/42-kanban-de-sessoes:\n/);
  });
});

describe('a aba e as escritas: o mesmo alvo do Confirmar do painel', () => {
  test('aba e Promover pedem o alvo ao montador, e enxergam as decisões que o painel enxerga', async () => {
    const pedidos: [string, unknown][] = [];
    let montador: MontadorDoPainel | null = null;
    const c = await cenario({
      alvoDe: async (id) => {
        const alvo = await montador!.alvoDaSessao(id);
        pedidos.push([id, alvo]);
        return alvo;
      },
    });
    montador = c.montador;
    try {
      const aba = (await c.ler<DecisoesDaAba>(`/api/sessions/${VITRINE}/decisions?scope=branch`)).corpo;
      const d = aba.items.find((i) => i.state === 'current')!;
      assert.equal((await c.postar(`/api/decisions/${d.id}/promote`, { session: VITRINE })).status, 200);
      const esperado = await c.montador.alvoDaSessao(VITRINE);
      assert.deepEqual(esperado, { sessionId: VITRINE, branch: 'feat/42-kanban', repo: '/simulacao/vitrine-demo', contaId: esperado.contaId });
      assert.deepEqual(pedidos, [[VITRINE, esperado], [VITRINE, esperado]], 'a aba e o Promover, pelo montador');
      const doPainel = (await c.montador.listaDeDecisoes({ sessionId: VITRINE }, 'branch'))!;
      assert.deepEqual(doPainel.byScope, aba.byScope, 'o painel (o alvo do Confirmar) conta o mesmo que a aba');
    } finally {
      await c.fechar();
    }
  });
});

describe('a própria /ui escreve nas decisões (exceção de origem, decisão 0003)', () => {
  let c: Cenario;
  before(async () => {
    c = await cenario();
  });
  after(() => c.fechar());

  const sugeridaDe = async (sessionId: string) => (await c.decisoes.listDecisions({ sessionId, states: ['to_confirm'] })).items[0]!;

  test('Origin igual a http://<Host>, caminho exato e JSON: passa; o resto, 403 ou 415', async () => {
    const nossa = { ...JSON_, origin: `http://${c.host}` };
    const d = await sugeridaDe(VITRINE);
    const ok = await c.postar<{ decision: DecisaoDaUi }>(`/api/decisions/${d.id}/confirm`, { session: VITRINE }, nossa);
    assert.equal(ok.status, 200);
    assert.equal((await c.decisoes.getDecision(d.id))?.state, 'current');

    const outra = await sugeridaDe('sim-panel-painel-de-metricas');
    for (const origin of ['http://evil.example', `https://${c.host}`, 'null', 'http://localhost:1', `http://${c.host}.exemplo.com`]) {
      assert.equal((await c.postar(`/api/decisoes/${outra.id}/descartar`, { sessao: 'sim-panel-painel-de-metricas' }, { ...JSON_, origin })).status, 403, origin);
    }
    assert.equal((await c.postar(`/api/decisoes/${outra.id}/descartar?x=1`, { sessao: 'sim-panel-painel-de-metricas' }, nossa)).status, 403, 'query na URL');
    assert.equal((await c.postar(`/api/decisoes/${outra.id}/descartar`, { sessao: 'sim-panel-painel-de-metricas' }, { 'content-type': 'text/plain', origin: `http://${c.host}` })).status, 415);
    assert.equal((await c.decisoes.getDecision(outra.id))?.state, 'to_confirm', 'nada mudou');

    // O promover também é da exceção; o resto das escritas e dos hooks, não.
    assert.equal((await c.postar(`/api/decisoes/${outra.id}/promover`, { sessao: 'sim-panel-painel-de-metricas' }, nossa)).status, 200);
    assert.equal((await c.postar(`/api/decisoes/${outra.id}/apagar`, { sessao: 'x' }, nossa)).status, 403);
    const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    assert.equal((await c.postar('/api/hooks', hook, nossa)).status, 403);
  });

  test('o id da exceção começa por alfanumérico: ".." e "..." no lugar do id dão 403', async () => {
    // Pelo http cru: o fetch normalizaria o "..".
    const cru = (caminho: string) =>
      new Promise<number>((resolve, reject) => {
        const [hostname, port] = c.host.split(':');
        const r = request({ hostname, port: Number(port), path: caminho, method: 'POST', headers: { ...JSON_, origin: `http://${c.host}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end(JSON.stringify({ sessao: VITRINE }));
      });
    for (const caminho of ['/api/decisoes/../confirmar', '/api/decisoes/.../confirmar', '/api/decisoes/.x/promover', '/api/decisoes/-x/descartar']) {
      assert.equal(await cru(caminho), 403, caminho);
    }
  });

  test('leitura: a própria /ui lê; outro Origin, não', async () => {
    assert.equal((await c.ler('/api/decisions', { origin: `http://${c.host}` })).status, 200);
    assert.equal((await c.ler(`/api/sessions/${VITRINE}/decisions`, { origin: `http://${c.host}` })).status, 200);
    assert.equal((await c.ler('/api/decisions', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await c.ler(`/api/sessions/${VITRINE}/decisions`, { origin: 'http://evil.example' })).status, 403);
  });
});

describe('POST /api/decisoes/<id>/promover', () => {
  const pastas: string[] = [];
  const pasta = async () => {
    const p = await mkdtemp(join(tmpdir(), 'ahrena-promover-'));
    pastas.push(p);
    return p;
  };
  after(async () => {
    for (const p of pastas) await rm(p, { recursive: true, force: true });
  });

  async function comRepo(c: Cenario, sessionId: string, repo: string | null) {
    return (
      await registerDecision(
        c.decisoes,
        {
          sourceKey: `teste:${sessionId}`, sessionId, repo, branch: 'feat/9-relatorio', topic: 'relatorio:indice',
          context: 'A consulta do relatório mensal varre a tabela inteira. Qual índice?',
          choice: 'Índice composto em (mês, conta)', alternatives: ['view materializada', 'sem índice'],
          decidedBy: 'user', origin: 'question', inferred: false, decidedAt: new Date(AGORA - 5 * 60_000).toISOString(),
        },
        T0,
      )
    ).decision;
  }

  async function repoComRegistros() {
    const repo = await pasta();
    await mkdir(join(repo, 'docs', 'decisoes'), { recursive: true });
    await writeFile(join(repo, 'docs', 'decisoes', '0001-primeira.md'), '# 0001 · Primeira\n');
    await writeFile(join(repo, 'docs', 'decisoes', '0007-setima.md'), '# 0007 · Sétima\n');
    return repo;
  }

  test('o rascunho não grava nada; só o confirmar grava, uma vez, e marca a decisão', async () => {
    const c = await cenario();
    try {
      const repo = await repoComRegistros();
      const d = await comRepo(c, 'teste-promover', repo);
      const rota = `/api/decisoes/${d.id}/promover`;

      const r = await c.postar<{ rascunho: RascunhoAntigo }>(rota, { sessao: 'teste-promover' });
      assert.equal(r.status, 200);
      const { rascunho } = r.corpo;
      assert.equal(rascunho.caminho, 'docs/decisoes/0008-indice-composto-em-mes-conta.md');
      assert.equal(rascunho.repo, repo);
      assert.equal(rascunho.podeGravar, true);
      assert.equal(rascunho.motivo, null);
      assert.match(rascunho.markdown, /^# 0008 · Índice composto em \(mês, conta\)\n/);
      assert.match(rascunho.markdown, /\*\*Status:\*\* aceita/);
      assert.match(rascunho.markdown, /\*\*Data:\*\* 2026-11-02/);
      assert.match(rascunho.markdown, /## Contexto\n\nA consulta do relatório mensal varre a tabela inteira\. Qual índice\?/);
      assert.match(rascunho.markdown, /## Alternativas consideradas\n\n- view materializada\n- sem índice/);
      assert.match(rascunho.markdown, /\/ui\/sessions\/teste-promover/);
      // Com caminho mas sem confirmar: continua rascunho.
      assert.equal((await c.postar(rota, { sessao: 'teste-promover', caminho: rascunho.caminho })).status, 200);
      assert.equal((await c.postar(rota, { sessao: 'teste-promover', confirmar: 'sim', caminho: rascunho.caminho })).status, 200);
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, null);

      // Caminhos recusados: nada é gravado.
      for (const caminho of [
        '../fora.md', 'docs/decisoes/../../fora.md', 'docs/decisoes/../0008-x.md', '/etc/0008-x.md', join(repo, 'docs/decisoes/0008-x.md'),
        'docs/outra/0008-x.md', 'docs\\decisoes\\0008-x.md', 'docs/decisoes/8-x.md', 'docs/decisoes/0008-x.txt', 'docs/decisoes/sub/0008-x.md', 42,
      ]) {
        assert.equal((await c.postar(rota, { sessao: 'teste-promover', confirmar: true, caminho })).status, 400, String(caminho));
      }
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);

      // Arquivo que já existe: 409, sem sobrescrever.
      assert.equal((await c.postar(rota, { sessao: 'teste-promover', confirmar: true, caminho: 'docs/decisoes/0007-setima.md' })).status, 409);
      assert.equal(await readFile(join(repo, 'docs', 'decisoes', '0007-setima.md'), 'utf8'), '# 0007 · Sétima\n');
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, null);

      // The new route: `{ session, confirm, path }` → `{ decision, path }` (the old route above answers the old keys).
      const feito = await c.postar<{ decision: DecisaoDaUi; path: string }>(`/api/decisions/${d.id}/promote`, { session: 'teste-promover', confirm: true, path: rascunho.caminho });
      assert.equal(feito.status, 201);
      assert.equal(feito.corpo.path, rascunho.caminho);
      assert.equal(feito.corpo.decision.promotedTo, rascunho.caminho);
      assert.equal(await readFile(join(repo, rascunho.caminho), 'utf8'), rascunho.markdown);
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, rascunho.caminho, 'markPromoted');

      const depois = (await c.postar<{ rascunho: RascunhoAntigo }>(rota, { sessao: 'teste-promover' })).corpo.rascunho;
      assert.equal(depois.podeGravar, false);
      assert.match(depois.motivo!, /já promovida/);
      assert.equal((await c.postar(rota, { sessao: 'teste-promover', confirmar: true, caminho: 'docs/decisoes/0009-de-novo.md' })).status, 409);

      assert.equal((await c.postar(rota, { sessao: 'outra-sessao' })).status, 404, 'a sessão não enxerga a decisão');
      const novo = `/api/decisions/${d.id}/promote`;
      const rascunhoNovo = await c.postar<{ draft: Record<string, unknown> }>(novo, { session: 'teste-promover' });
      assert.deepEqual(Object.keys(rascunhoNovo.corpo.draft), ['path', 'markdown', 'hash', 'repo', 'canWrite', 'reason']);
      assert.deepEqual(await c.postar(novo, {}), { status: 400, corpo: { error: 'informe a sessão: { "session": "<id>" }' } });
      assert.deepEqual(await c.postar(rota, {}), { status: 400, corpo: { error: 'informe a sessão: { "sessao": "<id>" }' } }, 'the old route cites the old key');
      assert.deepEqual(await c.postar(novo, { session: 'teste-promover', confirm: true }), { status: 400, corpo: { error: 'informe o path: "docs/decisoes/NNNN-slug.md"' } });
      assert.deepEqual(await c.postar(rota, { sessao: 'teste-promover', confirmar: true }), { status: 400, corpo: { error: 'informe o caminho: "docs/decisoes/NNNN-slug.md"' } });
      assert.equal((await c.postar(rota, { sessao: 'teste-promover' }, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await c.postar(rota, 'não é json')).status, 400);
    } finally {
      await c.fechar();
    }
  });

  test('sem repo, sem docs/decisoes ou com docs/decisoes saindo do repo por symlink: não grava', async () => {
    const c = await cenario();
    try {
      const semRepo = await comRepo(c, 'teste-sem-repo', null);
      const r1 = (await c.postar<{ rascunho: RascunhoAntigo }>(`/api/decisoes/${semRepo.id}/promover`, { sessao: 'teste-sem-repo' })).corpo.rascunho;
      assert.equal(r1.podeGravar, false);
      assert.equal(r1.repo, null);
      assert.ok(r1.motivo);
      assert.equal((await c.postar(`/api/decisoes/${semRepo.id}/promover`, { sessao: 'teste-sem-repo', confirmar: true, caminho: r1.caminho })).status, 409);

      const vazio = await pasta();
      const semPasta = await comRepo(c, 'teste-sem-pasta', vazio);
      const r2 = (await c.postar<{ rascunho: RascunhoAntigo }>(`/api/decisoes/${semPasta.id}/promover`, { sessao: 'teste-sem-pasta' })).corpo.rascunho;
      assert.equal(r2.podeGravar, false);
      assert.match(r2.motivo!, /docs\/decisoes/);
      assert.equal((await c.postar(`/api/decisoes/${semPasta.id}/promover`, { sessao: 'teste-sem-pasta', confirmar: true, caminho: r2.caminho })).status, 409);
      assert.deepEqual(await readdir(vazio), []);

      const repo = await pasta();
      const fora = await pasta();
      await mkdir(join(repo, 'docs'));
      await symlink(fora, join(repo, 'docs', 'decisoes'));
      const comLink = await comRepo(c, 'teste-symlink', repo);
      const r3 = (await c.postar<{ rascunho: RascunhoAntigo }>(`/api/decisoes/${comLink.id}/promover`, { sessao: 'teste-symlink' })).corpo.rascunho;
      assert.equal(r3.podeGravar, false);
      assert.equal((await c.postar(`/api/decisoes/${comLink.id}/promover`, { sessao: 'teste-symlink', confirmar: true, caminho: r3.caminho })).status, 400);
      assert.deepEqual(await readdir(fora), []);

      // O arquivo de destino como symlink para fora: a flag `wx` recusa (já existe).
      const repo2 = await repoComRegistros();
      const alvo = join(fora, 'alvo.md');
      await writeFile(alvo, 'intacto\n');
      await symlink(alvo, join(repo2, 'docs', 'decisoes', '0008-indice-composto-em-mes-conta.md'));
      const comArquivo = await comRepo(c, 'teste-symlink-arquivo', repo2);
      const r4 = await c.postar(`/api/decisoes/${comArquivo.id}/promover`, { sessao: 'teste-symlink-arquivo', confirmar: true, caminho: 'docs/decisoes/0008-indice-composto-em-mes-conta.md' });
      assert.equal(r4.status, 409);
      assert.equal(await readFile(alvo, 'utf8'), 'intacto\n');
      assert.equal((await c.decisoes.getDecision(comArquivo.id))?.promotedTo, null);
    } finally {
      await c.fechar();
    }
  });

  test('descartada ou revertida não vira registro: 409, no rascunho e no confirmar', async () => {
    const c = await cenario();
    try {
      const repo = await repoComRegistros();
      for (const state of ['dismissed', 'reverted'] as const) {
        const d = await comRepo(c, `teste-${state}`, repo);
        await c.decisoes.putDecision({ ...d, state });
        const rota = `/api/decisoes/${d.id}/promover`;
        const r = await c.postar<{ error: string }>(rota, { sessao: `teste-${state}` });
        assert.equal(r.status, 409, state);
        assert.match(r.corpo.error, new RegExp(state));
        assert.equal((await c.postar(rota, { sessao: `teste-${state}`, confirmar: true, caminho: 'docs/decisoes/0008-x.md' })).status, 409, state);
      }
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);
    } finally {
      await c.fechar();
    }
  });

  test('um número que já existe com outro slug: 409, nada gravado', async () => {
    const c = await cenario();
    try {
      const repo = await repoComRegistros();
      const d = await comRepo(c, 'teste-numero', repo);
      const r = await c.postar<{ error: string }>(`/api/decisoes/${d.id}/promover`, { sessao: 'teste-numero', confirmar: true, caminho: 'docs/decisoes/0007-outra.md' });
      assert.equal(r.status, 409);
      assert.match(r.corpo.error, /0007-setima\.md/);
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, null);
    } finally {
      await c.fechar();
    }
  });

  test('repo relativo: 409; docs/decisoes symlink, mesmo para dentro do repo: 400', async () => {
    const c = await cenario();
    try {
      const relativo = await comRepo(c, 'teste-relativo', 'simulacao/relativo');
      const r1 = (await c.postar<{ rascunho: RascunhoAntigo }>(`/api/decisoes/${relativo.id}/promover`, { sessao: 'teste-relativo' })).corpo.rascunho;
      assert.equal(r1.podeGravar, false);
      assert.match(r1.motivo!, /absoluta/);
      assert.equal((await c.postar(`/api/decisoes/${relativo.id}/promover`, { sessao: 'teste-relativo', confirmar: true, caminho: r1.caminho })).status, 409);

      const repo = await pasta();
      await mkdir(join(repo, 'docs', 'de-verdade'), { recursive: true });
      await symlink(join(repo, 'docs', 'de-verdade'), join(repo, 'docs', 'decisoes'));
      const d = await comRepo(c, 'teste-symlink-dentro', repo);
      const r2 = (await c.postar<{ rascunho: RascunhoAntigo }>(`/api/decisoes/${d.id}/promover`, { sessao: 'teste-symlink-dentro' })).corpo.rascunho;
      assert.equal(r2.podeGravar, false);
      assert.match(r2.motivo!, /symlink/);
      assert.equal((await c.postar(`/api/decisoes/${d.id}/promover`, { sessao: 'teste-symlink-dentro', confirmar: true, caminho: r2.caminho })).status, 400);
      assert.deepEqual(await readdir(join(repo, 'docs', 'de-verdade')), []);
    } finally {
      await c.fechar();
    }
  });

  test('se a marca (markPromoted) falha depois de gravar, o arquivo é apagado', async () => {
    const c = await cenario();
    try {
      const repo = await repoComRegistros();
      const d = await comRepo(c, 'teste-marca', repo);
      const falha = new Proxy(c.decisoes, {
        get(alvo, k) {
          if (k === 'putDecision') return async () => Promise.reject(new Error('a porta caiu'));
          const v = Reflect.get(alvo, k) as unknown;
          return typeof v === 'function' ? v.bind(alvo) : v;
        },
      });
      const ui = new DecisoesDaUi({ ...c.opcoes, decisions: falha });
      await assert.rejects(ui.promover(d.id, 'teste-marca', { confirm: true, path: 'docs/decisoes/0008-indice.md' }), /a porta caiu/);
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, null);
    } finally {
      await c.fechar();
    }
  });

  test('o hash do rascunho: o confirmar com ele grava; se o registro mudou, 409; mal formado, 400', async () => {
    const c = await cenario();
    try {
      const repo = await repoComRegistros();
      const d = await comRepo(c, 'teste-hash', repo);
      const rota = `/api/decisoes/${d.id}/promover`;
      const { rascunho } = (await c.postar<{ rascunho: RascunhoAntigo }>(rota, { sessao: 'teste-hash' })).corpo;
      assert.equal(rascunho.hash, createHash('sha256').update(rascunho.markdown).digest('hex'));
      const gravar = { sessao: 'teste-hash', confirmar: true, caminho: rascunho.caminho };
      for (const hash of ['x', 42, 'AB'.repeat(32)]) assert.equal((await c.postar(rota, { ...gravar, hash })).status, 400, String(hash));

      // A decisão mudou depois do rascunho: o markdown regerado não é o que a pessoa leu.
      await c.decisoes.putDecision({ ...(await c.decisoes.getDecision(d.id))!, context: 'Outro contexto.' });
      const mudou = await c.postar<{ error: string }>(rota, { ...gravar, hash: rascunho.hash });
      assert.equal(mudou.status, 409);
      assert.match(mudou.corpo.error, /o rascunho mudou, abra de novo/);
      assert.deepEqual((await readdir(join(repo, 'docs', 'decisoes'))).sort(), ['0001-primeira.md', '0007-setima.md']);

      const { rascunho: novo } = (await c.postar<{ rascunho: RascunhoAntigo }>(rota, { sessao: 'teste-hash' })).corpo;
      assert.notEqual(novo.hash, rascunho.hash);
      assert.equal((await c.postar(rota, { ...gravar, hash: novo.hash })).status, 201);
      assert.equal(await readFile(join(repo, novo.caminho), 'utf8'), novo.markdown);
    } finally {
      await c.fechar();
    }
  });

  test('a gravação é injetável: recebe o destino dentro do repo e o markdown', async () => {
    const gravados: [string, string][] = [];
    const c = await cenario({ escrever: async (destino, texto) => void gravados.push([destino, texto]) });
    try {
      const repo = await repoComRegistros();
      const d = await comRepo(c, 'teste-injetado', repo);
      const feito = await c.postar<{ caminho: string }>(`/api/decisoes/${d.id}/promover`, { sessao: 'teste-injetado', confirmar: true, caminho: 'docs/decisoes/0008-indice.md' });
      assert.equal(feito.status, 201);
      assert.equal(gravados.length, 1);
      assert.ok(gravados[0]![0].endsWith(join('docs', 'decisoes', '0008-indice.md')));
      assert.match(gravados[0]![1], /^# 0008 · Índice composto/);
      assert.equal((await c.decisoes.getDecision(d.id))?.promotedTo, 'docs/decisoes/0008-indice.md');
    } finally {
      await c.fechar();
    }
  });
});
