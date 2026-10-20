// O Kanban só leitura (#31): a rota `GET /api/kanban` nas duas visões (sessões e agentes), com
// dados do simulador.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import {
  COLUNAS_DOS_AGENTES,
  COLUNAS_DAS_SESSOES,
  colunaDoAgente,
  pedidoDoKanban,
  QuadroKanban,
  rotuloDoModelo,
  type CardDeAgente,
  type CardDeSessao,
  type KanbanHttp,
} from '../../src/api/kanban.ts';
import { displayStatus, type Agent, type Session } from '../../src/model.ts';
import { simular } from '../../src/simulador/index.ts';
import { semearCenariosDoPainel } from '../../src/simulador/painel.ts';

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

const COLUNA_DA_SESSAO = { active: 'ativa', waiting: 'esperando', completed: 'concluida', error: 'erro', abandoned: 'abandonada' } as const;

describe('#31 GET /api/kanban com o simulador', () => {
  let storage: SqliteStorage;
  let quadro: QuadroKanban;
  let sessoes: Session[];
  let agentes: Agent[];
  let api: ApiLocal;
  const get = async (caminho: string) => {
    const r = await pedir(api.url, caminho);
    return { status: r.status, corpo: JSON.parse(r.corpo) as KanbanHttp & { error?: string }, texto: r.corpo };
  };
  // Todos os itens de uma coluna, página a página, pela rota.
  const colunaInteira = async (visao: string, coluna: string) => {
    const itens: unknown[] = [];
    for (let pagina = 1; ; pagina++) {
      const { corpo } = await get(`/api/kanban?visao=${visao}&coluna=${coluna}&pagina=${pagina}`);
      itens.push(...corpo.colunas[0].itens);
      if (!corpo.colunas[0].temMais) return { itens, total: corpo.colunas[0].total };
    }
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await simular(storage, { semente: 31, sessoes: 60, caos: true, precos: true, agora: () => AGORA });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    sessoes = (await storage.listSessions({ limit: 500 })).items;
    agentes = (await Promise.all(sessoes.map((s) => storage.listAgents(s.id)))).flat();
    const contas = new Contas({ storage, arquivo: null });
    quadro = new QuadroKanban({ storage, contas, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, kanban: quadro });
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

  test('sem visão é a de sessões: as cinco colunas, na ordem, com rótulos', async () => {
    const { status, corpo } = await get('/api/kanban');
    assert.equal(status, 200);
    assert.equal(corpo.visao, 'sessoes');
    assert.equal(corpo.porPagina, 10);
    assert.deepEqual(
      corpo.colunas.map((c) => [c.id, c.rotulo]),
      [
        ['ativa', 'Ativa'],
        ['esperando', 'Esperando você'],
        ['concluida', 'Concluída'],
        ['erro', 'Com erro'],
        ['abandonada', 'Abandonada'],
      ],
    );
    assert.deepEqual(COLUNAS_DAS_SESSOES.map((c) => c.id), corpo.colunas.map((c) => c.id));
  });

  test('visão sessões: cada total bate com as sessões daquele status, e os cards são do status da coluna', async () => {
    const { corpo } = await get('/api/kanban?visao=sessoes');
    let soma = 0;
    for (const c of corpo.colunas) {
      const esperado = sessoes.filter((s) => COLUNA_DA_SESSAO[displayStatus(s)] === c.id).length;
      assert.equal(c.total, esperado, c.id);
      assert.equal(c.pagina, 1);
      assert.equal(c.itens.length, Math.min(10, esperado), c.id);
      assert.equal(c.temMais, esperado > 10, c.id);
      for (const card of c.itens as CardDeSessao[]) assert.equal(COLUNA_DA_SESSAO[card.status], c.id, card.id);
      soma += c.total;
    }
    assert.equal(soma, sessoes.length);
  });

  test('o card de sessão: título, motivo só esperando, pedido sem quebra de linha, modelo legível, conta sem id', async () => {
    const { corpo, texto } = await get('/api/kanban');
    const cards = corpo.colunas.flatMap((c) => c.itens as CardDeSessao[]);
    assert.ok(cards.length > 0);
    for (const c of cards) {
      assert.ok(c.titulo.length > 0 && c.titulo.length <= 60, c.id);
      if (c.status === 'waiting') assert.ok(c.motivo !== null, c.id);
      else assert.equal(c.motivo, null, c.id);
      assert.equal(c.rodando, c.status === 'active' || c.status === 'waiting');
      assert.ok(c.duracaoMs >= 0);
      if (c.ultimoPedido !== null) {
        assert.ok(c.ultimoPedido.length <= 120, c.ultimoPedido);
        assert.doesNotMatch(c.ultimoPedido, /[\n\r]/);
      }
      assert.ok(c.agentes >= 1, c.id);
      if (c.modelo !== null) assert.doesNotMatch(c.modelo, /^claude-/, c.modelo);
      assert.ok(c.custoUsd === null || c.custoUsd >= 0);
      if (c.conta) assert.deepEqual(Object.keys(c.conta).sort(), ['cor', 'rotulo']);
    }
    assert.ok(cards.some((c) => c.ultimoPedido !== null), 'o simulador grava prompts');
    // Nenhum id de conta nem de org, em parte alguma da resposta (decisão 0006).
    for (const s of sessoes) {
      if (!s.accountId) continue;
      for (const pedaco of s.accountId.split('/')) assert.ok(!texto.includes(pedaco), 'id de conta na resposta');
    }
  });

  test('itens pela atividade mais recente primeiro', async () => {
    const { corpo } = await get('/api/kanban');
    for (const c of corpo.colunas) {
      const datas = c.itens.map((i) => i.ultimaAtividade);
      assert.deepEqual(datas, [...datas].sort().reverse(), c.id);
    }
  });

  test('10 por página: a página 2 de uma coluna traz o resto, sem repetir', async () => {
    const { corpo } = await get('/api/kanban');
    const grande = corpo.colunas.find((c) => c.temMais);
    assert.ok(grande, 'alguma coluna com mais de 10');
    const p2 = await get(`/api/kanban?visao=sessoes&coluna=${grande.id}&pagina=2`);
    assert.equal(p2.status, 200);
    assert.equal(p2.corpo.colunas.length, 1);
    const [c2] = p2.corpo.colunas;
    assert.equal(c2.id, grande.id);
    assert.equal(c2.pagina, 2);
    assert.equal(c2.total, grande.total);
    assert.equal(c2.itens.length, Math.min(10, grande.total - 10));
    assert.equal(c2.temMais, grande.total > 20);
    const ids1 = new Set(grande.itens.map((i) => i.id));
    for (const i of c2.itens) assert.ok(!ids1.has(i.id), `repetido: ${i.id}`);
    const { itens, total } = await colunaInteira('sessoes', grande.id);
    assert.equal(itens.length, total);
  });

  test('só a coluna, na página 1 por padrão; página além do fim vem vazia', async () => {
    const { corpo } = await get('/api/kanban?coluna=erro');
    assert.equal(corpo.colunas.length, 1);
    assert.equal(corpo.colunas[0].id, 'erro');
    assert.equal(corpo.colunas[0].pagina, 1);
    const alem = await get('/api/kanban?coluna=erro&pagina=999');
    assert.equal(alem.status, 200);
    assert.deepEqual(alem.corpo.colunas[0].itens, []);
    assert.equal(alem.corpo.colunas[0].temMais, false);
  });

  test('visão agentes: as quatro colunas, na ordem, com rótulos', async () => {
    const { status, corpo } = await get('/api/kanban?visao=agentes');
    assert.equal(status, 200);
    assert.equal(corpo.visao, 'agentes');
    assert.deepEqual(
      corpo.colunas.map((c) => [c.id, c.rotulo]),
      [
        ['trabalhando', 'Trabalhando'],
        ['esperando', 'Esperando'],
        ['concluidos', 'Concluídos'],
        ['erro', 'Erro'],
      ],
    );
    assert.deepEqual(COLUNAS_DOS_AGENTES.map((c) => c.id), corpo.colunas.map((c) => c.id));
  });

  test('visão agentes: um principal por sessão e cada subagente; os totais somam tudo', async () => {
    const { corpo } = await get('/api/kanban?visao=agentes');
    const subagentes = agentes.filter((a) => a.type === 'subagent');
    const soma = corpo.colunas.reduce((n, c) => n + c.total, 0);
    assert.equal(soma, sessoes.length + subagentes.length);
    // Os totais batem com a regra de status, coluna a coluna.
    const porSessao = new Map(sessoes.map((s) => [s.id, s]));
    const esperado = new Map<string, number>();
    for (const s of sessoes) esperado.set(colunaDoAgente(displayStatus(s)), (esperado.get(colunaDoAgente(displayStatus(s))) ?? 0) + 1);
    for (const a of subagentes) {
      const k = colunaDoAgente(QuadroKanban.statusDoSubagente(a, porSessao.get(a.sessionId)!));
      esperado.set(k, (esperado.get(k) ?? 0) + 1);
    }
    for (const c of corpo.colunas) assert.equal(c.total, esperado.get(c.id) ?? 0, c.id);
    assert.ok(corpo.colunas.find((c) => c.id === 'concluidos')!.total > 0);
  });

  test('o card de agente: id único, principal com o título, subagente com o tipo', async () => {
    const todos: CardDeAgente[] = [];
    for (const c of COLUNAS_DOS_AGENTES) todos.push(...((await colunaInteira('agentes', c.id)).itens as CardDeAgente[]));
    assert.equal(new Set(todos.map((a) => a.id)).size, todos.length, 'ids únicos');
    const principais = todos.filter((a) => a.principal);
    assert.equal(principais.length, sessoes.length);
    for (const p of principais) {
      assert.equal(p.id, p.sessaoId);
      assert.equal(p.nome, 'Agente principal');
      assert.ok(p.descricao.length > 0);
    }
    for (const s of todos.filter((a) => !a.principal)) {
      assert.ok(s.id.startsWith(`${s.sessaoId}:`), s.id);
      assert.ok(s.nome.length > 0 && s.nome !== 'Agente principal', s.nome);
      assert.equal(s.rodando, s.status === 'active' || s.status === 'waiting');
      if (s.status !== 'waiting') assert.equal(s.motivo, null);
    }
  });

  test('regras de status do agente', () => {
    assert.equal(colunaDoAgente('active'), 'trabalhando');
    assert.equal(colunaDoAgente('waiting'), 'esperando');
    assert.equal(colunaDoAgente('completed'), 'concluidos');
    assert.equal(colunaDoAgente('abandoned'), 'concluidos');
    assert.equal(colunaDoAgente('error'), 'erro');
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

  test('400 para visão, coluna e página inválidas', async () => {
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
    assert.throws(() => pedidoDoKanban(new URL('http://x/api/kanban?pagina=1')));
  });
});
