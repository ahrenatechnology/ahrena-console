// The Sessions screen (C3, #28): the `GET /api/sessions` route (filters, order and page on the server)
// with simulator data, and the pieces of the screen that need no browser.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, ListaDeSessoes, MontadorDoPainel, pedidoDeSessoes, type LocalApi, type ListaDeSessoesHttp, type PedidoDeSessoes } from '../../src/api/index.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { displayStatus, type Session } from '../../src/model.ts';
import { seedPanelScenario, PANEL_SESSION } from '../../src/simulator/panel.ts';
import { simulate } from '../../src/simulator/index.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { COLUMNS, cost, duration, stateFromQuery, band, age, shortId, queryFromState, listRoute, fitRows, pageKeepingRow, roomForRows, MIN_ROWS } from '../../ui/screens/sessions.js';
// @ts-expect-error: idem
import { findScreen } from '../../ui/screens.js';

const AGORA = Date.parse('2026-05-01T12:00:00.000Z');
const PADRAO: PedidoDeSessoes = { status: 'all', busca: null, dir: null, ordem: 'activity', sentido: 'desc', pagina: 1, perPage: 10 };

function pedir(url: string, caminho: string, headers: Record<string, string> = {}): Promise<{ status: number; corpo: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: texto }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('#28 GET /api/sessions com o simulador', () => {
  let storage: SqliteStorage;
  let lista: ListaDeSessoes;
  let sessoes: Session[];
  let api: LocalApi;
  const listar = (p: Partial<PedidoDeSessoes> = {}) => lista.listar({ ...PADRAO, ...p });
  // Todas as páginas de um pedido, juntas.
  const tudo = async (p: Partial<PedidoDeSessoes> = {}) => {
    const primeira = await listar(p);
    const itens = [...primeira.items];
    for (let pagina = 2; pagina <= primeira.pages; pagina++) itens.push(...(await listar({ ...p, pagina })).items);
    return { primeira, itens };
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await simulate(storage, { seed: 28, sessions: 16, chaos: true, prices: true, now: () => AGORA });
    await seedPanelScenario(storage, 'p4', AGORA);
    sessoes = (await storage.listSessions({ limit: 500 })).items;
    const contas = new Accounts({ storage, file: null });
    lista = new ListaDeSessoes({ storage, contas, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, sessions: lista });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('o simulador deu sessões de todo status, mais de uma página', () => {
    assert.ok(sessoes.length > 10, `${sessoes.length} sessões`);
    const status = new Set(sessoes.map(displayStatus));
    for (const s of ['active', 'waiting', 'completed', 'error', 'abandoned']) assert.ok(status.has(s as never), `falta ${s}`);
  });

  test('10 por página: a segunda traz o resto, sem repetir; página além do fim cai na última', async () => {
    const p1 = await listar();
    assert.equal(p1.perPage, 10);
    assert.equal(p1.items.length, 10);
    assert.equal(p1.total, sessoes.length);
    assert.equal(p1.registered, sessoes.length);
    assert.equal(p1.pages, Math.ceil(sessoes.length / 10));
    const { itens } = await tudo();
    assert.equal(itens.length, sessoes.length);
    assert.equal(new Set(itens.map((s) => s.id)).size, sessoes.length);
    const alem = await listar({ pagina: 99 });
    assert.equal(alem.page, p1.pages);
    assert.ok(alem.items.length > 0);
  });

  test('#279/AC-4: perPage sets the page size, and the pages follow it', async () => {
    const p = await listar({ perPage: 7, pagina: 2 });
    assert.equal(p.perPage, 7);
    assert.equal(p.items.length, 7);
    assert.equal(p.pages, Math.ceil(sessoes.length / 7));
    const { itens } = await tudo();
    assert.deepEqual(p.items.map((s) => s.id), itens.slice(7, 14).map((s) => s.id));
  });

  test('cada pílula traz só o seu status, e as cinco somam o total', async () => {
    let soma = 0;
    for (const status of ['active', 'waiting', 'completed', 'error', 'abandoned'] as const) {
      const filtro = status;
      const { primeira, itens } = await tudo({ status: filtro as PedidoDeSessoes['status'] });
      assert.ok(itens.length > 0, filtro);
      for (const s of itens) assert.equal(s.status, status, `${filtro}: ${s.id}`);
      assert.equal(primeira.total, sessoes.filter((s) => displayStatus(s) === status).length, filtro);
      assert.equal(primeira.registered, sessoes.length, 'o total registrado não depende do filtro');
      soma += primeira.total;
    }
    assert.equal(soma, sessoes.length);
  });

  test('esperando traz o motivo; as outras não', async () => {
    const { itens } = await tudo();
    for (const s of itens) {
      if (s.status === 'waiting') assert.ok(['notification', 'interrupted', 'stop', 'session_start'].includes(s.reason!), s.id);
      else assert.equal(s.reason, null, s.id);
      assert.equal(s.running, s.status === 'active' || s.status === 'waiting');
    }
  });

  test('a busca acha pelo título, pelo id e pelo diretório, sem diferença de caixa', async () => {
    const porTitulo = await listar({ busca: 'SEPARAR PAGAMENTOS' });
    assert.deepEqual(porTitulo.items.map((s) => s.id), [PANEL_SESSION]);
    const alvo = sessoes.find((s) => s.id !== PANEL_SESSION)!;
    assert.ok((await listar({ busca: alvo.id })).items.some((s) => s.id === alvo.id));
    const porDir = await tudo({ busca: 'vitrine-demo' });
    assert.ok(porDir.itens.length > 0 && porDir.itens.every((s) => s.cwd?.includes('vitrine-demo') || s.title.toLowerCase().includes('vitrine-demo')));
    assert.equal((await listar({ busca: 'nada-com-isso-aqui' })).total, 0);
  });

  test('o filtro por diretório usa a lista que a própria resposta traz', async () => {
    const { directories } = await listar();
    assert.deepEqual(directories, [...directories].sort());
    assert.equal(directories.length, new Set(sessoes.map((s) => s.cwd).filter(Boolean)).size);
    for (const dir of directories) {
      const { primeira, itens } = await tudo({ dir });
      assert.ok(itens.every((s) => s.cwd === dir), dir);
      assert.equal(primeira.total, sessoes.filter((s) => s.cwd === dir).length, dir);
    }
    // Combinado com o status.
    const dir = sessoes.find((s) => displayStatus(s) === 'completed')!.cwd!;
    const { itens } = await tudo({ dir, status: 'completed' });
    assert.ok(itens.length > 0 && itens.every((s) => s.cwd === dir && s.status === 'completed'));
  });

  test('ordem por atividade, duração e custo, nos dois sentidos', async () => {
    const ordenado = (xs: number[], sentido: 'desc' | 'asc') => xs.every((x, i) => i === 0 || (sentido === 'desc' ? xs[i - 1]! >= x : xs[i - 1]! <= x));
    for (const sentido of ['desc', 'asc'] as const) {
      const atividade = (await tudo({ ordem: 'activity', sentido })).itens.map((s) => Date.parse(s.lastActivity));
      assert.ok(ordenado(atividade, sentido), `atividade ${sentido}`);
      const dur = (await tudo({ ordem: 'duration', sentido })).itens.map((s) => s.durationMs);
      assert.ok(ordenado(dur, sentido), `duração ${sentido}`);
      const usd = (await tudo({ ordem: 'cost', sentido })).itens.map((s) => s.costUsd ?? -1);
      assert.ok(ordenado(usd, sentido), `custo ${sentido}`);
    }
    // O simulador grava preços: há sessão com custo, e a mais cara vem primeiro.
    const caras = await listar({ ordem: 'cost' });
    assert.ok(caras.items[0]!.costUsd! > 0);
  });

  test('duração: a ativa corre até agora; a encerrada para no fim', async () => {
    const { itens } = await tudo();
    for (const s of itens) {
      const sessao = sessoes.find((x) => x.id === s.id)!;
      const fim = sessao.status === 'active' ? AGORA : Date.parse(sessao.endedAt ?? sessao.updatedAt);
      assert.equal(s.durationMs, Math.max(0, fim - Date.parse(sessao.startedAt)), s.id);
    }
  });

  test('a conta sai com rótulo e cor, nunca o id (decisão 0006)', async () => {
    const { itens } = await tudo();
    const comConta = itens.filter((s) => s.account);
    assert.ok(comConta.length > 0);
    for (const s of comConta) assert.deepEqual(Object.keys(s.account!).sort(), ['color', 'label']);
    const contas = await storage.listAccounts();
    const json = JSON.stringify(itens);
    for (const c of contas) {
      assert.ok(!json.includes(c.accountUuid), 'uuid da conta na resposta');
      assert.ok(!json.includes(c.organizationUuid), 'uuid da org na resposta');
    }
  });

  test('HTTP: a rota responde, recusa parâmetro inválido com 400 e aceita a própria /ui lendo', async () => {
    const ok = await pedir(api.url, '/api/sessions?status=waiting&order=cost&direction=asc&page=1');
    assert.equal(ok.status, 200);
    const corpo = JSON.parse(ok.corpo) as ListaDeSessoesHttp;
    assert.ok(corpo.items.every((s) => s.status === 'waiting'));
    const erros: Record<string, string> = {
      'status=nenhuma': 'status: um de all, active, waiting, blocked, idle, completed, error, abandoned',
      'order=nome': 'order: um de activity, duration, cost',
      'direction=lado': 'direction: um de desc, asc',
      'page=0': 'page: um inteiro a partir de 1',
      'page=1.5': 'page: um inteiro a partir de 1',
      'perPage=0': 'perPage: um inteiro de 1 a 100',
      'perPage=101': 'perPage: um inteiro de 1 a 100',
      'perPage=2.5': 'perPage: um inteiro de 1 a 100',
      'dir=relativo': 'dir: um caminho absoluto',
      [`search=${'x'.repeat(201)}`]: 'search grande demais',
      // The old Portuguese values are refused (#173, phase 6).
      'status=esperando': 'status: um de all, active, waiting, blocked, idle, completed, error, abandoned',
      'order=custo': 'order: um de activity, duration, cost',
    };
    for (const [q, error] of Object.entries(erros)) {
      const r = await pedir(api.url, `/api/sessions?${q}`);
      assert.equal(r.status, 400, q);
      assert.deepEqual(JSON.parse(r.corpo), { error }, q);
    }
    // The old Portuguese parameter names are ignored: a bad value under them is not even read.
    const padrao = await pedir(api.url, '/api/sessions');
    for (const q of ['ordem=nome', 'sentido=lado', 'pagina=0', `busca=${'x'.repeat(201)}`]) {
      assert.deepEqual(await pedir(api.url, `/api/sessions?${q}`), padrao, q);
    }
    // The old Portuguese route is gone.
    assert.deepEqual(await pedir(api.url, '/api/sessoes'), { status: 404, corpo: JSON.stringify({ error: 'não encontrado' }) });
    const host = new URL(api.url).host;
    assert.equal((await pedir(api.url, '/api/sessions', { origin: `http://${host}` })).status, 200);
    assert.equal((await pedir(api.url, '/api/sessions', { origin: 'https://exemplo.com' })).status, 403);
  });

  test('pedidoDeSessoes: os padrões', () => {
    assert.deepEqual(pedidoDeSessoes(new URL('http://x/api/sessions')), PADRAO);
    assert.deepEqual(pedidoDeSessoes(new URL('http://x/api/sessions?search=%20oi%20&dir=/a/b&page=3')), { ...PADRAO, busca: 'oi', dir: '/a/b', pagina: 3 });
  });
});

describe('#28 a tela Sessões', () => {
  test('está registrada em /ui/sessions, e o arquivo existe', () => {
    const { screen: tela } = findScreen('/ui/sessions');
    assert.equal(tela.file, '/ui/screens/sessions.js');
    assert.ok(existsSync(`${UI_FOLDER}screens/sessions.js`));
    assert.ok(existsSync(`${UI_FOLDER}sessions.css`));
    // A linha leva ao Detalhe, que casa o id do simulador.
    assert.equal(findScreen(`/ui/sessions/${encodeURIComponent(PANEL_SESSION)}`).screen.id, 'session-detail');
  });

  test('the state goes and comes back through the URL query; what is not valid falls back to the default; waiting opens blocked (issue 245)', () => {
    const e = stateFromQuery('?status=blocked&search=oi&dir=/simulacao/x&order=cost&direction=asc&page=2');
    assert.deepEqual(e, { status: 'blocked', search: 'oi', dir: '/simulacao/x', order: 'cost', direction: 'asc', page: 2 });
    assert.deepEqual(stateFromQuery(queryFromState(e)), e);
    assert.equal(queryFromState(e), '?status=blocked&search=oi&dir=%2Fsimulacao%2Fx&order=cost&direction=asc&page=2', 'the address bar carries the new values');
    assert.equal(stateFromQuery('?status=waiting').status, 'blocked', 'an old bookmark of the waiting pill opens the ones that need you');
    // The old Portuguese values are not read (#173, phase 6): they fall back to the default.
    assert.deepEqual(stateFromQuery('?status=esperando&order=custo'), stateFromQuery(''));
    assert.equal(queryFromState(stateFromQuery('')), '');
    assert.deepEqual(stateFromQuery('?status=x&order=y&direction=z&page=-1&dir=rel'), stateFromQuery(''));
  });

  test('a rota da API leva os filtros que o servidor entende', () => {
    const rota = listRoute({ status: 'error', search: ' a b ', dir: '/d', order: 'duration', direction: 'desc', page: 2 });
    const url = new URL(rota, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/sessions');
    assert.deepEqual(pedidoDeSessoes(url), { status: 'error', busca: 'a b', dir: '/d', ordem: 'duration', sentido: 'desc', pagina: 2, perPage: 10 });
    const sized = new URL(listRoute(stateFromQuery(''), 17), 'http://x');
    assert.equal(pedidoDeSessoes(sized).perPage, 17, '#279: the screen sends the rows that fit');
    assert.ok(!new URL(listRoute(stateFromQuery('')), 'http://x').searchParams.has('search'));
  });

  test('#279/AC-1, AC-2: the rows that fit the window, never below 10 nor above 100', () => {
    // 1920×1080 in the demo: rows start at 183.5 px, the area is 1080 tall with 24 px of padding.
    const room = roomForRows({ rowsTop: 183.5, areaBottom: 1080, paddingBottom: 24, gap: 12, footerHeight: 30 });
    assert.equal(room, 829.5);
    assert.equal(fitRows({ available: room, rowHeight: 50 }), 16);
    // 1100×760: fewer than 10 fit, the page keeps the old 10.
    assert.equal(fitRows({ available: 420, rowHeight: 66 }), MIN_ROWS);
    assert.equal(fitRows({ available: 100_000, rowHeight: 50 }), 100);
    // Nothing measured (hidden, no style yet): the minimum, never NaN or 0.
    assert.equal(fitRows({ available: NaN, rowHeight: 50 }), MIN_ROWS);
    assert.equal(fitRows({ available: 800, rowHeight: 0 }), MIN_ROWS);
    assert.equal(fitRows({ available: -50, rowHeight: 50 }), MIN_ROWS);
  });

  test('#279/AC-3: a new page size keeps the first row on screen, not the page number', () => {
    // Page 3 of 16 starts at row 33; with 10 per page, row 33 is on page 4 (31–40).
    assert.equal(pageKeepingRow({ page: 3, perPage: 16, nextPerPage: 10 }), 4);
    // Page 4 of 10 starts at row 31; with 16 per page, row 31 is on page 2 (17–32).
    assert.equal(pageKeepingRow({ page: 4, perPage: 10, nextPerPage: 16 }), 2);
    assert.equal(pageKeepingRow({ page: 1, perPage: 10, nextPerPage: 16 }), 1);
    assert.equal(pageKeepingRow({ page: 2, perPage: 10, nextPerPage: 10 }), 2);
  });

  test('os textos da linha: idade, duração, custo, faixa e id', () => {
    const agora = Date.parse('2026-05-01T12:00:00Z');
    assert.equal(age('2026-05-01T11:59:30Z', agora), 'agora');
    assert.equal(age('2026-05-01T11:58:00Z', agora), 'há 2 min');
    assert.equal(age('2026-05-01T09:00:00Z', agora), 'há 3 h');
    assert.equal(age('2026-04-28T12:00:00Z', agora), 'há 3 d');
    assert.equal(duration(20_000), '< 1 min');
    assert.equal(duration(12 * 60_000), '12 min');
    assert.equal(duration(190 * 60_000), '3 h 10');
    assert.equal(duration(120 * 60_000), '2 h');
    assert.equal(duration(28 * 3_600_000), '1 d 4 h');
    assert.equal(cost(1.84), '~US$ 1,84');
    assert.equal(cost(0), '~US$ 0,00');
    assert.equal(cost(null), 'sem preço');
    assert.equal(band({ total: 12, page: 1, perPage: 10 }), '1–10 de 12');
    assert.equal(band({ total: 12, page: 2, perPage: 10 }), '11–12 de 12');
    assert.equal(band({ total: 0, page: 1, perPage: 10 }), '0 de 0');
    assert.equal(shortId('7f3a2c1e-1111-2222-3333-444455556666'), '7f3a2c1e');
    assert.equal(shortId('sim-panel-current'), 'sim-panel-current');
  });

  // A janela do app abre com 1100 px (#150): sem a barra (220) e o respiro (2 × 24 + 2 de borda),
  // a tabela tem 830 px; abaixo de 900 px de janela, 610 px e sem o Diretório. Cada coluna precisa
  // do mínimo que o texto mais largo dela pede (medido no navegador), senão corta ou rola.
  test('a tabela cabe em 1100 px sem rolagem horizontal, e abaixo de 900 px sem o Diretório', () => {
    const css = readFileSync(`${UI_FOLDER}sessions.css`, 'utf8');
    const corte = css.indexOf('@media (max-width: 900px)');
    assert.ok(corte > 0, 'falta a faixa de 900 px');
    const larguras = (trecho: string) => Object.fromEntries([...trecho.matchAll(/\.table \.(c-[a-z]+) \{ width: (\d+)%; \}/g)].map(([, c, w]) => [c!, Number(w)]));
    const largas = larguras(css.slice(0, corte));
    const estreitas = { ...largas, ...larguras(css.slice(corte)) };
    const classes = COLUMNS.map(([c]: [string]) => c);
    assert.deepEqual(Object.keys(largas).sort(), [...classes].sort(), 'toda coluna tem largura');
    assert.equal(classes.reduce((t: number, c: string) => t + largas[c]!, 0), 100);
    assert.equal(classes.filter((c: string) => c !== 'c-dir').reduce((t: number, c: string) => t + estreitas[c]!, 0), 100, 'sem o Diretório, o resto soma 100');
    assert.match(css, /\.table \{ table-layout: fixed; \}/);
    assert.match(css.slice(corte), /\.table \.c-dir, \.table \.dir \{ display: none; \}/);
    assert.doesNotMatch(css, /overflow-x:\s*auto/, 'a tabela não rola');
    // Mínimos em px, com o respiro das células (20 px na larga, 12 na estreita).
    const MINIMO: Record<string, number> = { 'c-session': 180, 'c-status': 140, 'c-activity': 90, 'c-duration': 85, 'c-agents': 74, 'c-cost': 85, 'c-dir': 100, 'c-arrow': 24 };
    const MINIMO_ESTREITO: Record<string, number> = { ...MINIMO, 'c-session': 130, 'c-activity': 70, 'c-duration': 75, 'c-agents': 60, 'c-cost': 80 };
    for (const c of classes) {
      assert.ok((largas[c]! / 100) * 830 >= MINIMO[c]!, `${c} em 1100: ${(largas[c]! / 100) * 830} px`);
      if (c !== 'c-dir') assert.ok((estreitas[c]! / 100) * 610 >= MINIMO_ESTREITO[c]!, `${c} em 880: ${(estreitas[c]! / 100) * 610} px`);
    }
  });

  // O CSS de cada tela fica carregado quando se troca de tela: uma classe com o mesmo nome em duas
  // telas desmonta a outra (o `.row` do Dashboard, que é flex, desmontava as linhas desta tabela).
  test('o CSS desta tela não estiliza classe de outra tela, fora os selos de status em comum', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
    // As da moldura (`.icone`, `.btn`) são de todas as telas.
    const daMoldura = classes('shell.css');
    const minhas = new Set([...classes('sessions.css')].filter((c) => !daMoldura.has(c)));
    const outras = readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && !['sessions.css', 'shell.css', 'brand.css'].includes(a));
    for (const outra of outras) {
      const comuns = [...classes(outra)].filter((c) => minhas.has(c) && !SELOS.has(c));
      assert.deepEqual(comuns, [], `sessions.css e ${outra} estilizam as mesmas classes`);
    }
  });

  // A mesma regra para a tela Workflows (#96), a aba Workflow do detalhe (#97), o Dev Console (#179)
  // e as Máquinas (#178), contra todo CSS da /ui (também os de ui/screens/), e toda classe própria delas com o prefixo da tela.
  test('o CSS de Workflows, da aba Workflow, do Dev Console, das Máquinas (#178) e das Instruções (#183) só tem classe própria com prefixo, e nenhuma de outra tela', () => {
    const classes = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
    const daMoldura = classes('shell.css');
    const todos = [...readdirSync(UI_FOLDER), ...readdirSync(`${UI_FOLDER}screens`).map((a) => `screens/${a}`)].filter((a) => a.endsWith('.css') && !['shell.css', 'brand.css'].includes(a));
    // The machine screens (issue 178): `tm-`.
    for (const [arquivo, prefixo] of [['screens/workflows.css', 'wf-'], ['screens/session-detail-workflow.css', 'wfd-'], ['screens/dev-console.css', 'dev-'], ['screens/machine.css', 'tm-'], ['screens/agent-instructions.css', 'ins-'], ['screens/framework-install.css', 'fwi-'], ['screens/adrs.css', 'adr-']] as const) {
      const minhas = [...classes(arquivo)].filter((c) => !daMoldura.has(c) && !SELOS.has(c));
      assert.deepEqual(minhas.filter((c) => !c.startsWith(prefixo) || (prefixo === 'wf-' && c.startsWith('wfd-'))), [], `${arquivo}: classe sem o prefixo ${prefixo}`);
      for (const outra of todos.filter((a) => a !== arquivo)) {
        const comuns = [...classes(outra)].filter((c) => minhas.includes(c));
        assert.deepEqual(comuns, [], `${arquivo} e ${outra} estilizam as mesmas classes`);
      }
    }
  });
});
