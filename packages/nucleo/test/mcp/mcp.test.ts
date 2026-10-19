// Servidor MCP (2.1): protocolo, transportes HTTP e stdio, e as ferramentas
// `sessions_needing_attention` e `fleet_overview`, com dados sintéticos (fixtures e simulador).

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import {
  atenderPorStdio,
  criarServidorMcp,
  paginar,
  ponteHttp,
  servidorSemNucleo,
  ServidorMcp,
  tituloSeguro,
  VERSAO_MAIS_NOVA,
  type Ferramenta,
  type RespostaJsonRpc,
} from '../../src/mcp/index.ts';
import { semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { agent, at, event, session } from '../fixtures.ts';
import { AGORA, c2, MENSAGEM, PERGUNTA, SEGREDO, semear as semearCasos } from './helpers.ts';

type Resultado = { content: { type: string; text: string }[]; structuredContent: any; isError: boolean };

let storage: SqliteStorage;
let servidor: ServidorMcp;
let n = 0;
const semear = () => semearCasos(storage);

async function chamar(nome: string, args: Record<string, unknown> = {}, s = servidor): Promise<Resultado> {
  const r = (await s.atender({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: nome, arguments: args } })) as RespostaJsonRpc;
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.result as Resultado;
}

beforeEach(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  ({ servidor } = criarServidorMcp({ storage, contas: new Contas({ storage, arquivo: null }), agora: () => AGORA, fusoHorario: 'UTC' }));
});
afterEach(() => storage.close());

describe('protocolo', () => {
  test('initialize devolve a versão pedida quando a conhece, e a mais nova quando não', async () => {
    for (const v of ['2025-03-26', '2025-06-18', '2025-11-25', '2024-11-05']) {
      const r = (await servidor.atender({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {} } })) as RespostaJsonRpc;
      assert.equal((r.result as { protocolVersion: string }).protocolVersion, v);
    }
    const r = (await servidor.atender({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })) as RespostaJsonRpc;
    const res = r.result as { protocolVersion: string; capabilities: object; serverInfo: { name: string } };
    assert.equal(res.protocolVersion, VERSAO_MAIS_NOVA);
    assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
    assert.equal(res.serverInfo.name, 'ahrena-console');
  });

  test('tools/list: as duas ferramentas, só de leitura, com esquema de entrada e de saída', async () => {
    const r = (await servidor.atender({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as RespostaJsonRpc;
    const tools = (r.result as { tools: { name: string; inputSchema: { type: string }; outputSchema: object; annotations: { readOnlyHint: boolean } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ['sessions_needing_attention', 'fleet_overview']);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.outputSchema);
    }
  });

  test('notificação não tem resposta; lote responde só aos pedidos; método desconhecido é -32601', async () => {
    assert.equal(await servidor.atender({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const lote = (await servidor.atender([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', id: 'b', method: 'resources/list' },
    ])) as RespostaJsonRpc[];
    assert.deepEqual(lote.map((r) => [r.id, r.error?.code ?? 'ok']), [['a', 'ok'], ['b', -32601]]);
    const ruim = (await servidor.atender({ id: 1, method: 'ping' })) as RespostaJsonRpc;
    assert.equal(ruim.error?.code, -32600);
  });

  test('ferramenta desconhecida é -32602; argumento errado volta como isError para o modelo corrigir', async () => {
    const r = (await servidor.atender({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_sql' } })) as RespostaJsonRpc;
    assert.equal(r.error?.code, -32602);
    for (const args of [{ limit: 0 }, { limit: 51 }, { cursor: 'xyz' }, { account: 3 }, { group: 'urgente' }, { coisa: 1 }]) {
      const res = await chamar('sessions_needing_attention', args);
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });

  test('registrar: ponto de entrada das ferramentas novas, com nome único e no máximo 10', async () => {
    const f = (nome: string): Ferramenta => ({
      nome,
      titulo: nome,
      descricao: nome,
      entrada: { type: 'object' },
      executar: async (_args, ctx) => ({ texto: 'ok', dados: { abortado: ctx.sinal.aborted } }),
    });
    servidor.registrar(f('wait_for_changes'));
    assert.deepEqual((await chamar('wait_for_changes')).structuredContent, { abortado: false });
    assert.throws(() => servidor.registrar(f('wait_for_changes')), /já registrada/);
    assert.throws(() => servidor.registrar(f('Nome-Ruim')), /inválido/);
    for (let i = 0; i < 7; i++) servidor.registrar(f(`extra_${i}`));
    assert.throws(() => servidor.registrar(f('extra_8')), /no máximo 10/);
  });
});

describe('sessions_needing_attention', () => {
  beforeEach(semear);

  test('separa as que travam a sessão das que estão na sua vez, com motivo, espera, conta e como abrir', async () => {
    const r = await chamar('sessions_needing_attention');
    const d = r.structuredContent;
    assert.equal(r.isError, false);
    assert.equal(d.total, 7);
    assert.equal(d.blocking, 4);
    assert.equal(d.yourTurn, 3);
    // Travadas primeiro; em cada grupo, quem espera há mais tempo primeiro.
    assert.deepEqual(
      d.items.map((i: any) => [i.sessionId, i.group, i.reason]),
      [
        ['plano', 'blocking', 'plan'],
        ['permissao', 'blocking', 'permission'],
        ['erro', 'blocking', 'error'],
        ['pergunta', 'blocking', 'question'],
        // Esc é a sua vez, como no painel (atencaoDe, #140).
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

  test('com a sessão no índice do Desktop, open traz o link que abre a conversa', async () => {
    const local = 'local_00000000-0000-4000-8000-000000000001';
    const desktop = { atualizar: async () => {}, sessaoPorCli: (id: string) => (id === 'permissao' ? { localId: local, cliSessionId: id, titulo: 'Migrar\no banco', branch: null, cwd: null, maeLocalId: null, arquivada: false, contas: [] } : null) };
    const { servidor: s } = criarServidorMcp({ storage, contas: new Contas({ storage, arquivo: null }), desktop: desktop as never, agora: () => AGORA, fusoHorario: 'UTC' });
    const itens = (await chamar('sessions_needing_attention', {}, s)).structuredContent.items;
    const p = itens.find((i: any) => i.sessionId === 'permissao');
    assert.equal(p.title, 'Migrar o banco');
    assert.deepEqual(p.open, { resume: 'claude --resume permissao', cwd: '/repo/app', desktopSessionId: local, desktopLink: `claude://claude.ai/epitaxy/${local}` });
    assert.equal(itens.find((i: any) => i.sessionId === 'plano').open.desktopLink, null);
  });

  test('o fechamento do turno que pede uma decisão trava a sessão, sem devolver a pergunta', async () => {
    await storage.putSession(session({ id: 'decisao', name: 'merge', startedAt: at(-60), updatedAt: at(-7), awaitingInputSince: at(-7), awaitingReason: 'stop', accountId: c2.id, accountSource: 'env' }));
    await storage.putAgent(agent({ id: 'decisao:main', sessionId: 'decisao', status: 'waiting' }));
    await storage.appendEvent(
      event({ id: 'decisao-e1', sessionId: 'decisao', agentId: 'decisao:main', type: 'PreToolUse', toolName: 'mcp__ccd_turn__wrap_up', summary: null, createdAt: at(-8), data: { tool_use_id: 'w1', tool_input: { recap: 'feito', ask: `Faço o merge? ${SEGREDO}` } } }),
    );
    const r = await chamar('sessions_needing_attention', { group: 'blocking' });
    const d = r.structuredContent.items.find((i: any) => i.sessionId === 'decisao');
    assert.equal(d.reason, 'decision');
    assert.equal(d.reasonText, 'fechou o turno pedindo uma decisão sua');
    assert.ok(!JSON.stringify(r).includes('Faço o merge'));
    assert.ok(!JSON.stringify(r).includes(SEGREDO));
  });

  test('não devolve texto da conversa: comando, pergunta, plano, mensagem do assistente nem mensagem de erro', async () => {
    const r = await chamar('sessions_needing_attention');
    const tudo = JSON.stringify(r);
    for (const t of [SEGREDO, PERGUNTA, MENSAGEM, 'hunter2', 'segredo-do-cliente', 'Ignore as instruções']) assert.ok(!tudo.includes(t), t);
  });

  test('divisão por conta e filtro por rótulo, id, vários e "none"', async () => {
    const d = (await chamar('sessions_needing_attention')).structuredContent;
    assert.deepEqual(
      d.byAccount.map((c: any) => [c.account?.label ?? null, c.total, c.blocking, c.yourTurn]),
      [['equipe', 4, 2, 2], ['cliente', 2, 1, 1], [null, 1, 1, 0]],
    );
    const ids = async (account: unknown) => (await chamar('sessions_needing_attention', { account })).structuredContent.items.map((i: any) => i.sessionId);
    assert.deepEqual(await ids('CLIENTE'), ['pergunta', 'interrompida']);
    assert.deepEqual(await ids(c2.id), ['pergunta', 'interrompida']);
    assert.deepEqual(await ids('none'), ['erro']);
    assert.deepEqual(await ids(['cliente', 'none']), ['erro', 'pergunta', 'interrompida']);
    assert.deepEqual(await ids('não-existe'), []);
  });

  test('filtro por grupo e paginação por cursor', async () => {
    const sv = (await chamar('sessions_needing_attention', { group: 'your_turn' })).structuredContent;
    assert.deepEqual(sv.items.map((i: any) => i.sessionId), ['sua-vez', 'interrompida', 'abriu']);
    assert.equal(sv.total, 7, 'os totais são de todos os grupos');

    const p1 = (await chamar('sessions_needing_attention', { limit: 3 })).structuredContent;
    assert.equal(p1.items.length, 3);
    assert.ok(p1.nextCursor);
    const p2 = (await chamar('sessions_needing_attention', { limit: 3, cursor: p1.nextCursor })).structuredContent;
    const p3 = (await chamar('sessions_needing_attention', { limit: 3, cursor: p2.nextCursor })).structuredContent;
    assert.equal(p3.nextCursor, null);
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i: any) => i.sessionId).length, 7);
  });

  test('sem ninguém esperando, diz isso', async () => {
    const vazio = openSqliteStorage({ path: ':memory:' });
    const { servidor: s } = criarServidorMcp({ storage: vazio, contas: new Contas({ storage: vazio, arquivo: null }), agora: () => AGORA, fusoHorario: 'UTC' });
    const r = await chamar('sessions_needing_attention', {}, s);
    assert.equal(r.content[0].text, 'Nenhuma sessão precisa de você agora.');
    assert.equal(r.structuredContent.total, 0);
    await vazio.close();
  });
});

describe('fleet_overview', () => {
  beforeEach(semear);

  test('totais por estado, encerradas de hoje, quem precisa de você e custo de hoje', async () => {
    const r = await chamar('fleet_overview');
    const t = r.structuredContent.totals;
    assert.equal(t.live, 9);
    assert.deepEqual(t.byState, { active: 1, waiting: 6, delegating: 1, background: 0, error: 1 });
    assert.equal(t.completedToday, 1);
    assert.equal(t.abandonedToday, 0, 'a abandonada de ontem não conta');
    assert.deepEqual(t.needingAttention, { total: 7, blocking: 4, yourTurn: 3 });
    assert.ok(t.costTodayUsd > 0);
    assert.equal(t.costEstimate, true);
    assert.equal(r.structuredContent.day, '2026-11-02');
    assert.match(r.content[0].text, /Custo de hoje \(estimativa\): US\$ \d+\.\d\d/);
  });

  test('divisão por conta: o custo e as contagens de cada uma somam o total', async () => {
    const d = (await chamar('fleet_overview')).structuredContent;
    const porRotulo = Object.fromEntries(d.byAccount.map((c: any) => [c.account?.label ?? 'sem', c]));
    assert.deepEqual(Object.keys(porRotulo).sort(), ['cliente', 'equipe', 'sem']);
    assert.equal(porRotulo.equipe.live, 5);
    assert.equal(porRotulo.equipe.completedToday, 1);
    assert.equal(porRotulo.cliente.live, 3);
    assert.equal(porRotulo.sem.live, 1);
    const soma = d.byAccount.reduce((s: number, c: any) => s + (c.costTodayUsd ?? 0), 0);
    assert.ok(Math.abs(soma - d.totals.costTodayUsd) < 0.02);
    // Mesmo uso nas três sessões com custo: a equipe (duas) custa o dobro do cliente (uma).
    assert.ok(Math.abs(porRotulo.equipe.costTodayUsd - 2 * porRotulo.cliente.costTodayUsd) < 0.02);
  });

  test('filtro account vale para os totais e para a lista de sessões vivas', async () => {
    const d = (await chamar('fleet_overview', { account: 'cliente' })).structuredContent;
    assert.equal(d.totals.live, 3);
    assert.deepEqual(d.byAccount.map((c: any) => c.account.label), ['cliente']);
    assert.deepEqual(d.activeSessions.items.map((s: any) => s.sessionId).sort(), ['delegando', 'interrompida', 'pergunta']);
    assert.deepEqual(d.accountFilter, ['cliente']);
  });

  test('sessões vivas paginadas, com estado e sem texto da conversa', async () => {
    const r = await chamar('fleet_overview', { limit: 4 });
    const a = r.structuredContent.activeSessions;
    assert.equal(a.total, 9);
    assert.equal(a.items.length, 4);
    assert.ok(a.nextCursor);
    const delegando = (await chamar('fleet_overview', { limit: 50 })).structuredContent.activeSessions.items.find((s: any) => s.sessionId === 'delegando');
    assert.equal(delegando.state, 'delegating');
    assert.equal(delegando.needsYou, false);
    assert.equal(delegando.activeSubagents, 1);
    for (const t of [SEGREDO, PERGUNTA, MENSAGEM]) assert.ok(!JSON.stringify(r).includes(t));
  });

  test('cenário do simulador: as contas sintéticas e quem precisa de você batem com o painel', async () => {
    const sim = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(sim, 'p3', AGORA);
    const contas = new Contas({ storage: sim, arquivo: null });
    const { servidor: s } = criarServidorMcp({ storage: sim, contas, agora: () => AGORA, fusoHorario: 'UTC' });
    const montador = new MontadorDoPainel({ storage: sim, contas, desktop: null, trabalho: null, agora: () => AGORA });
    const painel = await montador.montar({ sessionId: 'nenhuma' });
    const mcp = (await chamar('sessions_needing_attention', {}, s)).structuredContent;
    // O total do painel conta só as que precisam de você; a sua vez vem à parte (#140).
    assert.equal(mcp.blocking, painel.precisam.total);
    assert.equal(mcp.yourTurn, painel.precisam.suaVez);
    assert.deepEqual(
      mcp.byAccount.filter((c: any) => c.blocking > 0).map((c: any) => [c.account?.label, c.blocking]).sort(),
      painel.precisam.porConta.map((c) => [c.conta?.rotulo, c.n]).sort(),
    );
    const doPainel = new Map(painel.precisam.maquina.map((i) => [i.id, i.nivel === 'precisa' ? 'blocking' : 'your_turn']));
    for (const i of mcp.items) assert.equal(i.group, doPainel.get(i.sessionId), i.sessionId);
    await sim.close();
  });
});

describe('saída', () => {
  test('paginar para no limite de itens ou no de bytes, com ao menos um item', () => {
    const itens = Array.from({ length: 10 }, (_, i) => ({ i, x: 'a'.repeat(100) }));
    assert.equal(paginar(itens, { inicio: 0, limite: 3 }).pagina.length, 3);
    const porBytes = paginar(itens, { inicio: 0, limite: 50 }, 350);
    assert.equal(porBytes.pagina.length, 3);
    assert.ok(porBytes.nextCursor);
    assert.equal(paginar(itens, { inicio: 0, limite: 50 }, 10).pagina.length, 1);
    assert.equal(paginar(itens, { inicio: 8, limite: 5 }).nextCursor, null);
  });

  test('título sem controle, sem quebra e curto', () => {
    assert.equal(tituloSeguro('linha 1\nlinha 2\u0007‮'), 'linha 1 linha 2');
    assert.equal(tituloSeguro('x'.repeat(100))!.length, 60);
    assert.equal(tituloSeguro('  \n '), null);
  });
});

describe('transportes', () => {
  let api: ApiLocal;
  beforeEach(async () => {
    await semear();
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, mcp: servidor });
  });
  afterEach(() => api.close());

  const post = (corpo: unknown, headers: Record<string, string> = {}) =>
    fetch(`${api.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    });

  test('HTTP em /mcp: JSON-RPC por POST, sem sessão, nas duas versões', async () => {
    for (const v of ['2025-03-26', '2025-06-18']) {
      const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(r.headers.get('mcp-session-id'), null);
      assert.equal(((await r.json()) as any).result.protocolVersion, v);
    }
    const chamada = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' });
    assert.equal(((await chamada.json()) as any).result.structuredContent.totals.live, 9);
  });

  test('HTTP: notificação dá 202, GET e DELETE dão 405, versão desconhecida e JSON quebrado dão 400', async () => {
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const get = await fetch(`${api.url}/mcp`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${api.url}/mcp`, { method: 'DELETE' })).status, 405);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
    const quebrado = await post('{nao json');
    assert.equal(quebrado.status, 400);
    assert.equal(((await quebrado.json()) as any).error.code, -32700);
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' })).status, 415);
  });

  test('HTTP: pedido com Origin, ou com Host de fora (DNS rebinding), é recusado (decisão 0003)', async () => {
    assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://exemplo.invalid' })).status, 403);
    // O fetch não deixa trocar o Host: vai pelo http do Node.
    const porta = new URL(api.url).port;
    for (const host of ['exemplo.invalid', `exemplo.invalid:${porta}`, `127.0.0.1.exemplo.invalid:${porta}`]) {
      const status = await new Promise<number>((resolve, reject) => {
        const corpo = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = request(`${api.url}/mcp`, { method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo) } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(corpo);
      });
      assert.equal(status, 403, host);
    }
  });

  test('HTTP: corpo acima de 1 MB dá 413', async () => {
    const grande = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(1024 * 1024) } });
    const r = await post(grande);
    assert.equal(r.status, 413);
    assert.match(((await r.json()) as any).error.message, /grande demais/);
    const ping = await post({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(ping.status, 200, 'o servidor continua respondendo');
  });

  test('ponteHttp: o caminho do Desktop leva e traz pelo /mcp do núcleo', async () => {
    const ponte = ponteHttp(`${api.url}/mcp`, { semNucleo: async () => assert.fail('o núcleo está no ar') });
    const init = (await ponte({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as RespostaJsonRpc;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.equal(await ponte({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const r = (await ponte({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sessions_needing_attention', arguments: { limit: 2 } } })) as RespostaJsonRpc;
    assert.equal(r.id, 7);
    assert.equal((r.result as Resultado).structuredContent.items.length, 2);
    const lote = (await ponte([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])) as RespostaJsonRpc[];
    assert.deepEqual(lote.map((m) => m.id).sort(), ['a', 'b']);
  });

  test('ponteHttp: o 4xx do núcleo volta com o id do pedido', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP-Protocol-Version não suportada' } }), { status: 400 })) as typeof fetch;
    const ponte = ponteHttp('http://127.0.0.1:1/mcp', { fetcher, semNucleo: async () => null });
    const r = (await ponte({ jsonrpc: '2.0', id: 42, method: 'ping' })) as RespostaJsonRpc;
    assert.equal(r.id, 42);
    assert.equal(r.error?.code, -32600);
    const lixo = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    const r2 = (await ponteHttp('http://127.0.0.1:1/mcp', { fetcher: lixo, semNucleo: async () => null })({ jsonrpc: '2.0', id: 'x', method: 'ping' })) as RespostaJsonRpc;
    assert.equal(r2.id, 'x');
    assert.match(r2.error!.message, /HTTP 502/);
  });

  test('ponteHttp sem o núcleo: initialize e tools/list respondem; tools/call volta com isError', async () => {
    await api.close();
    const semNucleo = servidorSemNucleo('suba o núcleo');
    const ponte = ponteHttp(`${api.url}/mcp`, { semNucleo: (m) => semNucleo.atender(m) });
    const init = (await ponte({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as RespostaJsonRpc;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-03-26');
    const lista = (await ponte({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as RespostaJsonRpc;
    const real = (await servidor.atender({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as RespostaJsonRpc;
    assert.deepEqual(lista.result, real.result, 'a mesma lista e os mesmos esquemas');
    const chamada = (await ponte({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } })) as RespostaJsonRpc;
    assert.equal(chamada.id, 3);
    assert.deepEqual(chamada.result, { content: [{ type: 'text', text: 'suba o núcleo' }], isError: true });
    api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: servidor });
  });

  test('stdio: uma mensagem por linha, só JSON na saída', async () => {
    const entrada = new PassThrough();
    const saida = new PassThrough();
    const linhas: string[] = [];
    saida.on('data', (b: Buffer) => linhas.push(...b.toString().split('\n').filter(Boolean)));
    const fim = atenderPorStdio({ atender: (m) => servidor.atender(m), entrada, saida });
    entrada.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    entrada.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    entrada.write('não é json\n');
    entrada.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sessions_needing_attention","arguments":{"limit":1}}}\n');
    await fim;
    const msgs = linhas.map((l) => JSON.parse(l));
    assert.equal(msgs.length, 3);
    assert.equal(msgs.find((m) => m.id === 1).result.protocolVersion, '2025-06-18');
    assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
    assert.equal(msgs.find((m) => m.id === 2).result.structuredContent.items.length, 1);
  });
});
