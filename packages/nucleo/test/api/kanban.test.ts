// O Kanban só leitura (#31): a rota `GET /api/kanban` nas duas visões (sessões e agentes), com
// dados do simulador.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import { readSessionAttention, type SessionAttention } from '../../src/api/attention.ts';
import { ResumosDeSessao } from '../../src/api/summary.ts';
import {
  COLUNAS_DOS_AGENTES,
  COLUNAS_DAS_SESSOES,
  colunaDaSessao,
  colunaDoAgente,
  pedidoDoKanban,
  QuadroKanban,
  rotuloDoModelo,
  type CardDeAgente,
  type CardDeSessao,
  type KanbanHttp,
} from '../../src/api/kanban.ts';
import { displayStatus, type Agent, type Session } from '../../src/model.ts';
import { simulate } from '../../src/simulator/index.ts';
import { seedPanelScenario } from '../../src/simulator/panel.ts';

const AGORA = Date.parse('2026-05-01T12:00:00.000Z');

function pedir(url: string, caminho: string): Promise<{ status: number; corpo: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: texto }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('#31 GET /api/kanban com o simulador', () => {
  let storage: SqliteStorage;
  let quadro: QuadroKanban;
  let sessoes: Session[];
  let agentes: Agent[];
  /** #245: the attention of each session, by the same rule as the route's. */
  let atencao: Map<string, SessionAttention | null>;
  let api: LocalApi;
  const get = async (caminho: string) => {
    const r = await pedir(api.url, caminho);
    return { status: r.status, corpo: JSON.parse(r.corpo) as KanbanHttp & { error?: string }, texto: r.corpo };
  };
  // Todos os itens de uma coluna, página a página, pela rota.
  const colunaInteira = async (visao: string, coluna: string) => {
    const itens: unknown[] = [];
    for (let pagina = 1; ; pagina++) {
      const { corpo } = await get(`/api/kanban?view=${visao}&column=${coluna}&page=${pagina}`);
      itens.push(...corpo.columns[0].items);
      if (!corpo.columns[0].hasMore) return { itens, total: corpo.columns[0].total };
    }
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await simulate(storage, { seed: 31, sessions: 60, chaos: true, prices: true, now: () => AGORA });
    await seedPanelScenario(storage, 'p4', AGORA);
    sessoes = (await storage.listSessions({ limit: 500 })).items;
    agentes = (await Promise.all(sessoes.map((s) => storage.listAgents(s.id)))).flat();
    const resumos = new ResumosDeSessao(storage, { agora: () => AGORA, maximo: 500 });
    atencao = new Map();
    for (const s of sessoes) atencao.set(s.id, await readSessionAttention(s, await storage.listAgents(s.id), resumos));
    const contas = new Accounts({ storage, file: null });
    quadro = new QuadroKanban({ storage, contas, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, kanban: quadro });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('o simulador deu sessões de todo status e subagentes', () => {
    const status = new Set(sessoes.map(displayStatus));
    for (const s of ['active', 'waiting', 'completed', 'error', 'abandoned']) assert.ok(status.has(s as never), `falta ${s}`);
    assert.ok(agentes.some((a) => a.type === 'subagent'));
  });

  test('#245 sem visão é a de sessões: as cinco colunas do wireframe, na ordem, com rótulos', async () => {
    const { status, corpo } = await get('/api/kanban');
    assert.equal(status, 200);
    assert.equal(corpo.view, 'sessions');
    assert.equal(corpo.perPage, 10);
    assert.deepEqual(
      corpo.columns.map((c) => [c.id, c.label]),
      [
        ['active', 'Ativas'],
        ['blocked', 'Precisam de você'],
        ['idle', 'Ociosas'],
        ['completed', 'Concluídas'],
        ['abandoned', 'Abandonadas'],
      ],
    );
    assert.deepEqual(COLUNAS_DAS_SESSOES.map((c) => c.id), corpo.columns.map((c) => c.id));
  });

  test('visão sessões: cada total bate com as sessões daquele status e atenção, e os cards são da coluna', async () => {
    const { corpo } = await get('/api/kanban?view=sessions');
    const colunaDe = (s: Session) => colunaDaSessao(displayStatus(s), atencao.get(s.id) ?? null);
    let soma = 0;
    for (const c of corpo.columns) {
      const esperado = sessoes.filter((s) => colunaDe(s) === c.id).length;
      assert.equal(c.total, esperado, c.id);
      assert.equal(c.page, 1);
      assert.equal(c.items.length, Math.min(10, esperado), c.id);
      assert.equal(c.hasMore, esperado > 10, c.id);
      for (const card of c.items as CardDeSessao[]) {
        assert.equal(colunaDaSessao(card.status, card.attention), c.id, card.id);
        assert.deepEqual(card.attention, atencao.get(card.id), card.id);
      }
      soma += c.total;
    }
    assert.equal(soma, sessoes.length);
    assert.ok(corpo.columns.find((c) => c.id === 'blocked')!.total > 0, 'o simulador tem sessões que precisam de você');
    assert.ok(corpo.columns.find((c) => c.id === 'idle')!.total > 0, 'e ociosas');
  });

  test('o card de sessão: título, motivo só esperando, pedido sem quebra de linha, modelo legível, conta sem id', async () => {
    const { corpo, texto } = await get('/api/kanban');
    const cards = corpo.columns.flatMap((c) => c.items as CardDeSessao[]);
    assert.ok(cards.length > 0);
    for (const c of cards) {
      assert.ok(c.title.length > 0 && c.title.length <= 60, c.id);
      if (c.status === 'waiting') assert.ok(c.reason !== null, c.id);
      else assert.equal(c.reason, null, c.id);
      assert.equal(c.running, c.status === 'active' || c.status === 'waiting');
      assert.ok(c.durationMs >= 0);
      if (c.lastPrompt !== null) {
        assert.ok(c.lastPrompt.length <= 120, c.lastPrompt);
        assert.doesNotMatch(c.lastPrompt, /[\n\r]/);
      }
      assert.ok(c.agents >= 1, c.id);
      if (c.model !== null) assert.doesNotMatch(c.model, /^claude-/, c.model);
      assert.ok(c.costUsd === null || c.costUsd >= 0);
      if (c.account) assert.deepEqual(Object.keys(c.account).sort(), ['color', 'label']);
    }
    assert.ok(cards.some((c) => c.lastPrompt !== null), 'o simulador grava prompts');
    // Nenhum id de conta nem de org, em parte alguma da resposta (decisão 0006).
    for (const s of sessoes) {
      if (!s.accountId) continue;
      for (const pedaco of s.accountId.split('/')) assert.ok(!texto.includes(pedaco), 'id de conta na resposta');
    }
  });

  test('itens pela atividade mais recente primeiro', async () => {
    const { corpo } = await get('/api/kanban');
    for (const c of corpo.columns) {
      const datas = c.items.map((i) => i.lastActivity);
      assert.deepEqual(datas, [...datas].sort().reverse(), c.id);
    }
  });

  test('10 por página: a página 2 de uma coluna traz o resto, sem repetir', async () => {
    const { corpo } = await get('/api/kanban');
    const grande = corpo.columns.find((c) => c.hasMore);
    assert.ok(grande, 'alguma coluna com mais de 10');
    const p2 = await get(`/api/kanban?view=sessions&column=${grande.id}&page=2`);
    assert.equal(p2.status, 200);
    assert.equal(p2.corpo.columns.length, 1);
    const [c2] = p2.corpo.columns;
    assert.equal(c2.id, grande.id);
    assert.equal(c2.page, 2);
    assert.equal(c2.total, grande.total);
    assert.equal(c2.items.length, Math.min(10, grande.total - 10));
    assert.equal(c2.hasMore, grande.total > 20);
    const ids1 = new Set(grande.items.map((i) => i.id));
    for (const i of c2.items) assert.ok(!ids1.has(i.id), `repetido: ${i.id}`);
    const { itens, total } = await colunaInteira('sessions', grande.id);
    assert.equal(itens.length, total);
  });

  test('só a coluna, na página 1 por padrão; página além do fim vem vazia', async () => {
    const { corpo } = await get('/api/kanban?column=abandoned');
    assert.equal(corpo.columns.length, 1);
    assert.equal(corpo.columns[0].id, 'abandoned');
    assert.equal(corpo.columns[0].page, 1);
    // The old parameter names and values still read the same (src/api/legacy-routes.ts).
    assert.deepEqual((await get('/api/kanban?coluna=abandonada')).corpo, corpo);
    const alem = await get('/api/kanban?column=abandoned&page=999');
    assert.equal(alem.status, 200);
    assert.deepEqual(alem.corpo.columns[0].items, []);
    assert.equal(alem.corpo.columns[0].hasMore, false);
  });

  test('#245 visão agentes: as cinco colunas do wireframe, na ordem, com rótulos', async () => {
    const { status, corpo } = await get('/api/kanban?view=agents');
    assert.equal(status, 200);
    assert.equal(corpo.view, 'agents');
    assert.deepEqual(
      corpo.columns.map((c) => [c.id, c.label]),
      [
        ['working', 'Trabalhando'],
        ['blocked', 'Precisam de você'],
        ['idle', 'Ociosos'],
        ['done', 'Concluídos'],
        ['error', 'Erro'],
      ],
    );
    assert.deepEqual((await get('/api/kanban?visao=agentes')).corpo, corpo, 'the old view value');
    assert.deepEqual(COLUNAS_DOS_AGENTES.map((c) => c.id), corpo.columns.map((c) => c.id));
  });

  test('visão agentes: um principal por sessão e cada subagente; os totais somam tudo', async () => {
    const { corpo } = await get('/api/kanban?view=agents');
    const subagentes = agentes.filter((a) => a.type === 'subagent');
    const soma = corpo.columns.reduce((n, c) => n + c.total, 0);
    assert.equal(soma, sessoes.length + subagentes.length);
    // Os totais batem com a regra de status, coluna a coluna.
    const porSessao = new Map(sessoes.map((s) => [s.id, s]));
    const esperado = new Map<string, number>();
    for (const s of sessoes) {
      const k = colunaDoAgente(displayStatus(s), atencao.get(s.id) ?? null);
      esperado.set(k, (esperado.get(k) ?? 0) + 1);
    }
    for (const a of subagentes) {
      const k = colunaDoAgente(QuadroKanban.statusDoSubagente(a, porSessao.get(a.sessionId)!));
      esperado.set(k, (esperado.get(k) ?? 0) + 1);
    }
    for (const c of corpo.columns) assert.equal(c.total, esperado.get(c.id) ?? 0, c.id);
    assert.ok(corpo.columns.find((c) => c.id === 'done')!.total > 0);
  });

  test('o card de agente: id único, principal com o título, subagente com o tipo', async () => {
    const todos: CardDeAgente[] = [];
    for (const c of COLUNAS_DOS_AGENTES) todos.push(...((await colunaInteira('agents', c.id)).itens as CardDeAgente[]));
    assert.equal(new Set(todos.map((a) => a.id)).size, todos.length, 'ids únicos');
    const principais = todos.filter((a) => a.main);
    assert.equal(principais.length, sessoes.length);
    for (const p of principais) {
      assert.equal(p.id, p.sessionId);
      assert.equal(p.name, 'Agente principal');
      assert.ok(p.description.length > 0);
    }
    for (const s of todos.filter((a) => !a.main)) {
      assert.ok(s.id.startsWith(`${s.sessionId}:`), s.id);
      assert.ok(s.name.length > 0 && s.name !== 'Agente principal', s.name);
      assert.equal(s.running, s.status === 'active' || s.status === 'waiting');
      if (s.status !== 'waiting') assert.equal(s.reason, null);
    }
  });

  test('regras de status do agente', () => {
    assert.equal(colunaDoAgente('active'), 'working');
    assert.equal(colunaDoAgente('waiting', { level: 'blocked', reason: 'permission' }), 'blocked');
    assert.equal(colunaDoAgente('waiting', { level: 'idle', reason: 'turn_ended' }), 'idle');
    assert.equal(colunaDoAgente('waiting', null), 'working', 'delegating: it is not your turn');
    assert.equal(colunaDoAgente('error', { level: 'blocked', reason: 'error' }), 'error');
    assert.equal(colunaDoAgente('completed'), 'done');
    assert.equal(colunaDoAgente('abandoned'), 'done');
    assert.equal(colunaDoAgente('error'), 'error');
    const sessao = { status: 'active', awaitingInputSince: null } as Session;
    const sub = (status: Agent['status']) => ({ status }) as Agent;
    assert.equal(QuadroKanban.statusDoSubagente(sub('working'), sessao), 'active');
    assert.equal(QuadroKanban.statusDoSubagente(sub('completed'), sessao), 'completed');
    assert.equal(QuadroKanban.statusDoSubagente(sub('error'), sessao), 'error');
    // Sessão esperando: o subagente que não terminou ainda roda.
    assert.equal(QuadroKanban.statusDoSubagente(sub('working'), { ...sessao, awaitingInputSince: '2026-05-01T11:00:00.000Z' }), 'active');
    // Sessão encerrada: o que não terminou segue a sessão.
    assert.equal(QuadroKanban.statusDoSubagente(sub('working'), { ...sessao, status: 'abandoned' }), 'abandoned');
    assert.equal(QuadroKanban.statusDoSubagente(sub('working'), { ...sessao, status: 'error' }), 'error');
    assert.equal(QuadroKanban.statusDoSubagente(sub('working'), { ...sessao, status: 'completed' }), 'completed');
  });

  test('rótulo do modelo: o nome da tabela de preços sem "Claude"; desconhecido fica cru', () => {
    assert.equal(rotuloDoModelo('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(rotuloDoModelo('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.equal(rotuloDoModelo('claude-opus-5-5[1m]'), 'Opus 5.5');
    assert.equal(rotuloDoModelo('modelo-x'), 'modelo-x');
    assert.equal(rotuloDoModelo(null), null);
  });

  test('400 para visão, coluna e página inválidas, citando o parâmetro novo', async () => {
    const errors: [string, string][] = [
      ['view=quadro', 'view: um de sessions, agents'],
      ['view=agents&column=active', 'column: uma de working, blocked, idle, done, error'],
      ['column=working', 'column: uma de active, blocked, idle, completed, abandoned'],
      ['column=waiting', 'column: uma de active, blocked, idle, completed, abandoned'],
      ['page=2', 'page: só com column'],
      ['column=active&page=0', 'page: um inteiro a partir de 1'],
    ];
    for (const [q, error] of errors) assert.deepEqual(await get(`/api/kanban?${q}`), { status: 400, corpo: { error }, texto: JSON.stringify({ error }) }, q);
    for (const q of [
      'visao=quadro',
      'visao=agentes&coluna=ativa',
      'visao=sessoes&coluna=trabalhando',
      'coluna=nada',
      'coluna=ativa&pagina=0',
      'coluna=ativa&pagina=1.5',
      'coluna=ativa&pagina=abc',
      'pagina=2',
    ]) {
      const { status, corpo } = await get(`/api/kanban?${q}`);
      assert.equal(status, 400, q);
      assert.equal(typeof corpo.error, 'string', q);
    }
    assert.throws(() => pedidoDoKanban(new URL('http://x/api/kanban?page=1')));
  });
});
