// A tela Analytics (#95 e #32): `GET /api/analytics` (Visão geral) e `GET /api/analytics/cost` (Custo; a rota antiga `/api/analytics/custo` responde o corpo antigo),
// com fixtures sintéticas, relógio fixo e o histórico simulado da --demo.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, normalizeLegacyUrl, TrabalhoPorBranch, type ApiLocal } from '../../src/api/index.ts';
import { DAYS_ERROR, RotaAnalytics, TZ_ERROR } from '../../src/api/rota-analytics.ts';
import type { TokenCounts } from '../../src/model.ts';
import { semearHistorico } from '../../src/simulator/history.ts';
import { semearCenariosDoPainel } from '../../src/simulator/panel.ts';
import { account, agent, event, session } from '../fixtures.ts';

// Terça-feira, 12h em São Paulo.
const AGORA = Date.parse('2026-10-20T15:00:00.000Z');
const diasAtras = (n: number, hora = '14:00:00') => `${new Date(AGORA - n * 86_400_000).toISOString().slice(0, 10)}T${hora}.000Z`;
const perto = (a: number | null | undefined, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-4, `${a} ≠ ${b}`);
const tk = (input: number, output: number, cacheRead = 0): TokenCounts => ({ input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 });
const comUso = (id: string, sessionId: string, createdAt: string, model: string, tokens: TokenCounts, messageId: string) =>
  event({ id, sessionId, agentId: null, type: 'AssistantMessage', toolName: null, summary: null, createdAt, data: { usage: { messageId, model, tokens } } });
const ferramenta = (id: string, sessionId: string, createdAt: string, type: string, toolName: string, data: unknown = null) =>
  event({ id, sessionId, agentId: null, type, toolName, summary: null, createdAt, data });

// Default prices (src/cost/default-prices.ts), in US$ per million.
const OPUS = (1000 * 4 + 1000 * 20 + 3000 * 0.2) / 1e6; // s1, hoje
const SONNET = (2000 * 2 + 500 * 10) / 1e6; // s1, há 5 dias
const HAIKU = (10_000 * 0.1 + 2000 * 0.5) / 1e6; // s4, hoje 01:30 UTC (ontem em São Paulo)

async function fixtures(): Promise<SqliteStorage> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const c1 = account({ n: 1 });
  const c2 = account({ n: 2 });
  await storage.putAccount(c1);
  await storage.putAccount(c2);

  // s1: conta 1, ativa, hoje e há 5 dias. A mesma chamada vem do hook e do transcript: conta uma vez.
  await storage.putSession(session({ id: 's1', cwd: '/simulacao/vitrine-demo', status: 'active', startedAt: diasAtras(5), updatedAt: diasAtras(0), accountId: c1.id, accountSource: 'config' }));
  await storage.putAgent(agent({ id: 's1:main', sessionId: 's1', status: 'working' }));
  await storage.putAgent(agent({ id: 's1:a1', sessionId: 's1', type: 'subagent', status: 'completed' }));
  await storage.appendEvent(ferramenta('s1-e1', 's1', diasAtras(0, '13:00:00'), 'PreToolUse', 'Bash', { tool_use_id: 't1' }));
  await storage.appendEvent(ferramenta('s1-e2', 's1', diasAtras(0, '13:00:01'), 'ToolUse', 'Bash', { toolUseId: 't1' }));
  await storage.appendEvent(ferramenta('s1-e3', 's1', diasAtras(0, '13:00:02'), 'PostToolUse', 'Bash', { tool_use_id: 't1' }));
  await storage.appendEvent(ferramenta('s1-e4', 's1', diasAtras(0, '13:01:00'), 'PreToolUse', 'Read', { tool_use_id: 't2' }));
  await storage.appendEvent(comUso('s1-e5', 's1', diasAtras(0, '13:02:00'), 'claude-opus-5-5', tk(1000, 1000, 3000), 'm1'));
  await storage.appendEvent(ferramenta('s1-e6', 's1', diasAtras(5), 'ToolUse', 'Read', { toolUseId: 't3' }));
  await storage.appendEvent(comUso('s1-e7', 's1', diasAtras(5, '14:01:00'), 'claude-sonnet-5-5', tk(2000, 500), 'm2'));

  // s2: conta 2, há 2 dias, só com modelo sem preço; chamadas sem id contam cada uma.
  await storage.putSession(session({ id: 's2', cwd: '/simulacao/app-receitas/', status: 'completed', startedAt: diasAtras(2), updatedAt: diasAtras(2, '15:00:00'), accountId: c2.id, accountSource: 'env' }));
  await storage.putAgent(agent({ id: 's2:main', sessionId: 's2', status: 'completed' }));
  await storage.appendEvent(comUso('s2-e1', 's2', diasAtras(2), 'modelo-sem-preco', tk(500, 100), 'm3'));
  await storage.appendEvent(ferramenta('s2-e2', 's2', diasAtras(2, '14:10:00'), 'PreToolUse', 'Grep'));
  await storage.appendEvent(ferramenta('s2-e3', 's2', diasAtras(2, '14:11:00'), 'PreToolUse', 'Grep'));

  // s3: sem conta, há 100 dias: só no heatmap.
  await storage.putSession(session({ id: 's3', cwd: null, status: 'completed', startedAt: diasAtras(100), updatedAt: diasAtras(100), accountId: null, accountSource: null }));
  await storage.appendEvent(ferramenta('s3-e1', 's3', diasAtras(100), 'PreToolUse', 'Bash'));

  // s4: sem conta, sem pasta, hoje 01:30 UTC (ontem em São Paulo).
  await storage.putSession(session({ id: 's4', cwd: null, status: 'completed', startedAt: diasAtras(0, '01:00:00'), updatedAt: diasAtras(0, '01:30:00'), accountId: null, accountSource: null }));
  await storage.appendEvent(comUso('s4-e1', 's4', diasAtras(0, '01:30:00'), 'claude-haiku-5-5', tk(10_000, 2000), 'm4'));
  return storage;
}

function rota(storage: SqliteStorage, relogio = { agora: AGORA }) {
  return new RotaAnalytics({ storage, contas: new Contas({ storage, arquivo: null }), agora: () => relogio.agora });
}

// The handlers read the English parameters; the old ones in these strings pass through the alias map.
async function pedirRota(r: RotaAnalytics, caminho: string) {
  return r.responder(normalizeLegacyUrl(new URL(caminho, 'http://127.0.0.1')));
}

/** As respostas lidas nos testes. */
type Json = any;

describe('GET /api/analytics (Visão geral)', () => {
  let storage: SqliteStorage;
  before(async () => (storage = await fixtures()));
  after(() => storage.close());

  test('janela de 30 dias, números, custo com e sem preço e a divisão por conta', async () => {
    const { status, corpo } = await pedirRota(rota(storage), '/api/analytics');
    const v = corpo as Json;
    assert.equal(status, 200);
    assert.equal(v.timeZone, 'UTC');
    assert.equal(v.today, '2026-10-20');
    assert.equal(v.since, '2026-09-21');
    assert.equal(v.until, '2026-10-20');
    assert.deepEqual(v.accounts.map((c: Json) => [c.label, c.id === null]), [['Conta 1', false], ['Conta 2', false], ['Sem conta', true]]);

    assert.deepEqual(v.numbers.sessions, { total: 3, active: 1 });
    assert.deepEqual(v.numbers.agents, { total: 3, active: 1 });
    assert.equal(v.numbers.tokens.total, 5000 + 2500 + 600 + 12_000);
    assert.equal(v.numbers.tokens.cachePct, 18.2); // 3000 / (1000 + 3000 + 2000 + 500 + 10000)
    perto(v.numbers.cost.usd, OPUS + SONNET + HAIKU);
    assert.equal(v.numbers.cost.days, 30);
    assert.deepEqual(v.numbers.cost.unpriced, ['modelo-sem-preco']);
    const porConta = v.numbers.cost.byAccount;
    perto(porConta[0].usd, OPUS + SONNET);
    assert.equal(porConta[1].usd, null, 'só sem preço: null, nunca zero');
    assert.deepEqual([porConta[2].account, porConta[2].usd], [null, HAIKU]);
    assert.deepEqual(v.numbers.events, { total: 11, perSession: 3.7 });
  });

  test('ferramentas: Pre do hook e ToolUse do transcript com o mesmo id contam uma vez; Post não conta', async () => {
    const v = (await pedirRota(rota(storage), '/api/analytics')).corpo as Json;
    assert.deepEqual(v.tools, [{ name: 'Grep', uses: 2 }, { name: 'Read', uses: 2 }, { name: 'Bash', uses: 1 }]);
    assert.deepEqual(v.tokensByModel.map((m: Json) => m.model), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'modelo-sem-preco']);
  });

  test('últimos 30 dias, dia da semana e o heatmap de 52 semanas alinhado à segunda', async () => {
    const v = (await pedirRota(rota(storage), '/api/analytics')).corpo as Json;
    const u = v.last30;
    assert.equal(u.days.length, 30);
    assert.equal(u.days.at(-1).day, '2026-10-20');
    const de = (dia: string) => u.days.find((d: Json) => d.day === dia)?.sessions;
    assert.equal(de('2026-10-20'), 2); // s1 e s4
    assert.equal(de('2026-10-18'), 1);
    assert.equal(de('2026-10-15'), 1);
    assert.equal(u.total, 4);
    assert.deepEqual(u.peak, { day: '2026-10-20', sessions: 2 });
    assert.deepEqual(v.weekday.map((d: Json) => d.day), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    assert.equal(v.weekday.reduce((s: number, d: Json) => s + d.sessions, 0), u.total);
    assert.equal(v.weekday[1].sessions, 2); // terça

    const a = v.activity;
    assert.equal(a.weeks, 52);
    assert.equal(a.since, '2025-10-27');
    assert.equal(new Date(`${a.days[0].day}T00:00:00Z`).getUTCDay(), 1, 'começa numa segunda');
    assert.equal(a.days.length, 51 * 7 + 2);
    assert.equal(a.days.at(-1).day, '2026-10-20');
    assert.equal(a.days.find((d: Json) => d.day === diasAtras(100).slice(0, 10)).events, 1);
    assert.equal(a.days.find((d: Json) => d.day === '2026-10-20').events, 6);
  });

  test('?fuso= muda o dia: 01:30 UTC de hoje é ontem em São Paulo', async () => {
    const v = (await pedirRota(rota(storage), '/api/analytics?fuso=America/Sao_Paulo')).corpo as Json;
    assert.equal(v.timeZone, 'America/Sao_Paulo');
    const de = (dia: string) => v.last30.days.find((d: Json) => d.day === dia)?.sessions;
    assert.equal(de('2026-10-20'), 1);
    assert.equal(de('2026-10-19'), 1);
  });

  test('fuso inválido e caminho desconhecido', async () => {
    const r = rota(storage);
    for (const f of ['Marte/Base', '../etc', 'a'.repeat(80)]) assert.equal((await pedirRota(r, `/api/analytics?fuso=${encodeURIComponent(f)}`)).status, 400, f);
    assert.equal((await pedirRota(r, '/api/analytics/outra')).status, 404);
  });

  test('a Visão geral fica 30 s em memória por rota e parâmetros', async () => {
    const relogio = { agora: AGORA };
    const r = rota(storage, relogio);
    const a = (await pedirRota(r, '/api/analytics')).corpo as Json;
    await storage.appendEvent(ferramenta('s1-e9', 's1', diasAtras(0, '14:00:00'), 'PreToolUse', 'Edit', { tool_use_id: 't9' }));
    relogio.agora += 5_000;
    const b = (await pedirRota(r, '/api/analytics')).corpo as Json;
    assert.equal(b.generatedAt, a.generatedAt);
    assert.equal(b.numbers.events.total, 11);
    const outroFuso = (await pedirRota(r, '/api/analytics?fuso=America/Sao_Paulo')).corpo as Json;
    assert.notEqual(outroFuso.generatedAt, a.generatedAt);
    relogio.agora += 20_000;
    assert.equal(((await pedirRota(r, '/api/analytics')).corpo as Json).generatedAt, a.generatedAt, '25 s: ainda a mesma');
    relogio.agora += 6_000;
    const c = (await pedirRota(r, '/api/analytics')).corpo as Json;
    assert.equal(c.numbers.events.total, 12);
  });

  test('com o cursor de mudanças, vale enquanto nada muda (até 5 min) e refaz quando muda', async () => {
    const s = await fixtures();
    try {
      const relogio = { agora: AGORA };
      const cursor = { atual: 'g:1' };
      const r = new RotaAnalytics({ storage: s, agora: () => relogio.agora, versao: () => cursor.atual });
      const a = (await pedirRota(r, '/api/analytics')).corpo as Json;
      relogio.agora += 4 * 60_000;
      assert.equal(((await pedirRota(r, '/api/analytics')).corpo as Json).generatedAt, a.generatedAt, 'sem mudança, 4 min');
      cursor.atual = 'g:2';
      assert.notEqual(((await pedirRota(r, '/api/analytics')).corpo as Json).generatedAt, a.generatedAt, 'mudou e já passou de 30 s');
      const b = (await pedirRota(r, '/api/analytics')).corpo as Json;
      relogio.agora += 10_000;
      cursor.atual = 'g:3';
      assert.equal(((await pedirRota(r, '/api/analytics')).corpo as Json).generatedAt, b.generatedAt, 'mudou, mas a resposta tem só 10 s');
      relogio.agora += 6 * 60_000;
      assert.notEqual(((await pedirRota(r, '/api/analytics')).corpo as Json).generatedAt, b.generatedAt, 'passou de 5 min');
    } finally {
      await s.close();
    }
  });

  test('o fuso volta na forma canônica, na resposta e na chave do cache', async () => {
    const r = rota(storage);
    const a = (await pedirRota(r, '/api/analytics?fuso=america/sao_paulo')).corpo as Json;
    assert.equal(a.timeZone, 'America/Sao_Paulo');
    const b = (await pedirRota(r, '/api/analytics?fuso=America/Sao_Paulo')).corpo as Json;
    assert.equal(b, a, 'a mesma entrada do cache');
  });

  test('o custo por conta traz os modelos sem preço de cada conta', async () => {
    const v = (await pedirRota(rota(storage), '/api/analytics')).corpo as Json;
    assert.deepEqual(v.numbers.cost.byAccount.map((c: Json) => c.unpriced), [[], ['modelo-sem-preco'], []]);
  });
});

describe('GET /api/analytics/cost (Custo)', () => {
  let storage: SqliteStorage;
  before(async () => (storage = await fixtures()));
  after(() => storage.close());

  test('7 dias: hoje, período, por dia, por modelo, por projeto e por conta', async () => {
    const { status, corpo } = await pedirRota(rota(storage), '/api/analytics/cost?days=7');
    const c = corpo as Json;
    assert.equal(status, 200);
    assert.deepEqual([c.days, c.today, c.since, c.until, c.estimate, c.currency], [7, '2026-10-20', '2026-10-14', '2026-10-20', true, 'USD']);
    perto(c.todaySummary.usd, OPUS + HAIKU);
    assert.equal(c.todaySummary.sessions, 2);
    const hoje = c.todaySummary.byAccount;
    assert.deepEqual(hoje.map((x: Json) => [x.label, x.unpriced]), [['Conta 1', []], ['Conta 2', []], ['Sem conta', []]]);
    perto(hoje[0].usd, OPUS);
    assert.equal(hoje[1].usd, 0, 'conta 2 sem uso hoje');
    perto(hoje[2].usd, HAIKU);
    assert.equal(hoje[0].color, c.accounts[0].color);
    perto(c.period.usd, OPUS + SONNET + HAIKU);
    perto(c.period.dailyAverage, (OPUS + SONNET + HAIKU) / 7);
    assert.equal(c.cache.pct, 18.2);
    assert.deepEqual(c.unpriced, { models: ['modelo-sem-preco'], totalTokens: 600 });

    assert.equal(c.byDay.length, 7);
    const dia = (d: string) => c.byDay.find((x: Json) => x.day === d)?.usd;
    perto(dia('2026-10-15'), SONNET);
    assert.equal(dia('2026-10-18'), null, 'dia só com uso sem preço');
    assert.equal(dia('2026-10-17'), 0, 'dia sem uso');
    assert.deepEqual(c.peak.day, '2026-10-20');

    assert.deepEqual(c.byModel.map((m: Json) => m.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'modelo-sem-preco']);
    assert.equal(c.byModel.at(-1).usd, null);
    assert.equal(c.byModel.at(-1).pct, null);
    assert.equal(c.byModel[0].pct, Math.round((OPUS / (OPUS + SONNET + HAIKU)) * 1000) / 10);

    assert.deepEqual(c.byProject.map((p: Json) => p.project), ['vitrine-demo', '(sem pasta)', 'app-receitas']);
    assert.equal(c.byProject.at(-1).usd, null);

    assert.deepEqual(c.byAccount.map((x: Json) => x.label), ['Conta 1', 'Conta 2', 'Sem conta']);
    perto(c.byAccount[0].usd, OPUS + SONNET);
    assert.deepEqual([c.byAccount[1].usd, c.byAccount[1].unpriced], [null, ['modelo-sem-preco']]);
    for (const x of c.byAccount) assert.equal(x.byDay.length, 7);
  });

  test('em São Paulo, o haiku de 01:30 UTC sai de hoje e vai para ontem', async () => {
    const c = (await pedirRota(rota(storage), '/api/analytics/cost?days=30&tz=America/Sao_Paulo')).corpo as Json;
    assert.equal(c.byDay.length, 30);
    perto(c.todaySummary.usd, OPUS);
    perto(c.byDay.find((x: Json) => x.day === '2026-10-19').usd, HAIKU);
  });

  test('dias fora de 7, 30 ou 90 dá 400', async () => {
    const r = rota(storage);
    for (const d of ['8', '0', 'trinta', '-7', '']) assert.equal((await pedirRota(r, `/api/analytics/cost?days=${d}`)).status, 400, d);
    assert.equal((await pedirRota(r, '/api/analytics/cost')).status, 200, 'sem days: 30');
    assert.equal((await pedirRota(r, '/api/analytics/cost?days=90')).status, 200);
  });
});

function pedir(url: string, caminho: string, headers: Record<string, string> = {}): Promise<{ status: number; corpo: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, method: 'GET', headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: texto }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('as rotas no servidor', () => {
  let storage: SqliteStorage;
  let api: ApiLocal;
  before(async () => {
    storage = await fixtures();
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: new TrabalhoPorBranch({ fonte: null }) });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, analytics: new RotaAnalytics({ storage, contas, agora: () => AGORA }) });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('GET responde JSON; parâmetro inválido dá 400; Origin de fora dá 403, a própria /ui lê', async () => {
    const ok = await pedir(api.url, '/api/analytics');
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.corpo).today, '2026-10-20');
    assert.equal((await pedir(api.url, '/api/analytics/cost?days=30')).status, 200);
    const ruim = await pedir(api.url, '/api/analytics/cost?days=12');
    assert.equal(ruim.status, 400);
    assert.equal(JSON.parse(ruim.corpo).error, DAYS_ERROR);
    // The old route answers the old error, naming the old parameter.
    const antiga = await pedir(api.url, '/api/analytics/custo?dias=12');
    assert.equal(JSON.parse(antiga.corpo).error, 'dias: 7, 30 ou 90');
    assert.equal(JSON.parse((await pedir(api.url, '/api/analytics/cost?tz=nada')).corpo).error, TZ_ERROR);
    assert.equal((await pedir(api.url, '/api/analytics', { origin: 'http://outro.example' })).status, 403);
    const host = new URL(api.url).host;
    assert.equal((await pedir(api.url, '/api/analytics', { origin: `http://${host}` })).status, 200);
  });

  test('sem a rota ligada, 404', async () => {
    const contas = new Contas({ storage, arquivo: null });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: new TrabalhoPorBranch({ fonte: null }) });
    const sem = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
    try {
      assert.equal((await pedir(sem.url, '/api/analytics')).status, 404);
    } finally {
      await sem.close();
    }
  });
});

describe('histórico simulado da --demo', () => {
  let storage: SqliteStorage;
  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    await semearHistorico(storage, { agora: AGORA });
  });
  after(() => storage.close());

  test('é determinístico, fica no passado e encerrado, sem nada para o painel', async () => {
    const outro = openSqliteStorage({ path: ':memory:' });
    try {
      const a = await semearHistorico(outro, { agora: AGORA });
      const terceiro = openSqliteStorage({ path: ':memory:' });
      const b = await semearHistorico(terceiro, { agora: AGORA });
      await terceiro.close();
      assert.deepEqual(a, b);
      assert.ok(a.sessoes > 50, `${a.sessoes} sessões`);
      const inicioDeHoje = new Date(AGORA).toISOString().slice(0, 10);
      const page = await outro.listSessions({ limit: 500 });
      assert.equal(page.items.length, a.sessoes);
      for (const s of page.items) {
        assert.equal(s.status, 'completed', s.id);
        assert.equal(s.awaitingInputSince, null, s.id);
        assert.ok(s.updatedAt < inicioDeHoje, `${s.id}: ${s.updatedAt}`);
      }
    } finally {
      await outro.close();
    }
  });

  test('com o p4, os gráficos têm dados: vários dias, mais de uma conta, modelos e projetos', async () => {
    const r = rota(storage);
    const v = (await pedirRota(r, '/api/analytics')).corpo as Json;
    assert.ok(v.accounts.length >= 2);
    assert.ok(v.last30.days.filter((d: Json) => d.sessions > 0).length >= 15);
    assert.ok(v.activity.days.filter((d: Json) => d.events > 0).length >= 60);
    assert.ok(v.tokensByModel.length >= 2);
    assert.equal(v.tools.length, 5);
    assert.ok(v.numbers.sessions.active >= 1, 'as do painel');
    const c = (await pedirRota(r, '/api/analytics/cost?days=90')).corpo as Json;
    assert.ok(c.byProject.length >= 3);
    assert.ok(c.byAccount.length >= 2);
    assert.ok(c.period.usd > 0);
    assert.deepEqual(c.unpriced.models, []);
  });
});
