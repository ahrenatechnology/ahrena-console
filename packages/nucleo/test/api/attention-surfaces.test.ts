// #245: every English route that feeds a /ui screen with a session's state answers the same
// `attention: { level: 'blocked' | 'idle', reason } | null`, from `atencaoDe` only, and the counts split
// blocked from idle where the screen shows counts. The old Portuguese routes answer their old bodies.
// Synthetic data: the MCP seed (5 blocked, 3 idle, working, delegating, completed, abandoned).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Accounts,
  FeedDeEventos,
  LeiturasDoDetalhe,
  ListaDeSessoes,
  MontadorDoPainel,
  QuadroKanban,
  startLocalApi,
  type CabecaDoDetalhe,
  type KanbanHttp,
  type ListaDeSessoesHttp,
  type LocalApi,
  type Panel,
  type RespostaDoDashboard,
  type RespostaDoFeed,
  type Wall,
} from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { NOW, seed } from '../mcp/helpers.ts';

/** What each seeded session is (#245/AC-3, #245/AC-4). */
const EXPECTED: Record<string, unknown> = {
  plano: { level: 'blocked', reason: 'plan' },
  permissao: { level: 'blocked', reason: 'permission' },
  pergunta: { level: 'blocked', reason: 'question' },
  erro: { level: 'blocked', reason: 'error' },
  'sua-vez': { level: 'idle', reason: 'turn_ended' },
  interrompida: { level: 'idle', reason: 'interrupted' },
  abriu: { level: 'idle', reason: 'first_prompt' },
  trabalhando: null,
  delegando: null,
  concluida: null,
  velha: null,
};

describe('#245 attention on every /ui route', () => {
  let storage: SqliteStorage;
  let api: LocalApi;
  const read = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${api.url}${path}`);
    assert.equal(r.status, 200, `${path}: ${r.status}`);
    return (await r.json()) as T;
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await seed(storage);
    const contas = new Accounts({ storage, file: null });
    const agora = () => NOW;
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null, agora });
    api = await startLocalApi({
      panelBuilder: montador,
      hooks: { storage },
      port: 0,
      log: () => {},
      fleet: new FleetReader({ storage, accounts: contas, now: agora, timeZone: 'UTC' }),
      sessions: new ListaDeSessoes({ storage, contas, agora }),
      kanban: new QuadroKanban({ storage, contas, agora }),
      events: new FeedDeEventos({ storage }),
      detail: new LeiturasDoDetalhe({ storage, montador, agora }),
    });
  });
  after(async () => {
    await api.close();
    storage.close();
  });

  test('#245/AC-3 #245/AC-4 GET /api/sessions: each row, the blocked and idle filters and the pill counts', async () => {
    const pages = [await read<ListaDeSessoesHttp>('/api/sessions'), await read<ListaDeSessoesHttp>('/api/sessions?page=2')];
    const rows = pages.flatMap((p) => p.items);
    assert.equal(rows.length, Object.keys(EXPECTED).length);
    for (const r of rows) assert.deepEqual(r.attention, EXPECTED[r.id], r.id);
    assert.deepEqual(pages[0].counts, { all: 11, active: 1, waiting: 7, blocked: 4, idle: 3, completed: 1, error: 1, abandoned: 1 });
    const blocked = await read<ListaDeSessoesHttp>('/api/sessions?status=blocked');
    assert.deepEqual(blocked.items.map((i) => i.id).sort(), ['erro', 'pergunta', 'permissao', 'plano']);
    assert.equal(blocked.total, 4);
    const idle = await read<ListaDeSessoesHttp>('/api/sessions?status=idle');
    assert.deepEqual(idle.items.map((i) => i.id).sort(), ['abriu', 'interrompida', 'sua-vez']);
    // The pills count with the search, as the list does.
    assert.deepEqual((await read<ListaDeSessoesHttp>('/api/sessions?status=idle&search=fila')).counts, { all: 1, active: 0, waiting: 1, blocked: 0, idle: 1, completed: 0, error: 0, abandoned: 0 });
  });

  test('GET /api/sessions: the old route answers neither `counts` nor `attention`, and its errors stay', async () => {
    const old = await read<Record<string, unknown> & { itens: Record<string, unknown>[] }>('/api/sessoes');
    assert.deepEqual(Object.keys(old), ['total', 'registradas', 'pagina', 'porPagina', 'paginas', 'diretorios', 'itens']);
    for (const i of old.itens) assert.ok(!('attention' in i));
    const bad = await fetch(`${api.url}/api/sessoes?status=nada`);
    assert.deepEqual(await bad.json(), { error: 'status: um de todas, ativas, esperando, concluidas, erro, abandonadas' });
  });

  test('#245/AC-4 GET /api/sessions/<id> and GET /api/panel/<id>: the session card carries `attention`', async () => {
    for (const id of ['permissao', 'sua-vez', 'trabalhando', 'erro']) {
      assert.deepEqual((await read<CabecaDoDetalhe>(`/api/sessions/${id}`)).session.attention, EXPECTED[id], `detail ${id}`);
      assert.deepEqual((await read<Panel>(`/api/panel/${id}`)).session.attention, EXPECTED[id], `panel ${id}`);
    }
    // A session the core has not seen yet waits for its first prompt.
    assert.deepEqual((await read<Panel>('/api/panel/never-seen')).session.attention, { level: 'idle', reason: 'first_prompt' });
  });

  test('the old /api/sessoes/<id>, /api/painel/<id> and /api/sessao/<id> answer the card without `attention`', async () => {
    for (const path of ['/api/sessoes/permissao', '/api/painel/permissao', '/api/sessao/permissao']) {
      const old = await read<{ sessao: Record<string, unknown> }>(path);
      assert.ok(old.sessao && !('attention' in old.sessao), path);
      assert.equal(old.sessao.estado, 'waiting', path);
    }
  });

  test('#245/AC-3 #245/AC-4 GET /api/wall: each card, and the blocked and idle counts', async () => {
    const wall = await read<Wall>('/api/wall');
    for (const c of wall.cards) assert.deepEqual(c.attention, EXPECTED[c.id], c.id);
    assert.deepEqual(wall.count, { all: 10, waiting: 7, active: 2, blocked: 4, idle: 3 });
    // Blocked first, then idle, then the rest.
    const rank = (c: Wall['cards'][number]) => (c.attention?.level === 'blocked' ? 0 : c.attention?.level === 'idle' ? 1 : 2);
    assert.deepEqual(wall.cards.map(rank), [...wall.cards.map(rank)].sort());
    const old = await read<{ contagem: Record<string, number>; cards: Record<string, unknown>[] }>('/api/mural');
    assert.deepEqual(Object.keys(old.contagem), ['todas', 'esperando', 'ativas']);
    for (const c of old.cards) assert.ok(!('attention' in c));
  });

  test('#245/AC-3 #245/AC-4 GET /api/kanban: the sessions board has the approved columns, blocked with the errors', async () => {
    const board = await read<KanbanHttp>('/api/kanban?view=sessions');
    const ids = Object.fromEntries(board.columns.map((c) => [c.id, c.items.map((i) => i.id).sort()]));
    assert.deepEqual(
      board.columns.map((c) => [c.id, c.label]),
      [
        ['active', 'Ativas'],
        ['blocked', 'Precisam de você'],
        ['idle', 'Ociosas'],
        ['completed', 'Concluídas'],
        ['abandoned', 'Abandonadas'],
      ],
    );
    assert.deepEqual(ids, {
      active: ['delegando', 'trabalhando'],
      blocked: ['erro', 'pergunta', 'permissao', 'plano'],
      idle: ['abriu', 'interrompida', 'sua-vez'],
      completed: ['concluida'],
      abandoned: ['velha'],
    });
    for (const c of board.columns) for (const i of c.items) assert.deepEqual((i as { attention: unknown }).attention, EXPECTED[i.id], i.id);
    const more = await read<KanbanHttp>('/api/kanban?view=sessions&column=idle');
    assert.deepEqual(more.columns.map((c) => [c.id, c.total]), [['idle', 3]]);
  });

  test('#245/AC-3 #245/AC-4 GET /api/kanban: the agents board splits the waiting column in blocked and idle', async () => {
    const board = await read<KanbanHttp>('/api/kanban?view=agents');
    assert.deepEqual(
      board.columns.map((c) => [c.id, c.label]),
      [
        ['working', 'Trabalhando'],
        ['blocked', 'Precisam de você'],
        ['idle', 'Ociosos'],
        ['done', 'Concluídos'],
        ['error', 'Erro'],
      ],
    );
    const ids = Object.fromEntries(board.columns.map((c) => [c.id, c.items.map((i) => i.id).sort()]));
    assert.deepEqual(ids, {
      working: ['delegando', 'delegando:sub', 'trabalhando'],
      blocked: ['pergunta', 'permissao', 'plano'],
      idle: ['abriu', 'interrompida', 'sua-vez'],
      done: ['concluida', 'velha'],
      error: ['erro'],
    });
    const byId = new Map(board.columns.flatMap((c) => c.items).map((i) => [i.id, (i as { attention: unknown }).attention]));
    assert.deepEqual(byId.get('permissao'), EXPECTED.permissao);
    assert.deepEqual(byId.get('erro'), EXPECTED.erro);
    assert.equal(byId.get('delegando:sub'), null, 'a subagent has no attention of its own');
  });

  test('#245/AC-4 GET /api/events: each event carries the attention it stands for', async () => {
    const feed = await read<RespostaDoFeed>('/api/events?limit=200');
    const of = (session: string, type: string) => feed.events.find((e) => e.session.id === session && e.type === type)!;
    assert.deepEqual(of('permissao', 'Notification').attention, { level: 'blocked', reason: 'permission' });
    assert.deepEqual(of('erro', 'APIError').attention, { level: 'blocked', reason: 'error' });
    assert.equal(of('permissao', 'PreToolUse').attention, null);
    const old = await read<{ eventos: Record<string, unknown>[] }>('/api/eventos?limite=200');
    for (const e of old.eventos) assert.ok(!('attention' in e));
  });

  test('#245/AC-3 #245/AC-4 GET /api/dashboard: the session numbers split blocked from idle, and each card carries `attention`', async () => {
    const d = await read<RespostaDoDashboard>('/api/dashboard');
    assert.deepEqual(d.numbers.sessions, { total: 11, active: 2, waiting: 6, withError: 1, blocked: 4, idle: 3 });
    for (const c of d.agents) assert.deepEqual(c.attention, EXPECTED[c.session], c.session);
  });
});
