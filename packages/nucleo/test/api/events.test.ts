// The activity feed (#94): GET /api/events. Synthetic fixtures and the simulator, never real data.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { FeedDeEventos, statusDoEvento, textoDeUmaLinha, type EventoDoFeed, type RespostaDoFeed } from '../../src/api/events.ts';
import { seedPanelScenario } from '../../src/simulator/panel.ts';
import { normalizeLegacyQuery } from '../../src/api/legacy-routes.ts';
import { agent, at, event, session } from '../fixtures.ts';

let storage: SqliteStorage;
let feed: FeedDeEventos;

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  feed = new FeedDeEventos({ storage });
});
afterEach(() => storage.close());

// The handlers read the English parameters; the old ones in these strings pass through the alias map.
async function pedir(busca = ''): Promise<{ status: number; corpo: RespostaDoFeed & { error?: string } }> {
  const r = await feed.responder(normalizeLegacyQuery(new URLSearchParams(busca)));
  return r as { status: number; corpo: RespostaDoFeed & { error?: string } };
}
async function ok(busca = ''): Promise<RespostaDoFeed> {
  const r = await pedir(busca);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  return r.corpo;
}
const ids = (r: RespostaDoFeed) => r.events.map((e) => e.id);

async function semear() {
  await storage.putSession(session({ id: 's1', name: 'ajuste do login', cwd: '/repo/app' }));
  await storage.putSession(session({ id: 's2', name: null, cwd: '/home/dev/api' }));
  await storage.putAgent(agent({ id: 's1:main', sessionId: 's1', type: 'main' }));
  await storage.putAgent(agent({ id: 's1:sub1', sessionId: 's1', type: 'subagent', subagentType: 'revisor', name: 'nome' }));
  await storage.appendEvent(event({ id: 'e1', sessionId: 's1', agentId: null, createdAt: at(1), type: 'UserPromptSubmit', toolName: null, summary: 'pedido', data: {} }));
  await storage.appendEvent(event({ id: 'e2', sessionId: 's2', agentId: null, createdAt: at(2), type: 'PreToolUse', toolName: 'Bash', summary: 'npm test', data: { tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } } }));
  await storage.appendEvent(event({ id: 'e3', sessionId: 's1', agentId: 's1:main', createdAt: at(3), type: 'ToolUse', toolName: 'Read', summary: '/repo/app/a.ts', data: { toolUseId: 'toolu_2', tool_input: { file_path: '/repo/app/a.ts' } } }));
  await storage.appendEvent(event({ id: 'e4', sessionId: 's1', agentId: 'sub1', createdAt: at(4), type: 'Notification', toolName: null, summary: 'Claude precisa da sua permissão', data: {} }));
  await storage.appendEvent(event({ id: 'e5', sessionId: 's2', agentId: null, createdAt: at(5), type: 'APIError', toolName: null, summary: 'overloaded', data: {} }));
  await storage.appendEvent(event({ id: 'e6', sessionId: 's2', agentId: null, createdAt: at(6), type: 'SessionEnd', toolName: null, summary: 'logout', data: {} }));
}

describe('#94 o status de cada evento (função pura)', () => {
  test('espera, erro, fim e o resto ativo', () => {
    for (const t of ['Notification', 'PermissionRequest', 'Stop', 'Interrupted']) assert.equal(statusDoEvento(t), 'waiting', t);
    for (const t of ['APIError', 'StopFailure']) assert.equal(statusDoEvento(t), 'error', t);
    for (const t of ['SessionEnd', 'SubagentStop']) assert.equal(statusDoEvento(t), 'completed', t);
    for (const t of ['PreToolUse', 'PostToolUse', 'ToolUse', 'ToolResult', 'UserPromptSubmit', 'SessionStart', 'AssistantMessage', 'Desconhecido']) {
      assert.equal(statusDoEvento(t), 'active', t);
    }
  });
});

describe('#94 o texto que sai é uma linha curta', () => {
  test('corta por code point, sem partir par substituto, e tira quebras e controles', () => {
    assert.equal(textoDeUmaLinha('a\nb\r\n\tc\u0000d\u2028e', 100), 'a b c d e');
    assert.equal(textoDeUmaLinha('abcdef', 4), 'abc…');
    assert.equal(textoDeUmaLinha('rm\u202e-rf\u200b x\u2066y\u2069\ufeff', 100), 'rm -rf x y', 'bidi e largura zero viram espaço');
    const emojis = '😀'.repeat(10);
    const cortado = textoDeUmaLinha(emojis, 5)!;
    assert.equal(cortado, `${'😀'.repeat(4)}…`);
    assert.equal(Array.from(cortado).length, 5);
    assert.equal(textoDeUmaLinha('\ud800 solto', 20), '� solto');
    assert.equal(textoDeUmaLinha('   ', 10), null);
    assert.equal(textoDeUmaLinha(42, 10), null);
  });
});

describe('#94 GET /api/eventos: a montagem', () => {
  test('o resumo é a frase do evento, com o turno medido e a permissão dizendo qual ferramenta', async () => {
    await storage.putSession(session({ id: 's1', name: 'x', cwd: '/repo/app' }));
    const t0 = Date.parse(at(1));
    const em = (s: number) => new Date(t0 + s * 1000).toISOString();
    await storage.appendEvent(event({ id: 'p', sessionId: 's1', agentId: null, createdAt: em(0), type: 'UserPromptSubmit', toolName: null, summary: 'rode os testes', data: {} }));
    await storage.appendEvent(event({ id: 'f', sessionId: 's1', agentId: null, createdAt: em(10), type: 'PreToolUse', toolName: 'Bash', summary: 'npm run build', data: {} }));
    await storage.appendEvent(event({ id: 'n', sessionId: 's1', agentId: null, createdAt: em(11), type: 'Notification', toolName: null, summary: 'precisa de permissão', data: { notification_type: 'permission_prompt' } }));
    await storage.appendEvent(event({ id: 's', sessionId: 's1', agentId: null, createdAt: em(38.2), type: 'Stop', toolName: null, summary: null, data: {} }));
    await storage.appendEvent(event({ id: 'e', sessionId: 's1', agentId: null, createdAt: em(40), type: 'StopFailure', toolName: null, summary: 'API Error: 529 {"type":"overloaded_error","message":"segredo"}', data: {} }));
    const resumo = Object.fromEntries((await ok()).events.map((e) => [e.id, e.summary]));
    assert.deepEqual(resumo, {
      p: 'Prompt: "rode os testes"',
      f: 'Bash: npm run build',
      n: 'Pede permissão: Bash npm run build',
      s: 'Turno concluído em 38,2 s',
      e: 'Erro de API 529 · overloaded_error',
    });
  });

  test('mais novo primeiro, com sessão, agente, status e detalhe', async () => {
    await semear();
    const r = await ok();
    assert.deepEqual(ids(r), ['e6', 'e5', 'e4', 'e3', 'e2', 'e1']);
    const porId = new Map(r.events.map((e) => [e.id, e]));
    assert.deepEqual(porId.get('e2'), {
      id: 'e2',
      createdAt: at(2),
      type: 'PreToolUse',
      status: 'active',
      attention: null,
      tool: 'Bash',
      summary: 'Bash: npm test',
      session: { id: 's2', title: null, project: 'api' },
      agent: { id: null, name: 'main' },
      detail: { callId: 'toolu_1', input: 'npm test' },
    } satisfies EventoDoFeed);
    assert.deepEqual(porId.get('e3')?.agent, { id: 's1:main', name: 'main' });
    assert.deepEqual(porId.get('e3')?.detail, { callId: 'toolu_2', input: '/repo/app/a.ts' });
    assert.deepEqual(porId.get('e3')?.session, { id: 's1', title: 'ajuste do login', project: 'app' });
    assert.deepEqual(porId.get('e4')?.agent, { id: 's1:sub1', name: 'revisor' }, 'o agent_id do hook acha o subagente <sessão>:<id>');
    assert.equal(porId.get('e4')?.status, 'waiting');
    assert.equal(porId.get('e5')?.status, 'error');
    assert.equal(porId.get('e6')?.status, 'completed');
    assert.deepEqual(porId.get('e1')?.detail, { callId: null, input: null });
    assert.ok(r.cursor);
    assert.equal(r.older, null);
  });

  test('sem evento nenhum: lista vazia, e o cursor do ao vivo já no começo', async () => {
    const r = await ok();
    assert.deepEqual(r.events, []);
    assert.ok(r.cursor);
    assert.equal(r.older, null);
    assert.deepEqual(r.options, { types: [], tools: [], sessions: [] });
  });

  test('as opções só vêm no primeiro pedido', async () => {
    await semear();
    const r = await ok('limite=2');
    assert.deepEqual(r.options?.types, ['APIError', 'Notification', 'PreToolUse', 'SessionEnd', 'ToolUse', 'UserPromptSubmit']);
    assert.deepEqual(r.options?.tools, ['Bash', 'Read']);
    assert.deepEqual(
      r.options?.sessions.map((s) => s.id).sort(),
      ['s1', 's2'],
    );
    assert.deepEqual(r.options?.sessions.find((s) => s.id === 's1'), { id: 's1', title: 'ajuste do login', project: 'app' });
    assert.equal((await ok(`antes=${r.older}`)).options, null);
    assert.equal((await ok(`depois=${r.cursor}`)).options, null);
  });

  test('paginação por antes, até acabar', async () => {
    await semear();
    const p1 = await ok('limite=4');
    assert.deepEqual(ids(p1), ['e6', 'e5', 'e4', 'e3']);
    assert.ok(p1.older);
    const p2 = await ok(`limite=4&antes=${p1.older}`);
    assert.deepEqual(ids(p2), ['e2', 'e1']);
    assert.equal(p2.older, null);
  });

  test('ao vivo por depois: o novo e o atrasado (createdAt mais velho), e o cursor repete sem nada novo', async () => {
    await semear();
    const p = await ok();
    const nada = await ok(`depois=${p.cursor}`);
    assert.deepEqual(nada.events, []);
    assert.equal(nada.cursor, p.cursor);
    assert.equal(nada.older, null);

    await storage.appendEvent(event({ id: 'novo', sessionId: 's1', agentId: null, createdAt: at(10), type: 'Stop', toolName: null, summary: null, data: {} }));
    await storage.appendEvent(event({ id: 'atrasado', sessionId: 's1', agentId: null, createdAt: at(0), type: 'ToolResult', toolName: 'Read', summary: 'ok', data: {} }));
    const vivo = await ok(`depois=${p.cursor}`);
    assert.deepEqual(ids(vivo), ['novo', 'atrasado']);
    assert.deepEqual(ids(await ok(`depois=${vivo.cursor}`)), []);
  });

  test('cada filtro', async () => {
    await semear();
    assert.deepEqual(ids(await ok('tipo=PreToolUse')), ['e2']);
    assert.deepEqual(ids(await ok('sessao=s2')), ['e6', 'e5', 'e2']);
    assert.deepEqual(ids(await ok('ferramenta=Read')), ['e3']);
    assert.deepEqual(ids(await ok('status=waiting')), ['e4']);
    assert.deepEqual(ids(await ok('status=error')), ['e5']);
    assert.deepEqual(ids(await ok('status=completed')), ['e6']);
    assert.deepEqual(ids(await ok('status=active')), ['e3', 'e2', 'e1']);
    assert.deepEqual(ids(await ok('status=active&tipo=APIError')), [], 'tipo e status que não casam: nada');
    assert.deepEqual(ids(await ok('status=error&tipo=APIError')), ['e5']);
    assert.deepEqual(ids(await ok('busca=NPM')), ['e2']);
    assert.deepEqual(ids(await ok('busca=read')), ['e3'], 'acha no nome da ferramenta');
    assert.deepEqual(ids(await ok('busca=%25')), []);
    assert.deepEqual(ids(await ok(`de=${encodeURIComponent(at(2))}&ate=${encodeURIComponent(at(4))}`)), ['e4', 'e3', 'e2'], 'ate com hora é inclusivo');
    assert.deepEqual(ids(await ok('de=2026-11-02&ate=2026-11-02')), ['e6', 'e5', 'e4', 'e3', 'e2', 'e1'], 'data sem hora: o dia inteiro (UTC)');
    assert.deepEqual(ids(await ok('ate=2026-11-01')), []);
    assert.deepEqual(ids(await ok('sessao=s1&status=active&busca=a.ts')), ['e3']);
  });

  test('o ao vivo respeita os filtros', async () => {
    await semear();
    const p = await ok('sessao=s1');
    await storage.appendEvent(event({ id: 'outra', sessionId: 's2', createdAt: at(20) }));
    await storage.appendEvent(event({ id: 'dela', sessionId: 's1', createdAt: at(21) }));
    assert.deepEqual(ids(await ok(`sessao=s1&depois=${p.cursor}`)), ['dela']);
  });

  test('parâmetros inválidos dão 400 com o erro em pt-BR', async () => {
    await semear();
    const p = await ok('limite=1');
    const ruins = [
      'limite=0',
      'limite=201',
      'limite=abc',
      'limite=1.5',
      `depois=${p.cursor}&antes=${p.older}`,
      'depois=lixo',
      'antes=lixo',
      `depois=${'a'.repeat(600)}`,
      'tipo=a%20b',
      `tipo=${'A'.repeat(65)}`,
      'sessao=id%20com%20espa%C3%A7o',
      'ferramenta=a%3Bb',
      'status=working',
      `busca=${'x'.repeat(101)}`,
      'busca=a%0Ab',
      'de=ontem',
      'ate=2026-13-40',
      'de=2026-11-02T12:00',
      `de=${encodeURIComponent(at(5))}&ate=${encodeURIComponent(at(1))}`,
    ];
    for (const q of ruins) {
      const r = await pedir(q);
      assert.equal(r.status, 400, q);
      assert.equal(typeof r.corpo.error, 'string', q);
    }
    assert.equal((await pedir(`busca=${'x'.repeat(100)}`)).status, 200);
    assert.equal((await pedir('limite=200')).status, 200);
  });

  test('corta os campos grandes e não vaza o data', async () => {
    const grande = 'x'.repeat(10_000);
    const segredo = 'RESPOSTA-INTEIRA-DO-AGENTE';
    await storage.putSession(session({ id: 's1', name: `T${'í'.repeat(500)}\nlinha 2`, cwd: `/repo/${'p'.repeat(500)}` }));
    await storage.putAgent(agent({ id: 's1:sub', sessionId: 's1', type: 'subagent', subagentType: 'g'.repeat(500) }));
    await storage.appendEvent(
      event({
        id: 'grande',
        sessionId: 's1',
        agentId: 's1:sub',
        type: 'PreToolUse',
        toolName: 'Bash',
        summary: grande,
        data: {
          tool_use_id: `toolu_${'9'.repeat(200)}`,
          tool_input: { command: `${grande}\nrm -rf /` },
          tool_response: { stdout: segredo },
          last_assistant_message: segredo,
          prompt: segredo,
        },
      }),
    );
    const r = await ok();
    const [e] = r.events;
    const tam = (s: string | null) => Array.from(s ?? '').length;
    assert.equal(tam(e.summary), 300);
    assert.ok(e.summary?.endsWith('…'));
    assert.equal(tam(e.detail.input), 300);
    assert.ok(!e.detail.input?.includes('\n'));
    assert.equal(tam(e.detail.callId), 64);
    assert.equal(tam(e.session.title), 120);
    assert.ok(!e.session.title?.includes('\n'));
    assert.equal(tam(e.session.project), 120);
    assert.equal(tam(e.agent.name), 60);
    const texto = JSON.stringify(r);
    assert.ok(!texto.includes(segredo), 'o data cru não sai');
    assert.ok(!('data' in e));
  });

  test('busca de sessões e agentes sem repetir por evento (cache por pedido)', async () => {
    await semear();
    let sessoes = 0;
    let agentes = 0;
    const contada = new FeedDeEventos({
      storage: Object.assign(Object.create(storage) as SqliteStorage, {
        getSession: (id: string) => (sessoes++, storage.getSession(id)),
        getAgent: (id: string) => (agentes++, storage.getAgent(id)),
      }),
    });
    for (let i = 0; i < 30; i++) await storage.appendEvent(event({ id: `x${i}`, sessionId: 's1', agentId: 'sub1', createdAt: at(30 + i) }));
    const r = await contada.responder(new URLSearchParams('limit=40'));
    assert.equal(r.status, 200);
    assert.ok(sessoes <= 2, `sessões lidas: ${sessoes}`);
    assert.ok(agentes <= 4, `agentes lidos: ${agentes}`);
  });
});

describe('#94 GET /api/eventos: a rota HTTP, ponta a ponta', () => {
  test('sobe na porta 0 com o cenário do simulador; só GET; Origin de fora dá 403', async () => {
    await seedPanelScenario(storage, 'p4');
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
    const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, events: feed });
    try {
      const r = await fetch(`${api.url}/api/events?limit=5`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      const corpo = (await r.json()) as RespostaDoFeed;
      assert.equal(corpo.events.length, 5);
      assert.ok(corpo.cursor);
      assert.ok(corpo.options);
      for (let i = 1; i < corpo.events.length; i++) assert.ok(corpo.events[i - 1].createdAt >= corpo.events[i].createdAt);
      const mais = (await (await fetch(`${api.url}/api/events?limit=5&before=${corpo.older}`)).json()) as RespostaDoFeed;
      assert.equal(mais.options, null);
      assert.ok(mais.events.every((e) => !corpo.events.some((x) => x.id === e.id)));
      assert.deepEqual(await (await fetch(`${api.url}/api/events?limit=0`)).json(), { error: 'limit: um inteiro de 1 a 200' }, 'the error cites the new parameter');

      assert.equal((await fetch(`${api.url}/api/eventos?limite=0`)).status, 400);
      assert.equal((await fetch(`${api.url}/api/eventos`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${api.url}/api/eventos`, { headers: { origin: 'https://exemplo.com' } })).status, 403);
    } finally {
      await api.close();
    }
  });

  test('sem a opção eventos, a rota não existe', async () => {
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
    const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      assert.equal((await fetch(`${api.url}/api/eventos`)).status, 404);
    } finally {
      await api.close();
    }
  });
});
