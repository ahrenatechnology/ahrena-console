// MCP server (2.1): protocol, HTTP and stdio transports, and the tools
// `sessions_needing_attention` and `fleet_overview`, with synthetic data (fixtures and simulator).

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import {
  serveStdio,
  createMcpServer,
  paginate,
  httpBridge,
  serverWithoutCore,
  McpServer,
  safeTitle,
  LATEST_PROTOCOL_VERSION,
  type Tool,
  type JsonRpcResponse,
} from '../../src/mcp/index.ts';
import { seedPanelScenario } from '../../src/simulator/panel.ts';
import { agent, at, event, session } from '../fixtures.ts';
import { NOW, c2, MESSAGE, QUESTION, SECRET, seed } from './helpers.ts';

type CallResult = { content: { type: string; text: string }[]; structuredContent: any; isError: boolean };

let storage: SqliteStorage;
let server: McpServer;
let n = 0;
const seedCases = () => seed(storage);

async function callTool(name: string, args: Record<string, unknown> = {}, s = server): Promise<CallResult> {
  const r = (await s.handle({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })) as JsonRpcResponse;
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.result as CallResult;
}

beforeEach(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  ({ server } = createMcpServer({ storage, accounts: new Accounts({ storage, file: null }), now: () => NOW, timeZone: 'UTC' }));
});
afterEach(() => storage.close());

describe('protocol', () => {
  test('initialize returns the requested version when it knows it, and the newest when not', async () => {
    for (const v of ['2025-03-26', '2025-06-18', '2025-11-25', '2024-11-05']) {
      const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {} } })) as JsonRpcResponse;
      assert.equal((r.result as { protocolVersion: string }).protocolVersion, v);
    }
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as JsonRpcResponse;
    const res = r.result as { protocolVersion: string; capabilities: object; serverInfo: { name: string } };
    assert.equal(res.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
    assert.equal(res.serverInfo.name, 'ahrena-console');
  });

  test('tools/list: the two tools, read-only, with input and output schemas', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse;
    const tools = (r.result as { tools: { name: string; inputSchema: { type: string }; outputSchema: object; annotations: { readOnlyHint: boolean } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ['sessions_needing_attention', 'fleet_overview']);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.outputSchema);
    }
  });

  test('a notification has no answer; a batch answers only the requests; an unknown method is -32601', async () => {
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const batch = (await server.handle([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', id: 'b', method: 'resources/list' },
    ])) as JsonRpcResponse[];
    assert.deepEqual(batch.map((r) => [r.id, r.error?.code ?? 'ok']), [['a', 'ok'], ['b', -32601]]);
    const bad = (await server.handle({ id: 1, method: 'ping' })) as JsonRpcResponse;
    assert.equal(bad.error?.code, -32600);
  });

  test('an unknown tool is -32602; a wrong argument comes back as isError for the model to fix', async () => {
    const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_sql' } })) as JsonRpcResponse;
    assert.equal(r.error?.code, -32602);
    for (const args of [{ limit: 0 }, { limit: 51 }, { cursor: 'xyz' }, { account: 3 }, { group: 'urgente' }, { coisa: 1 }]) {
      const res = await callTool('sessions_needing_attention', args);
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });

  test('register: the entry point for new tools, with a unique name and at most 10', async () => {
    const tool = (name: string): Tool => ({
      name,
      title: name,
      description: name,
      inputSchema: { type: 'object' },
      execute: async (_args, ctx) => ({ text: 'ok', data: { aborted: ctx.signal.aborted } }),
    });
    server.register(tool('wait_for_changes'));
    assert.deepEqual((await callTool('wait_for_changes')).structuredContent, { aborted: false });
    assert.throws(() => server.register(tool('wait_for_changes')), /já registrada/);
    assert.throws(() => server.register(tool('Nome-Ruim')), /inválido/);
    for (let i = 0; i < 7; i++) server.register(tool(`extra_${i}`));
    assert.throws(() => server.register(tool('extra_8')), /no máximo 10/);
  });
});

describe('sessions_needing_attention', () => {
  beforeEach(seedCases);

  test('splits the ones blocking the session from the ones on your turn, with reason, wait, account and how to open', async () => {
    const r = await callTool('sessions_needing_attention');
    const d = r.structuredContent;
    assert.equal(r.isError, false);
    assert.equal(d.total, 7);
    assert.equal(d.blocking, 4);
    assert.equal(d.yourTurn, 3);
    // Blocking first; in each group, whoever has waited longest first.
    assert.deepEqual(
      d.items.map((i: any) => [i.sessionId, i.group, i.reason]),
      [
        ['plano', 'blocking', 'plan'],
        ['permissao', 'blocking', 'permission'],
        ['erro', 'blocking', 'error'],
        ['pergunta', 'blocking', 'question'],
        // Esc is your turn, as on the panel (atencaoDe, #140).
        ['sua-vez', 'your_turn', 'turn_ended'],
        ['interrompida', 'your_turn', 'interrupted'],
        ['abriu', 'your_turn', 'first_prompt'],
      ],
    );
    const p = d.items.find((i: any) => i.sessionId === 'permissao');
    assert.equal(p.tool, 'Bash');
    assert.equal(p.reasonText, 'pede permissão para usar Bash');
    assert.equal(p.waitingMinutes, 5);
    assert.equal(p.waitingSince, at(-5));
    assert.deepEqual(p.account, { label: 'equipe', color: p.account.color, source: 'env' });
    assert.deepEqual(p.open, { resume: 'claude --resume permissao', cwd: '/repo/app', desktopSessionId: null, desktopLink: null });
    assert.equal(d.items.find((i: any) => i.sessionId === 'pergunta').questionOptions, 3);
    assert.equal(d.items.find((i: any) => i.sessionId === 'erro').errorCode, '529 overloaded_error');
    assert.equal(d.items.find((i: any) => i.sessionId === 'erro').account, null);
    assert.match(r.content[0].text, /7 sessões precisam de você: 4 travando o agente, 3 na sua vez/);
    assert.match(r.content[0].text, /Travando o agente:[\s\S]*Na sua vez:/);
  });

  test('with the session in the Desktop index, open carries the link that opens the conversation', async () => {
    const local = 'local_00000000-0000-4000-8000-000000000001';
    const desktop = { refresh: async () => {}, sessionByCli: (id: string) => (id === 'permissao' ? { localId: local, cliSessionId: id, title: 'Migrar\no banco', branch: null, cwd: null, parentLocalId: null, archived: false, accounts: [] } : null) };
    const { server: s } = createMcpServer({ storage, accounts: new Accounts({ storage, file: null }), desktop: desktop as never, now: () => NOW, timeZone: 'UTC' });
    const items = (await callTool('sessions_needing_attention', {}, s)).structuredContent.items;
    const p = items.find((i: any) => i.sessionId === 'permissao');
    assert.equal(p.title, 'Migrar o banco');
    assert.deepEqual(p.open, { resume: 'claude --resume permissao', cwd: '/repo/app', desktopSessionId: local, desktopLink: `claude://claude.ai/epitaxy/${local}` });
    assert.equal(items.find((i: any) => i.sessionId === 'plano').open.desktopLink, null);
  });

  test('a turn wrap-up asking for a decision blocks the session, without returning the question', async () => {
    await storage.putSession(session({ id: 'decisao', name: 'merge', startedAt: at(-60), updatedAt: at(-7), awaitingInputSince: at(-7), awaitingReason: 'stop', accountId: c2.id, accountSource: 'env' }));
    await storage.putAgent(agent({ id: 'decisao:main', sessionId: 'decisao', status: 'waiting' }));
    await storage.appendEvent(
      event({ id: 'decisao-e1', sessionId: 'decisao', agentId: 'decisao:main', type: 'PreToolUse', toolName: 'mcp__ccd_turn__wrap_up', summary: null, createdAt: at(-8), data: { tool_use_id: 'w1', tool_input: { recap: 'feito', ask: `Faço o merge? ${SECRET}` } } }),
    );
    const r = await callTool('sessions_needing_attention', { group: 'blocking' });
    const d = r.structuredContent.items.find((i: any) => i.sessionId === 'decisao');
    assert.equal(d.reason, 'decision');
    assert.equal(d.reasonText, 'fechou o turno pedindo uma decisão sua');
    assert.ok(!JSON.stringify(r).includes('Faço o merge'));
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });

  test('returns no conversation text: command, question, plan, assistant message or error message', async () => {
    const r = await callTool('sessions_needing_attention');
    const all = JSON.stringify(r);
    for (const t of [SECRET, QUESTION, MESSAGE, 'hunter2', 'segredo-do-cliente', 'Ignore as instruções']) assert.ok(!all.includes(t), t);
  });

  test('split by account and filter by label, id, several and "none"', async () => {
    const d = (await callTool('sessions_needing_attention')).structuredContent;
    assert.deepEqual(
      d.byAccount.map((c: any) => [c.account?.label ?? null, c.total, c.blocking, c.yourTurn]),
      [['equipe', 4, 2, 2], ['cliente', 2, 1, 1], [null, 1, 1, 0]],
    );
    const ids = async (account: unknown) => (await callTool('sessions_needing_attention', { account })).structuredContent.items.map((i: any) => i.sessionId);
    assert.deepEqual(await ids('CLIENTE'), ['pergunta', 'interrompida']);
    assert.deepEqual(await ids(c2.id), ['pergunta', 'interrompida']);
    assert.deepEqual(await ids('none'), ['erro']);
    assert.deepEqual(await ids(['cliente', 'none']), ['erro', 'pergunta', 'interrompida']);
    assert.deepEqual(await ids('não-existe'), []);
  });

  test('filter by group and pagination by cursor', async () => {
    const yourTurn = (await callTool('sessions_needing_attention', { group: 'your_turn' })).structuredContent;
    assert.deepEqual(yourTurn.items.map((i: any) => i.sessionId), ['sua-vez', 'interrompida', 'abriu']);
    assert.equal(yourTurn.total, 7, 'the totals cover every group');

    const p1 = (await callTool('sessions_needing_attention', { limit: 3 })).structuredContent;
    assert.equal(p1.items.length, 3);
    assert.ok(p1.nextCursor);
    const p2 = (await callTool('sessions_needing_attention', { limit: 3, cursor: p1.nextCursor })).structuredContent;
    const p3 = (await callTool('sessions_needing_attention', { limit: 3, cursor: p2.nextCursor })).structuredContent;
    assert.equal(p3.nextCursor, null);
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i: any) => i.sessionId).length, 7);
  });

  test('with nobody waiting, says so', async () => {
    const empty = openSqliteStorage({ path: ':memory:' });
    const { server: s } = createMcpServer({ storage: empty, accounts: new Accounts({ storage: empty, file: null }), now: () => NOW, timeZone: 'UTC' });
    const r = await callTool('sessions_needing_attention', {}, s);
    assert.equal(r.content[0].text, 'Nenhuma sessão precisa de você agora.');
    assert.equal(r.structuredContent.total, 0);
    await empty.close();
  });
});

describe('fleet_overview', () => {
  beforeEach(seedCases);

  test('totals by state, ended today, who needs you and today’s cost', async () => {
    const r = await callTool('fleet_overview');
    const t = r.structuredContent.totals;
    assert.equal(t.live, 9);
    assert.deepEqual(t.byState, { active: 1, waiting: 6, delegating: 1, background: 0, error: 1 });
    assert.equal(t.completedToday, 1);
    assert.equal(t.abandonedToday, 0, 'the one abandoned yesterday does not count');
    assert.deepEqual(t.needingAttention, { total: 7, blocking: 4, yourTurn: 3 });
    assert.ok(t.costTodayUsd > 0);
    assert.equal(t.costEstimate, true);
    assert.equal(r.structuredContent.day, '2026-11-02');
    assert.match(r.content[0].text, /Custo de hoje \(estimativa\): US\$ \d+\.\d\d/);
  });

  test('split by account: each one’s cost and counts add up to the total', async () => {
    const d = (await callTool('fleet_overview')).structuredContent;
    const byLabel = Object.fromEntries(d.byAccount.map((c: any) => [c.account?.label ?? 'sem', c]));
    assert.deepEqual(Object.keys(byLabel).sort(), ['cliente', 'equipe', 'sem']);
    assert.equal(byLabel.equipe.live, 5);
    assert.equal(byLabel.equipe.completedToday, 1);
    assert.equal(byLabel.cliente.live, 3);
    assert.equal(byLabel.sem.live, 1);
    const sum = d.byAccount.reduce((s: number, c: any) => s + (c.costTodayUsd ?? 0), 0);
    assert.ok(Math.abs(sum - d.totals.costTodayUsd) < 0.02);
    // Same usage in the three sessions with cost: the team (two) costs twice the client (one).
    assert.ok(Math.abs(byLabel.equipe.costTodayUsd - 2 * byLabel.cliente.costTodayUsd) < 0.02);
  });

  test('the account filter applies to the totals and to the list of live sessions', async () => {
    const d = (await callTool('fleet_overview', { account: 'cliente' })).structuredContent;
    assert.equal(d.totals.live, 3);
    assert.deepEqual(d.byAccount.map((c: any) => c.account.label), ['cliente']);
    assert.deepEqual(d.activeSessions.items.map((s: any) => s.sessionId).sort(), ['delegando', 'interrompida', 'pergunta']);
    assert.deepEqual(d.accountFilter, ['cliente']);
  });

  test('live sessions paginated, with state and without conversation text', async () => {
    const r = await callTool('fleet_overview', { limit: 4 });
    const a = r.structuredContent.activeSessions;
    assert.equal(a.total, 9);
    assert.equal(a.items.length, 4);
    assert.ok(a.nextCursor);
    const delegating = (await callTool('fleet_overview', { limit: 50 })).structuredContent.activeSessions.items.find((s: any) => s.sessionId === 'delegando');
    assert.equal(delegating.state, 'delegating');
    assert.equal(delegating.needsYou, false);
    assert.equal(delegating.activeSubagents, 1);
    for (const t of [SECRET, QUESTION, MESSAGE]) assert.ok(!JSON.stringify(r).includes(t));
  });

  test('simulator scenario: the synthetic accounts and who needs you match the panel', async () => {
    const sim = openSqliteStorage({ path: ':memory:' });
    await seedPanelScenario(sim, 'p3', NOW);
    const accounts = new Accounts({ storage: sim, file: null });
    const { server: s } = createMcpServer({ storage: sim, accounts, now: () => NOW, timeZone: 'UTC' });
    const builder = new MontadorDoPainel({ storage: sim, contas: accounts, desktop: null, trabalho: null, agora: () => NOW });
    const panel = await builder.montar({ sessionId: 'nenhuma' });
    const mcp = (await callTool('sessions_needing_attention', {}, s)).structuredContent;
    // The panel's total counts only the ones that need you; your turn comes apart (#140).
    assert.equal(mcp.blocking, panel.needYou.total);
    assert.equal(mcp.yourTurn, panel.needYou.yourTurn);
    assert.deepEqual(
      mcp.byAccount.filter((c: any) => c.blocking > 0).map((c: any) => [c.account?.label, c.blocking]).sort(),
      panel.needYou.byAccount.map((c) => [c.account?.label, c.n]).sort(),
    );
    const fromPanel = new Map(panel.needYou.machine.map((i) => [i.id, i.level === 'needs' ? 'blocking' : 'your_turn']));
    for (const i of mcp.items) assert.equal(i.group, fromPanel.get(i.sessionId), i.sessionId);
    await sim.close();
  });
});

describe('output', () => {
  test('paginate stops at the item limit or the byte limit, with at least one item', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, x: 'a'.repeat(100) }));
    assert.equal(paginate(items, { start: 0, limit: 3 }).page.length, 3);
    const byBytes = paginate(items, { start: 0, limit: 50 }, 350);
    assert.equal(byBytes.page.length, 3);
    assert.ok(byBytes.nextCursor);
    assert.equal(paginate(items, { start: 0, limit: 50 }, 10).page.length, 1);
    assert.equal(paginate(items, { start: 8, limit: 5 }).nextCursor, null);
  });

  test('title without control characters, without line breaks and short', () => {
    assert.equal(safeTitle('linha 1\nlinha 2\u0007‮'), 'linha 1 linha 2');
    assert.equal(safeTitle('x'.repeat(100))!.length, 60);
    assert.equal(safeTitle('  \n '), null);
  });
});

describe('transports', () => {
  let api: LocalApi;
  beforeEach(async () => {
    await seedCases();
    const accounts = new Accounts({ storage, file: null });
    const builder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null });
    api = await startLocalApi({ panelBuilder: builder, hooks: { storage }, port: 0, log: () => {}, mcp: server });
  });
  afterEach(() => api.close());

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${api.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  test('HTTP at /mcp: JSON-RPC over POST, without a session, in both versions', async () => {
    for (const v of ['2025-03-26', '2025-06-18']) {
      const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(r.headers.get('mcp-session-id'), null);
      assert.equal(((await r.json()) as any).result.protocolVersion, v);
    }
    const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(((await call.json()) as any).result.structuredContent.totals.live, 9);
  });

  test('HTTP: a notification gives 202, GET and DELETE give 405, an unknown version and broken JSON give 400', async () => {
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const get = await fetch(`${api.url}/mcp`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${api.url}/mcp`, { method: 'DELETE' })).status, 405);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
    const broken = await post('{nao json');
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as any).error.code, -32700);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' })).status, 415);
  });

  test('HTTP: a request with Origin, or with an outside Host (DNS rebinding), is refused (decision 0003)', async () => {
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://exemplo.invalid' })).status, 403);
    // fetch does not let us change the Host: go through Node's http.
    const port = new URL(api.url).port;
    for (const host of ['exemplo.invalid', `exemplo.invalid:${port}`, `127.0.0.1.exemplo.invalid:${port}`]) {
      const status = await new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = request(`${api.url}/mcp`, { method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.equal(status, 403, host);
    }
  });

  test('HTTP: a body above 1 MB gives 413', async () => {
    const large = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(1024 * 1024) } });
    const r = await post(large);
    assert.equal(r.status, 413);
    assert.match(((await r.json()) as any).error.message, /grande demais/);
    const ping = await post({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(ping.status, 200, 'the server keeps answering');
  });

  test('httpBridge: the Desktop path goes back and forth through the core’s /mcp', async () => {
    const bridge = httpBridge(`${api.url}/mcp`, { withoutCore: async () => assert.fail('the core is up') });
    const init = (await bridge({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as JsonRpcResponse;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.equal(await bridge({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const r = (await bridge({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sessions_needing_attention', arguments: { limit: 2 } } })) as JsonRpcResponse;
    assert.equal(r.id, 7);
    assert.equal((r.result as CallResult).structuredContent.items.length, 2);
    const batch = (await bridge([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])) as JsonRpcResponse[];
    assert.deepEqual(batch.map((m) => m.id).sort(), ['a', 'b']);
  });

  test('httpBridge: the core’s 4xx comes back with the request id', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP-Protocol-Version não suportada' } }), { status: 400 })) as typeof fetch;
    const bridge = httpBridge('http://127.0.0.1:1/mcp', { fetcher, withoutCore: async () => null });
    const r = (await bridge({ jsonrpc: '2.0', id: 42, method: 'ping' })) as JsonRpcResponse;
    assert.equal(r.id, 42);
    assert.equal(r.error?.code, -32600);
    const garbage = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    const r2 = (await httpBridge('http://127.0.0.1:1/mcp', { fetcher: garbage, withoutCore: async () => null })({ jsonrpc: '2.0', id: 'x', method: 'ping' })) as JsonRpcResponse;
    assert.equal(r2.id, 'x');
    assert.match(r2.error!.message, /HTTP 502/);
  });

  test('httpBridge without the core: initialize and tools/list answer; tools/call comes back with isError', async () => {
    await api.close();
    const withoutCore = serverWithoutCore('suba o núcleo');
    const bridge = httpBridge(`${api.url}/mcp`, { withoutCore: (m) => withoutCore.handle(m) });
    const init = (await bridge({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as JsonRpcResponse;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-03-26');
    const list = (await bridge({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as JsonRpcResponse;
    const real = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as JsonRpcResponse;
    assert.deepEqual(list.result, real.result, 'the same list and the same schemas');
    const call = (await bridge({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } })) as JsonRpcResponse;
    assert.equal(call.id, 3);
    assert.deepEqual(call.result, { content: [{ type: 'text', text: 'suba o núcleo' }], isError: true });
    api = await startLocalApi({ panelBuilder: new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: server });
  });

  test('stdio: one message per line, only JSON on the output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    const done = serveStdio({ handle: (m) => server.handle(m), input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('não é json\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sessions_needing_attention","arguments":{"limit":1}}}\n');
    await done;
    const msgs = lines.map((l) => JSON.parse(l));
    assert.equal(msgs.length, 3);
    assert.equal(msgs.find((m) => m.id === 1).result.protocolVersion, '2025-06-18');
    assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
    assert.equal(msgs.find((m) => m.id === 2).result.structuredContent.items.length, 1);
  });
});
