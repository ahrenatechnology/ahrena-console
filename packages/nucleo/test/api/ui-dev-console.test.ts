// The Dev Console screen on /ui (C27, #179): its pure parts, its registration and its files, and the
// screen mounted on the fake DOM against the simulator's synthetic context (the same Dev Console the
// núcleo serves under --demo: fake GitHub, sessions and decisions in memory). No network, no real data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas } from '../../src/api/index.ts';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { registerDecision } from '../../src/decisoes/registro.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { createDevConsole, DEV_CONSOLE_TTL, type DevConsole, type DevConsoleView } from '../../src/dev-console/index.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { LeituraDaFrota } from '../../src/mcp/index.ts';
import type { Session } from '../../src/model.ts';
import { DEV_CONSOLE_SIMULATOR_CONTEXTS, devConsoleSimulatorGit, SimulatedDevConsoleSource } from '../../src/simulador/dev-console.ts';
import { agent, event, session } from '../fixtures.ts';
import { clock, type Clock } from '../github/helpers.ts';
import { ElementoFalso, instalarDomFalso, texto } from './dom-falso.ts';

instalarDomFalso();

// What the screen uses from the browser besides the DOM: the address and the history.
const here = { pathname: '/ui/dev-console', search: '' };
const pushed: string[] = [];
Object.assign(globalThis, {
  location: here,
  history: {
    state: null,
    pushState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, 'http://127.0.0.1');
      here.pathname = u.pathname;
      here.search = u.search;
      pushed.push(url);
    },
  },
});

// @ts-expect-error: browser module, plain JavaScript
import { acharTela, sidebarSections, TELAS } from '../../ui/telas.js';
// @ts-expect-error: idem
import { NOMES_DOS_ICONES } from '../../ui/dom.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/telas/dev-console.js'
);
const { ago, apiRoute, ciLabel, clockTime, DEV_COLUMNS, dependsOnYouCard, montar, queueNote, reasonLabel, reasonTone, reviewLabel, scoreboardCards, screenRoute, stateFromSearch, touchesDevConsole } = screen;

const FILES = ['telas/dev-console.js', 'telas/dev-console.css'];

// ---------- the simulator's Dev Console ----------

let storage: SqliteStorage;
let now: Clock;
let source: SimulatedDevConsoleSource;
let devConsole: DevConsole;
const minutesAgo = (m: number) => new Date(now() - m * 60_000).toISOString();

async function live(over: Partial<Session>) {
  const s = session({ startedAt: minutesAgo(60), updatedAt: minutesAgo(1), ...over });
  await storage.putSession(s);
  await storage.putAgent(agent({ id: `${s.id}:main`, sessionId: s.id, status: s.awaitingInputSince ? 'waiting' : 'working' }));
  return s;
}

beforeEach(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  const decisions = new SqliteDecisionStore(storage.db);
  now = clock(Date.now());
  source = new SimulatedDevConsoleSource({ now });
  const frota = new LeituraDaFrota({ storage, contas: new Contas({ storage, arquivo: null }), agora: now, fusoHorario: 'UTC', cacheMs: 0 });
  devConsole = createDevConsole({ storage, frota, decisions, source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit, now });
  await live({ id: 'working', name: 'Separar pagamentos', cwd: '/sim/vitrine-demo' });
  const s = await live({ id: 'permission', name: 'Rodar a migração', cwd: '/sim/motor-de-regras', awaitingInputSince: minutesAgo(2), awaitingReason: 'notification' });
  await storage.appendEvent(event({ sessionId: s.id, id: 'permission-e1', agentId: 'permission:main', createdAt: minutesAgo(2), type: 'Notification', toolName: null, summary: 'Claude needs your permission', data: { notification_type: 'permission_prompt' } }));
  await registerDecision(
    decisions,
    { sourceKey: 'q1', sessionId: 'working', topic: 'db', context: null, choice: 'SQLite em memória nos testes', alternatives: [], decidedBy: 'usuario', origin: 'pergunta', inferred: false, decidedAt: minutesAgo(1) },
    minutesAgo(1),
  );
});
afterEach(() => storage.close());

/** A `ler` that answers like the núcleo: the route goes to the Dev Console, the JSON goes through a round trip. */
function readerOf(dc: () => DevConsole) {
  return async (route: string) => {
    const url = new URL(route, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/dev-console');
    const context = url.searchParams.get('context');
    const body = context === null ? await dc().overview() : await dc().view(context);
    if (body === null) throw Object.assign(new Error('contexto não encontrado'), { name: 'ErroDeLeitura', status: 404 });
    return JSON.parse(JSON.stringify(body));
  };
}

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  ready: Promise<unknown>;
  change: (changes: unknown[]) => void;
  restart: () => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => {
  for (const m of open.splice(0)) m.leave();
  here.search = '';
  pushed.length = 0;
});

function mount(read: (route: string) => Promise<unknown>, search = ''): Mounted {
  here.search = search;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const signal = new AbortController();
  const onChange: ((c: unknown[]) => void)[] = [];
  const onRestart: (() => void)[] = [];
  let cleanup: (() => void) | null = null;
  const ctx = {
    params: {},
    sinal: signal.signal,
    ler: (route: string) => (reads.push(route), read(route)),
    aoMudar: (f: (c: unknown[]) => void) => onChange.push(f),
    aoReiniciar: (f: () => void) => onRestart.push(f),
    aoVivo: () => 'ao-vivo',
    contador: () => {},
    titulo: () => {},
    navegar: () => {},
  };
  const ready = montar(area, ctx).then((f: () => void) => (cleanup = f));
  const m: Mounted = {
    area,
    reads,
    ready,
    change: (c) => onChange.forEach((f) => f(c)),
    restart: () => onRestart.forEach((f) => f()),
    leave: () => (signal.abort(), cleanup?.()),
  };
  open.push(m);
  return m;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const all = (area: ElementoFalso, selector: string) => area.querySelectorAll(selector).map((n) => texto(n));

// ---------- pure parts ----------

describe('Dev Console: pure parts', () => {
  test('#179/AC-3 every not-ready reason has a readable pt-BR label and a tone; stacked names its base', () => {
    const labels = ['draft', 'conflict', 'checking', 'ci-failing', 'changes-requested', 'behind', 'ci-running', 'no-ci', 'stacked'].map((r) => reasonLabel(r));
    assert.deepEqual(labels, ['rascunho', 'conflito', 'verificando', 'CI vermelho', 'pediram mudanças', 'atrás da base', 'CI rodando', 'sem CI', 'empilhado']);
    assert.equal(reasonLabel('stacked', 79), 'empilhado em #79');
    assert.equal(reasonLabel('checking', 79), 'verificando');
    assert.deepEqual(['conflict', 'ci-failing', 'changes-requested'].map(reasonTone), ['error', 'error', 'error']);
    assert.deepEqual(['checking', 'ci-running', 'behind', 'stacked'].map(reasonTone), ['waiting', 'waiting', 'waiting', 'waiting']);
    assert.equal(reasonTone('draft'), 'neutral');
    assert.deepEqual(reviewLabel('APPROVED'), ['aprovado', 'ok']);
    assert.deepEqual(reviewLabel(null), ['sem review', 'neutral']);
    assert.deepEqual(ciLabel('failing'), ['CI ✕', 'error']);
    assert.equal(ciLabel(null), null);
  });

  test('#179/AC-2 the context and the merge-queue tab live in the address, round trip', () => {
    assert.deepEqual(stateFromSearch(''), { tab: 'context', context: null });
    assert.deepEqual(stateFromSearch('?context=loja'), { tab: 'context', context: 'loja' });
    assert.deepEqual(stateFromSearch('?context=dono/repo'), { tab: 'context', context: 'dono/repo' });
    assert.deepEqual(stateFromSearch('?context=a%20b'), { tab: 'context', context: null });
    assert.deepEqual(stateFromSearch('?tab=merge-queue&context=loja'), { tab: 'merge-queue', context: null });
    for (const s of [{ tab: 'context', context: 'loja' }, { tab: 'context', context: 'dono/repo' }, { tab: 'merge-queue', context: null }]) {
      assert.deepEqual(stateFromSearch(new URL(screenRoute(s), 'http://x').search), s);
    }
    assert.equal(screenRoute({ tab: 'context', context: null }), '/ui/dev-console');
    assert.equal(apiRoute(), '/api/dev-console');
    assert.equal(apiRoute('dono/repo'), '/api/dev-console?context=dono%2Frepo');
  });

  test('#179/AC-5 relative and clock times in pt-BR', () => {
    const t = Date.parse('2026-10-20T15:00:00');
    assert.equal(ago(new Date(t - 40_000).toISOString(), t), 'há 40 s');
    assert.equal(ago(new Date(t - 4 * 60_000).toISOString(), t), 'há 4 min');
    assert.equal(ago(new Date(t - 3 * 3_600_000).toISOString(), t), 'há 3 h');
    assert.equal(ago(null, t), null);
    assert.equal(clockTime(new Date(Date.parse('2026-10-20T09:12:00')).toISOString(), t), 'hoje 09:12');
    assert.equal(clockTime(new Date(Date.parse('2026-10-19T22:40:00')).toISOString(), t), 'ontem 22:40');
    assert.equal(clockTime(new Date(Date.parse('2026-10-17T18:05:00')).toISOString(), t), '17/10 18:05');
  });

  test('#179/AC-3 the six columns, in order, each with its criterion', () => {
    assert.deepEqual(DEV_COLUMNS.map((c: { id: string }) => c.id), ['todo', 'delegated', 'in-progress', 'in-review', 'blocked', 'done']);
    assert.deepEqual(DEV_COLUMNS.map((c: { label: string }) => c.label), ['A fazer', 'Delegada', 'Em desenvolvimento', 'Em revisão', 'Bloqueada', 'Feita']);
    for (const c of DEV_COLUMNS) assert.ok(c.criterion.length > 10, c.id);
  });

  test('#179/AC-3 scoreboard, depends-on-you and queue notes from the simulator data', async () => {
    const v = JSON.parse(JSON.stringify(await devConsole.view('loja'))) as DevConsoleView;
    const cards = scoreboardCards(v);
    assert.deepEqual(cards.map((c: { label: string; value: number }) => [c.label, c.value]), [
      ['Prontos', 3],
      ['CI rodando', 1],
      ['CI vermelho', 2],
      ['Trabalhando', 1],
      ['Esperando você', 1],
    ]);
    assert.equal(cards[1].sub, '#83');
    assert.equal(cards[2].sub, '#77 · #82 em conflito');
    assert.equal(cards[2].alert, true);
    assert.equal(cards[4].sub, '1 sessão');
    const d = dependsOnYouCard(v.dependsOnYou[0]);
    assert.equal(d.title, 'Rodar a migração');
    assert.match(d.text, /^Pede permissão/);
    assert.equal(d.where, 'motor-de-regras');
    assert.equal(d.href, '/ui/sessoes/permission');
    const suggested = dependsOnYouCard({ kind: 'suggested-decision', choice: '10 cards por coluna', alternatives: ['20 por coluna'], title: 'Kanban', repo: 'a/b', sessionId: 's', minutes: 6, issue: null });
    assert.deepEqual([suggested.title, suggested.text], ['Decisão sugerida: 10 cards por coluna', 'Alternativa: 20 por coluna · de Kanban']);
    assert.deepEqual(v.mergeQueue.map((q) => queueNote(q, v.mergeQueue)), ['fecha #31', 'fecha #58 · base de #84', 'empilhado em #79']);
  });

  test('#179/AC-7 only session, state, needs-you and decision changes re-read the screen', () => {
    assert.equal(touchesDevConsole([{ tipo: 'sessao' }]), true);
    assert.equal(touchesDevConsole([{ tipo: 'conta' }, { tipo: 'decisao' }]), true);
    assert.equal(touchesDevConsole([{ tipo: 'precisa-de-voce' }]), true);
    assert.equal(touchesDevConsole([{ tipo: 'conta' }, { tipo: 'plano' }]), false);
    assert.equal(touchesDevConsole(null), false);
  });
});

// ---------- registration and files ----------

describe('Dev Console: registration and files', () => {
  test('#179/AC-1 /ui/dev-console opens the screen, with the item in main between Repositórios and Analytics', () => {
    const { tela } = acharTela('/ui/dev-console');
    assert.equal(tela.id, 'dev-console');
    assert.equal(tela.arquivo, '/ui/telas/dev-console.js');
    assert.deepEqual(tela.item, { rotulo: 'Dev Console', icone: 'gauge', section: 'main' });
    const main = sidebarSections().find((s: { id: string }) => s.id === 'main').items.map((t: { id: string }) => t.id);
    assert.equal(main.indexOf('dev-console'), main.indexOf('repos') + 1);
    assert.equal(main.indexOf('analytics'), main.indexOf('dev-console') + 1);
    const ids = TELAS.map((t: { id: string }) => t.id);
    assert.ok(ids.indexOf('dev-console') > ids.indexOf('repo') && ids.indexOf('dev-console') < ids.indexOf('analytics'));
  });

  test('#179/AC-6 every icon the screen uses exists in dom.js', () => {
    const js = readFileSync(`${PASTA_DA_UI}telas/dev-console.js`, 'utf8');
    const used = new Set([...js.matchAll(/(?:icone|eyebrow)\('([a-z-]+)'/g), ...js.matchAll(/icon: '([a-z-]+)'/g), ...js.matchAll(/icone: '([a-z-]+)'/g)].map((m) => m[1]!));
    assert.ok(used.has('gauge') && used.has('hand') && used.has('merge'));
    for (const name of used) assert.ok(NOMES_DOS_ICONES.includes(name), `${name} is not in dom.js`);
  });

  test('#179/AC-6 the files call nothing outside, write no colour, no inline style, no HTML from data', () => {
    for (const f of FILES) {
      const body = readFileSync(`${PASTA_DA_UI}${f}`, 'utf8');
      const urls = (body.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${f} names an external address`);
      assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${f} writes a colour by hand`);
      assert.doesNotMatch(body, /style=|innerHTML|\bfetch\(/, `${f} uses inline style, innerHTML or fetch`);
    }
  });

  test('#179/AC-6 the screen only uses dev- classes that exist in its stylesheet', () => {
    const css = readFileSync(`${PASTA_DA_UI}telas/dev-console.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const defined = new Set([...css.matchAll(/\.(dev-[a-z0-9-]+)/g)].map((m) => m[1]!));
    const js = readFileSync(`${PASTA_DA_UI}telas/dev-console.js`, 'utf8');
    const used = new Set([...js.matchAll(/\bdev-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.endsWith('-') && c !== 'dev-console'));
    for (const c of used) assert.ok(defined.has(c), `${c} is not in dev-console.css`);
    // The templated ones: pills, tones, dots and columns.
    for (const t of ['ok', 'error', 'waiting', 'neutral']) assert.ok(defined.has(`dev-pill-${t}`), t);
    for (const c of DEV_COLUMNS) assert.ok(defined.has(`dev-dot-${c.tone}`), c.tone);
    assert.ok(defined.has('dev-col-blocked') && defined.has('dev-col-done'));
  });

  test('#179/AC-4 the board has six tracks side by side and, below 1280 px of window, four and two underneath', () => {
    const css = readFileSync(`${PASTA_DA_UI}telas/dev-console.css`, 'utf8');
    assert.match(css, /\.dev-board \{[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.dev-col \{[^}]*grid-column: span 2;/);
    assert.match(css, /@media \(max-width: 1279px\) \{\s*\.dev-col \{ grid-column: span 3; \}\s*\.dev-col-blocked, \.dev-col-done \{ grid-column: span 6; \}/);
    assert.doesNotMatch(css, /overflow-x:\s*(auto|scroll)/);
  });
});

// ---------- mounted ----------

describe('Dev Console mounted on the simulator data', () => {
  test('#179/AC-5 loading first, then the screen; the stylesheet goes to the head and leaves with the screen', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = readerOf(() => devConsole);
    const m = mount(async (r) => (await gate, read(r)));
    assert.ok(m.area.querySelector('.carregando'), 'skeleton while the first read is out');
    assert.ok(document.head.querySelector('link[data-tela="dev-console"]'));
    release();
    await m.ready;
    assert.equal(m.area.querySelector('.carregando'), null);
    m.leave();
    assert.equal(document.head.querySelector('link[data-tela="dev-console"]'), null);
  });

  test('#179/AC-2 #179/AC-3 the first context opens with the five numbers, depends on you, the queue, the board and the footer', async () => {
    const m = mount(readerOf(() => devConsole));
    await m.ready;
    assert.deepEqual(m.reads, ['/api/dev-console', '/api/dev-console?context=loja']);
    const a = m.area;
    // Tabs: the merge queue of all contexts and the context, which is on.
    assert.deepEqual(all(a, '.dev-tab'), ['Fila de merge · 3', 'Loja · 2 repos']);
    assert.equal(texto(a.querySelector('.dev-tab[aria-current="page"]')), 'Loja · 2 repos');
    assert.match(texto(a.querySelector('.dev-source')), /dev-console\.json/);
    assert.match(texto(a.querySelector('.sub')), /GitHub lido há/);
    // Scoreboard.
    assert.deepEqual(all(a, '.dev-stat-value'), ['3', '1', '2', '1', '1']);
    assert.ok(a.querySelector('.dev-stat-alert[data-stat="ci-failing"]'));
    // Depends on you, linking to the session.
    assert.match(texto(a.querySelector('.dev-inbox .dev-eyebrow')), /Depende de você · 1/);
    assert.equal(a.querySelector('.dev-depend')?.getAttribute('href'), '/ui/sessoes/permission');
    // Queue in order, the stacked after its base; the not-ready collapsed with readable reasons.
    assert.deepEqual(all(a, '.dev-queue-row .dev-queue-title'), ['Endpoint de exportação em CSV', 'Migração do esquema de pedidos', 'Índices da tabela de pedidos']);
    assert.match(all(a, '.dev-queue-row small')[2]!, /empilhado em #79/);
    const more = a.querySelector('details.dev-more')!;
    assert.equal(more.hasAttribute('open'), false, 'not-ready starts collapsed');
    assert.match(texto(more.querySelector('summary')), /Na fila, ainda não prontos · 3/);
    assert.deepEqual(all(more, '.dev-more-tags .dev-pill'), ['#82 conflito', '#77 CI vermelho', '#83 CI rodando']);
    // Board: six columns with criterion and cards.
    assert.deepEqual(a.querySelectorAll('.dev-col').map((c) => c.getAttribute('data-column')), ['todo', 'delegated', 'in-progress', 'in-review', 'blocked', 'done']);
    assert.deepEqual(all(a, '.dev-col-criterion'), DEV_COLUMNS.map((c: { criterion: string }) => c.criterion));
    assert.deepEqual(all(a, '.dev-col-count'), ['4', '0', '2', '3', '1', '3']);
    assert.equal(a.querySelectorAll('.dev-col-done .dev-card-slim').length, 3);
    // Merged in 24 h and the decisions taken today, with the link to Decisões.
    const [merged, decisions] = a.querySelectorAll('.dev-list-card');
    assert.equal(merged!.querySelectorAll('.dev-list-row').length, 3);
    assert.match(texto(merged!), /Paginação da listagem/);
    assert.match(texto(decisions!), /SQLite em memória nos testes/);
    assert.equal(decisions!.querySelector('.dev-list-link')?.getAttribute('href'), '/ui/decisoes');
    assert.equal(texto(decisions!.querySelector('.dev-list-link')), '1 · ver em Decisões ›');
  });

  test('#179/AC-2 the "Fila de merge" tab shows the queue of every context, and clicking a tab keeps the screen and changes the address', async () => {
    const m = mount(readerOf(() => devConsole), '?tab=merge-queue');
    await m.ready;
    assert.deepEqual(m.reads, ['/api/dev-console']);
    assert.equal(texto(m.area.querySelector('.dev-tab[aria-current="page"]')), 'Fila de merge · 3');
    assert.deepEqual(all(m.area, '.dev-queue-row .dev-num'), ['#81', '#79', '#84']);
    assert.match(texto(m.area.querySelector('.dev-queue-row small')), /dev-sintetico\/catalogo-exemplo/);
    assert.equal(m.area.querySelector('.dev-stats'), null);
    const loja = m.area.querySelectorAll('.dev-tab').find((t) => texto(t) === 'Loja · 2 repos')!;
    loja.dispatchEvent({ type: 'click' });
    await until(() => !!m.area.querySelector('.dev-stats'));
    assert.deepEqual(pushed, ['/ui/dev-console?context=loja']);
    assert.ok(m.reads.includes('/api/dev-console?context=loja'));
  });

  test('#179/AC-5 without GitHub: the band with the cache time over the cached screen', async () => {
    await devConsole.view('loja');
    now.add(DEV_CONSOLE_TTL.issues + 1);
    source.offline = true;
    const m = mount(readerOf(() => devConsole), '?context=loja');
    await m.ready;
    const band = m.area.querySelector('.faixa-erro');
    assert.ok(band);
    assert.match(texto(band), /Sem conexão com o GitHub\. Mostrando a leitura das \d\d:\d\d \(há [^)]+\)\. GitHub fora do ar \(simulado\)\./);
    assert.deepEqual(all(m.area, '.dev-stat-value'), ['3', '1', '2', '1', '1']);
  });

  test('#179/AC-5 no context configured: the empty state explains ~/.ahrena-console/dev-console.json', async () => {
    const m = mount(async () => ({ contexts: [], mergeQueue: [], readAt: null, stale: false, staleReason: null }));
    await m.ready;
    const empty = m.area.querySelector('.estado');
    assert.match(texto(empty), /Nenhum contexto configurado/);
    assert.match(texto(empty), /~\/\.ahrena-console\/dev-console\.json/);
    assert.equal(m.area.querySelector('.dev-tabs'), null);
  });

  test('#179/AC-5 unknown context: says so and offers the first one', async () => {
    const m = mount(readerOf(() => devConsole), '?context=nenhum');
    await m.ready;
    assert.match(texto(m.area.querySelector('.estado')), /Contexto não encontrado/);
    assert.ok(m.area.querySelector('.dev-tabs'));
  });

  test('#179/AC-5 the read fails: the error state with "Tentar de novo", which reads again', async () => {
    let fail = true;
    const read = readerOf(() => devConsole);
    const m = mount(async (r) => {
      if (fail) throw new Error('O núcleo não respondeu');
      return read(r);
    });
    await m.ready;
    const state = m.area.querySelector('.estado[role="alert"]');
    assert.match(texto(state), /O núcleo não respondeu/);
    fail = false;
    state!.querySelector('button')!.dispatchEvent({ type: 'click' });
    await until(() => !!m.area.querySelector('.dev-stats'));
  });

  test('#179/AC-7 live: a decision change re-reads (debounced), a restart re-reads, an account change does not', async () => {
    const m = mount(readerOf(() => devConsole));
    await m.ready;
    const before = m.reads.length;
    m.change([{ tipo: 'conta' }]);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(m.reads.length, before);
    m.change([{ tipo: 'decisao' }]);
    m.change([{ tipo: 'sessao' }]);
    await until(() => m.reads.length === before + 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.reads.length, before + 2, 'two changes in a row read once (overview and context)');
    m.restart();
    await until(() => m.reads.length === before + 4);
  });
});
