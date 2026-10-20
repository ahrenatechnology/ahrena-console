// Cursor de mudanças e long polling (item 2.4). O relógio é falso: nenhuma espera depende do tempo real.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, TrabalhoPorBranch, iniciarApiLocal, normalizeLegacyUrl } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { MaquinaDeEstados } from '../../src/estados/maquina.ts';
import {
  ContasDasSessoes,
  CursorDeMudancas,
  ESPERA_MAXIMA_MS,
  ESPERA_PADRAO_MS,
  ErroDeLotacao,
  WAIT_FOR_CHANGES,
  aguardarMudancas,
  aoMudarDaMaquina,
  comMudancas,
  decisoesComMudancas,
  lerPedidoDeMudancas,
  waitForChanges,
  type NovaMudanca,
  type Relogio,
  type RespostaDaEspera,
} from '../../src/mudancas/index.ts';
import { T0, account, agent, session } from '../fixtures.ts';
import { draft } from '../decisoes/helpers.ts';
import { registerDecision } from '../../src/decisoes/registro.ts';
import { ErroDaFerramenta, ErroDeArgumento } from '../../src/mcp/protocolo.ts';

/** Relógio manual: `avancar(ms)` dispara, em ordem, os timers que vencem. */
class RelogioFalso implements Relogio {
  t = 0;
  agora(): number {
    return this.t;
  }
  private proximo = 0;
  readonly timers = new Map<number, { quando: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.proximo;
    this.timers.set(id, { quando: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  avancar(ms: number): void {
    const fim = this.t + ms;
    for (;;) {
      const [id, t] = [...this.timers].filter(([, t]) => t.quando <= fim).sort((a, b) => a[1].quando - b[1].quando)[0] ?? [];
      if (id === undefined || !t) break;
      this.timers.delete(id);
      this.t = t.quando;
      t.fn();
    }
    this.t = fim;
  }
}

const sessao = (id: string, over: Partial<NovaMudanca> = {}): NovaMudanca => ({ type: 'session', key: id, sessionId: id, accountId: null, ...over });

function novo(opcoes: { capacidade?: number; agruparMs?: number; intervaloMinimoMs?: number; maximoDeEsperas?: number } = {}) {
  const relogio = new RelogioFalso();
  const cursor = new CursorDeMudancas({ relogio, geracao: 'g1', agruparMs: 0, intervaloMinimoMs: 0, ...opcoes });
  return { relogio, cursor };
}

/** Promessa com o estado visível, para saber se a espera já respondeu sem esperar por ela. */
function observar(p: Promise<RespostaDaEspera>) {
  const o: { valor: RespostaDaEspera | null; p: Promise<RespostaDaEspera> } = { valor: null, p };
  p.then((v) => (o.valor = v));
  return o;
}
const tique = () => new Promise((r) => setImmediate(r));

describe('cursor de mudanças', () => {
  test('sem cursor, de outra geração ou do futuro: volta na hora pedindo para reiniciar', async () => {
    const { cursor } = novo();
    cursor.registrar(sessao('s1'));
    for (const c of [null, '', 'lixo', 'g0.1', 'g1.99']) {
      const r = await cursor.aguardar(c);
      assert.deepEqual(r, { cursor: 'g1.1', changes: [], reset: true, timedOut: false }, String(c));
    }
  });

  test('resposta imediata quando já há novidade, uma vez por (tipo, chave)', async () => {
    const { cursor, relogio } = novo();
    const c0 = cursor.atual;
    cursor.registrar(sessao('s1'));
    cursor.registrar(sessao('s2'));
    cursor.registrar(sessao('s1'));
    cursor.registrar({ type: 'plan', key: 's1', sessionId: 's1', accountId: null });
    const r = await aguardarMudancas(cursor, c0);
    assert.equal(r.cursor, 'g1.4');
    assert.deepEqual(r.changes.map((m) => `${m.type}:${m.key}:${m.seq}`), ['session:s2:2', 'session:s1:3', 'plan:s1:4']);
    assert.equal(relogio.timers.size, 0, 'resposta na hora não arma timer');
    assert.equal(cursor.abertas, 0);
  });

  test('segura até chegar uma mudança', async () => {
    const { cursor } = novo();
    const espera = observar(cursor.aguardar(cursor.atual, { timeoutMs: 10_000 }));
    await tique();
    assert.equal(espera.valor, null);
    assert.equal(cursor.abertas, 1);
    cursor.registrar(sessao('s1'));
    const r = await espera.p;
    assert.deepEqual(r.changes.map((m) => m.key), ['s1']);
    assert.equal(r.timedOut, false);
    assert.equal(cursor.abertas, 0);
  });

  test('timeout: volta sem mudanças, com o cursor que pula as que não passaram no filtro', async () => {
    const { cursor, relogio } = novo();
    const espera = observar(cursor.aguardar(cursor.atual, { timeoutMs: 5_000, filtros: { sessionIds: ['s9'] } }));
    cursor.registrar(sessao('s1'));
    relogio.avancar(4_999);
    await tique();
    assert.equal(espera.valor, null);
    relogio.avancar(1);
    const r = await espera.p;
    assert.deepEqual(r, { cursor: 'g1.1', changes: [], reset: false, timedOut: true });
    assert.equal(relogio.timers.size, 0);
  });

  test('o timeout tem padrão e teto; 0 responde na hora', async () => {
    const { cursor, relogio } = novo();
    void cursor.aguardar(cursor.atual);
    assert.equal([...relogio.timers.values()][0].quando, ESPERA_PADRAO_MS);
    cursor.encerrar();
    void cursor.aguardar(cursor.atual, { timeoutMs: 10 * 60_000 });
    assert.equal([...relogio.timers.values()][0].quando, ESPERA_MAXIMA_MS);
    assert.ok(ESPERA_MAXIMA_MS < 120_000);
    cursor.encerrar();
    const r = await cursor.aguardar(cursor.atual, { timeoutMs: 0 });
    assert.equal(r.timedOut, false);
    assert.equal(cursor.abertas, 0);
  });

  test('várias esperas simultâneas: cada uma acorda só com o que passa no seu filtro', async () => {
    const { cursor, relogio } = novo();
    const c = cursor.atual;
    const todas = observar(cursor.aguardar(c));
    const s2 = observar(cursor.aguardar(c, { filtros: { sessionIds: ['s2'] } }));
    const contaB = observar(cursor.aguardar(c, { filtros: { accountIds: ['b'] } }));
    const semConta = observar(cursor.aguardar(c, { filtros: { accountIds: [null] } }));
    const planos = observar(cursor.aguardar(c, { filtros: { tipos: ['plan'] } }));
    const muitas = Array.from({ length: 100 }, () => observar(cursor.aguardar(c, { filtros: { tipos: ['decision'] } })));
    assert.equal(cursor.abertas, 105);

    cursor.registrar(sessao('s1', { accountId: 'a' }));
    await tique();
    assert.ok(todas.valor);
    assert.equal(s2.valor, null);
    assert.equal(contaB.valor, null);
    assert.equal(semConta.valor, null);
    assert.equal(planos.valor, null);

    cursor.registrar({ type: 'plan', key: 's2', sessionId: 's2', accountId: 'b' });
    await tique();
    assert.deepEqual((s2.valor as RespostaDaEspera | null)?.changes.map((m) => m.type), ['plan']);
    assert.deepEqual((contaB.valor as RespostaDaEspera | null)?.changes.map((m) => m.key), ['s2']);
    assert.deepEqual((planos.valor as RespostaDaEspera | null)?.changes.map((m) => m.key), ['s2']);
    assert.equal(semConta.valor, null);
    assert.equal(cursor.abertas, 101);

    cursor.registrar({ type: 'decision', key: 'd1', sessionId: 's3', accountId: null });
    await tique();
    assert.ok(semConta.valor);
    assert.ok(muitas.every((m) => m.valor?.changes[0]?.key === 'd1'));
    assert.equal(cursor.abertas, 0);
    assert.equal(relogio.timers.size, 0, 'quem respondeu desarma o timer');
  });

  test('agrupa uma rajada numa resposta só', async () => {
    const { cursor, relogio } = novo({ agruparMs: 50 });
    const espera = observar(cursor.aguardar(cursor.atual));
    for (let i = 0; i < 30; i++) cursor.registrar(sessao(`s${i % 3}`));
    await tique();
    assert.equal(espera.valor, null);
    assert.equal(relogio.timers.size, 1, 'o timeout virou o timer do agrupamento');
    relogio.avancar(50);
    const r = await espera.p;
    assert.equal(r.cursor, 'g1.30');
    assert.deepEqual(r.changes.map((m) => m.key), ['s0', 's1', 's2']);
  });

  test('intervalo mínimo: com hooks sem parar, o laço acorda no máximo uma vez por intervalo', async () => {
    const { cursor, relogio } = novo({ agruparMs: 50, intervaloMinimoMs: 1000 });
    let respostas = 0;
    let espera = observar(cursor.aguardar(cursor.atual));
    // 10 s de hooks, um a cada 100 ms, com um cliente em laço de long polling.
    for (let ms = 0; ms < 10_000; ms += 100) {
      cursor.registrar(sessao('s1'));
      relogio.avancar(100);
      await tique();
      const v = espera.valor as RespostaDaEspera | null;
      if (v) {
        respostas++;
        espera = observar(cursor.aguardar(v.cursor));
      }
    }
    assert.ok(respostas <= 10, `${respostas} respostas em 10 s`);
    assert.ok(respostas >= 9, `${respostas} respostas em 10 s`);
  });

  test('teto de esperas abertas', async () => {
    const { cursor } = novo({ maximoDeEsperas: 2 });
    void cursor.aguardar(cursor.atual);
    void cursor.aguardar(cursor.atual);
    await assert.rejects(cursor.aguardar(cursor.atual), ErroDeLotacao);
    assert.equal((await cursor.aguardar(null)).reset, true, 'sem cursor responde na hora, mesmo lotado');
    cursor.encerrar();
  });

  test('cursor mais velho que a fila pede para reiniciar', async () => {
    const { cursor } = novo({ capacidade: 4 });
    const velho = cursor.atual;
    const quase = (() => {
      cursor.registrar(sessao('s1'));
      return cursor.atual;
    })();
    for (let i = 0; i < 4; i++) cursor.registrar(sessao(`x${i}`));
    assert.equal((await cursor.aguardar(velho)).reset, true);
    const r = await cursor.aguardar(quase);
    assert.equal(r.reset, false);
    assert.equal(r.changes.length, 4);
  });

  test('abortar e encerrar respondem na hora e liberam a espera', async () => {
    const { cursor, relogio } = novo();
    const ac = new AbortController();
    const espera = cursor.aguardar(cursor.atual, { signal: ac.signal });
    ac.abort();
    assert.equal((await espera).timedOut, false);
    const outra = cursor.aguardar(cursor.atual);
    cursor.encerrar();
    await outra;
    assert.equal(cursor.abertas, 0);
    assert.equal(relogio.timers.size, 0);
  });

  test('parado, sem mudanças: nenhum polling interno, só um timer por espera aberta', async () => {
    const { cursor, relogio } = novo();
    const esperas = Array.from({ length: 50 }, () => cursor.aguardar(cursor.atual, { timeoutMs: 25_000 }));
    assert.equal(relogio.timers.size, 50);
    relogio.avancar(24_999);
    assert.equal(relogio.timers.size, 50, 'nenhum timer novo enquanto espera');
    relogio.avancar(1);
    const rs = await Promise.all(esperas);
    assert.ok(rs.every((r) => r.timedOut));
    assert.equal(relogio.timers.size, 0);
  });
});

describe('fontes das mudanças', () => {
  test('a porta embrulhada registra sessão, plano e conta, e o resto passa direto', async () => {
    const { cursor } = novo();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = comMudancas(sqlite, cursor);
    const c0 = cursor.atual;
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript' }));
    await storage.putAgent(agent({ id: 's1:main', sessionId: 's1' }));
    await storage.putPlan({ sessionId: 's1', source: 'TodoWrite', steps: [], done: 0, total: 0, currentStepId: null, changedAt: T0, metadata: {} });
    const conta = account();
    await storage.putAccount(conta);
    // Um hook que só avança o updatedAt e a metadata não acorda ninguém.
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript', updatedAt: T0.replace('12:00', '12:05'), metadata: { transcriptPath: '/x.jsonl' } }));
    assert.ok(storage.db, 'o db do SQLite continua acessível');
    assert.equal((await storage.getSession('s1'))?.accountId, 'conta-a');
    const r = await cursor.aguardar(c0);
    assert.deepEqual(
      r.changes.map((m) => [m.type, m.key, m.sessionId, m.accountId]),
      [
        ['session', 's1', 's1', 'conta-a'],
        ['plan', 's1', 's1', 'conta-a'],
        ['account', conta.id, null, conta.id],
      ],
    );
    await storage.close();
  });

  test('agente que entra ou muda de status registra a sessão dele; só o updatedAt não (#31)', async () => {
    const { cursor } = novo();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = comMudancas(sqlite, cursor);
    await storage.putSession(session({ id: 's1', accountId: 'conta-a', accountSource: 'transcript' }));
    const a = agent({ id: 's1:a1', sessionId: 's1', type: 'subagent', status: 'working' });
    await storage.putAgent(a);
    const c1 = cursor.atual;
    await storage.putAgent({ ...a, updatedAt: T0.replace('12:00', '12:05') });
    assert.equal(cursor.atual, c1, 'só o updatedAt não é mudança');
    await storage.putAgent({ ...a, status: 'completed', endedAt: T0.replace('12:00', '12:06') });
    const r = await cursor.aguardar(c1);
    assert.deepEqual(r.changes.map((m) => [m.type, m.key, m.accountId]), [['session', 's1', 'conta-a']]);
    await storage.close();
  });

  test('decisão gravada e mudança de estado da máquina viram mudanças, com a conta da sessão', async () => {
    const { cursor } = novo();
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const contas = new ContasDasSessoes(sqlite);
    await sqlite.putSession(session({ id: 's1', accountId: 'conta-b', accountSource: 'transcript' }));
    await sqlite.putAgent(agent({ id: 's1:main', sessionId: 's1' }));
    const storage = comMudancas(sqlite, cursor, contas);
    const decisoes = decisoesComMudancas(new SqliteDecisionStore(sqlite.db), cursor, contas);
    const c0 = cursor.atual;
    await registerDecision(decisoes, draft({ sessionId: 's1' }), T0);
    const d = await cursor.aguardar(c0, { filtros: { tipos: ['decision'] } });
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0].accountId, 'conta-b');

    const maquina = new MaquinaDeEstados({ storage, sonda: null, agora: () => new Date(T0), aoMudar: aoMudarDaMaquina(cursor, contas), log: () => {} });
    const c1 = cursor.atual;
    const espera = cursor.aguardar(c1, { filtros: { tipos: ['needs-you'] }, timeoutMs: 1000 });
    await maquina.aplicar({ id: 'h1', sessionId: 's1', agentId: null, type: 'Notification', toolName: null, summary: null, data: { notification_type: 'permission_prompt', message: 'Permitir?' }, createdAt: T0 });
    const r = await espera;
    assert.deepEqual(r.changes.map((m) => [m.type, m.key, m.accountId]), [['needs-you', 's1', 'conta-b']]);
    const tudo = await cursor.aguardar(c1);
    assert.deepEqual(new Set(tudo.changes.map((m) => m.type)), new Set(['session', 'state', 'needs-you']));
    await sqlite.close();
  });
});

describe('rota HTTP', () => {
  test('lê e valida os parâmetros', () => {
    // The old parameter names pass through the alias map, as on the server.
    const p = (q: string) => lerPedidoDeMudancas(normalizeLegacyUrl(new URL(`http://x/api/mudancas?${q}`)));
    assert.deepEqual(p('desde=g1.3&espera=5&sessao=s1,s2&conta=a&conta=sem-conta&tipo=plano'), {
      cursor: 'g1.3',
      timeoutMs: 5000,
      filtros: { sessionIds: ['s1', 's2'], accountIds: ['a', null], tipos: ['plan'] },
    });
    assert.equal((p('') as { timeoutMs: number }).timeoutMs, ESPERA_PADRAO_MS);
    assert.equal(typeof p('tipo=outro'), 'string');
    assert.equal(typeof p('espera=-1'), 'string');
    assert.equal(typeof p('sessao=a b'), 'string');
  });

  test('GET /api/changes segura até a mudança e libera quando o cliente desiste', async () => {
    const cursor = new CursorDeMudancas({ agruparMs: 0, intervaloMinimoMs: 0, maximoDeEsperas: 2 });
    const sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = comMudancas(sqlite, cursor);
    const trabalho = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho });
    const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, mudancas: cursor });
    try {
      const inicio = (await (await fetch(`${api.url}/api/changes`)).json()) as RespostaDaEspera;
      assert.equal(inicio.reset, true);
      assert.equal((await fetch(`${api.url}/api/changes?type=x`)).status, 400);

      const pedido = fetch(`${api.url}/api/changes?since=${inicio.cursor}&wait=20&session=sess-http`).then((r) => r.json() as Promise<RespostaDaEspera>);
      while (cursor.abertas === 0) await tique();
      const hook = { session_id: 'sess-http', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
      const h = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
      assert.equal(h.status, 202);
      const r = await pedido;
      assert.deepEqual(r.changes.map((m) => [m.type, m.key]), [['session', 'sess-http']]);

      const ac = new AbortController();
      const desistente = fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`, { signal: ac.signal }).catch(() => null);
      while (cursor.abertas === 0) await tique();
      ac.abort();
      await desistente;
      while (cursor.abertas > 0) await tique();
      const carga = (await (await fetch(`${api.url}/api/load`)).json()) as { openWaits: number };
      assert.equal(carga.openWaits, 0);

      const abertas = [1, 2].map(() => fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`));
      while (cursor.abertas < 2) await tique();
      const lotado = await fetch(`${api.url}/api/changes?since=${r.cursor}&wait=20`);
      assert.equal(lotado.status, 503);
      assert.equal(lotado.headers.get('retry-after'), '5');
      cursor.encerrar();
      await Promise.all(abertas);
    } finally {
      await api.close();
      await sqlite.close();
    }
  });
});

describe('ferramenta MCP wait_for_changes', () => {
  const sinal = () => new AbortController().signal;
  const ctx = () => ({ sinal: sinal(), versao: null });

  test('mesma espera, conta pelo rótulo (nunca o id) e filtro por rótulo', async () => {
    const { cursor } = novo();
    const storage = openSqliteStorage({ path: ':memory:' });
    const equipe = account({ n: 1, label: 'equipe' });
    const cliente = account({ n: 2, label: 'cliente' });
    await storage.putAccount(equipe);
    await storage.putAccount(cliente);
    const f = waitForChanges({ mudancas: cursor, contas: new Contas({ storage, arquivo: null }) });
    assert.equal(f.nome, WAIT_FOR_CHANGES);

    const primeira = await f.executar({}, ctx());
    assert.equal(primeira.dados.reset, true);
    const c = primeira.dados.cursor as string;

    const pendente = f.executar({ cursor: c, timeout: 30, account: 'cliente', types: ['plano', 'decisao'] }, ctx());
    cursor.registrar({ type: 'plan', key: 's1', sessionId: 's1', accountId: equipe.id });
    cursor.registrar(sessao('s2', { accountId: cliente.id }));
    cursor.registrar({ type: 'decision', key: 'd9', sessionId: 's2', accountId: cliente.id });
    const r = await pendente;
    assert.deepEqual(r.dados, {
      cursor: 'g1.3',
      reset: false,
      timedOut: false,
      changes: [{ type: 'decision', sessionId: 's2', decisionId: 'd9', account: { label: 'cliente', color: (r.dados.changes as any)[0].account.color } }],
    });
    assert.ok(!JSON.stringify(r.dados).includes(cliente.accountUuid), 'o id da conta não sai');
    assert.match(r.texto, /1 mudança\(s\): decision 1/);

    const semConta = f.executar({ cursor: 'g1.3', timeout: 30, account: 'none' }, ctx());
    cursor.registrar(sessao('s3'));
    assert.deepEqual(((await semConta).dados.changes as any[]).map((m) => [m.type, m.sessionId, m.account]), [['session', 's3', null]]);
    await storage.close();
  });

  test('#173 phase 2b: `types` takes the English names and still the old ones; the answer is English', async () => {
    const { cursor } = novo();
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ mudancas: cursor, contas: new Contas({ storage, arquivo: null }) });
    const c = cursor.atual;
    cursor.registrar({ type: 'plan', key: 's1', sessionId: 's1', accountId: null });
    cursor.registrar({ type: 'needs-you', key: 's2', sessionId: 's2', accountId: null });
    cursor.registrar(sessao('s3'));
    const tipos = async (types: string[]) => ((await f.executar({ cursor: c, timeout: 0, types }, ctx())).dados.changes as { type: string }[]).map((m) => m.type);
    assert.deepEqual(await tipos(['plan', 'needs-you']), ['plan', 'needs-you']);
    assert.deepEqual(await tipos(['plano', 'precisa-de-voce']), ['plan', 'needs-you'], 'the old names');
    assert.deepEqual(await tipos(['sessao', 'state']), ['session'], 'a mix');
    const enumDosTipos = ((f.entrada as any).properties.types.items.enum as string[]).sort();
    assert.deepEqual(enumDosTipos, ['account', 'alert', 'conta', 'decisao', 'decision', 'estado', 'needs-you', 'plan', 'plano', 'precisa-de-voce', 'sessao', 'session', 'state']);
    assert.deepEqual((f.saida as any).properties.changes.items.properties.type.enum, ['session', 'state', 'needs-you', 'plan', 'decision', 'account', 'alert']);
    await storage.close();
  });

  test('uma mudança `repos` não acorda a espera nem aparece, sem filtro ou com account "none"; e não é tipo válido', async () => {
    const { cursor } = novo();
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ mudancas: cursor, contas: new Contas({ storage, arquivo: null }) });
    const c = cursor.atual;
    const semFiltro = observar(f.executar({ cursor: c, timeout: 30 }, ctx()).then((r) => r.dados as unknown as RespostaDaEspera));
    const semConta = observar(f.executar({ cursor: c, timeout: 30, account: 'none' }, ctx()).then((r) => r.dados as unknown as RespostaDaEspera));
    cursor.registrar({ type: 'repos', key: 'lista', sessionId: null, accountId: null });
    cursor.registrar({ type: 'repos', key: 'org/repo', sessionId: null, accountId: null });
    await tique();
    assert.equal(semFiltro.valor, null, 'acordou com `repos`');
    assert.equal(semConta.valor, null, 'acordou com `repos` em account "none"');
    cursor.registrar(sessao('s1'));
    const [a, b] = (await Promise.all([semFiltro.p, semConta.p])) as unknown as { changes: { type: string }[] }[];
    assert.deepEqual(a.changes.map((x) => x.type), ['session']);
    assert.deepEqual(b.changes.map((x) => x.type), ['session']);
    // Já registrada antes do pedido: também não sai.
    const depois = await f.executar({ cursor: c, timeout: 0 }, ctx());
    assert.ok(!JSON.stringify(depois.dados).includes('repos'));
    await assert.rejects(f.executar({ types: ['repos'] }, ctx()), ErroDeArgumento);
    assert.ok(!JSON.stringify(f.entrada).includes('"repos"') && !JSON.stringify(f.saida).includes('"repos"'));
    await storage.close();
  });

  test('argumento errado e lotação voltam como erro da ferramenta; o sinal libera a espera', async () => {
    const { cursor } = novo({ maximoDeEsperas: 1 });
    const storage = openSqliteStorage({ path: ':memory:' });
    const f = waitForChanges({ mudancas: cursor, contas: new Contas({ storage, arquivo: null }) });
    for (const args of [{ types: ['x'] }, { timeout: -1 }, { sessions: ['a b'] }, { account: [] }, { outro: 1 }]) {
      await assert.rejects(f.executar(args as never, ctx()), ErroDeArgumento, JSON.stringify(args));
    }
    const ac = new AbortController();
    const aberta = f.executar({ cursor: cursor.atual }, { sinal: ac.signal, versao: null });
    await tique();
    await assert.rejects(f.executar({ cursor: cursor.atual }, ctx()), (e: Error) => e instanceof ErroDaFerramenta && /esperas abertas demais/.test(e.message));
    ac.abort();
    assert.equal((await aberta).dados.timedOut, false);
    assert.equal(cursor.abertas, 0);
    await storage.close();
  });
});
