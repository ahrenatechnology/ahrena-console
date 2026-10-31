// "Conectar ao GitHub" (issue 241, wireframe C42) and the sidebar footer (ghFooter): the shared pieces
// of ui/github-connect.js, and every GitHub-backed screen answering 409 `github-not-connected` with the
// same empty state, which says what the screen would do and opens Conexões already starting the code.
// The screens re-read when the connection changes, and the empty state goes away. Fake DOM, fake transport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
const here = { pathname: '/ui/repos', search: '' };
Object.assign(globalThis, {
  location: here,
  history: { state: null, replaceState: () => {}, pushState: () => {} },
  getSelection: () => ({ toString: () => '' }),
});

// @ts-expect-error: browser module, plain JavaScript
const gc = await import('../../ui/github-connect.js');
// @ts-expect-error: idem
const { ReadError, WriteError } = await import('../../ui/api.js');

const notConnected = () => new ReadError('github-not-connected', { status: 409, body: { error: 'github-not-connected' } });

describe('github-connect.js: the pure parts', () => {
  test('only a 409 github-not-connected is "not connected"', () => {
    assert.equal(gc.isGithubNotConnected(notConnected()), true);
    assert.equal(gc.isGithubNotConnected(new ReadError('x', { status: 409, body: { error: 'source-is-gh' } })), false);
    assert.equal(gc.isGithubNotConnected(new ReadError('x', { status: 503, body: { error: 'github-not-connected' } })), false);
    assert.equal(gc.isGithubNotConnected(null), false);
  });

  test('a batch with a connections change', () => {
    assert.equal(gc.connectionChanged([{ type: 'session' }, { type: 'connections', key: 'github' }]), true);
    assert.equal(gc.connectionChanged([{ type: 'repos', key: 'list' }]), false);
    assert.equal(gc.connectionChanged(null), false);
  });

  test('a link from the core is kept only when it is https on github.com', () => {
    assert.equal(gc.githubHttpsUrl('https://github.com/settings/connections/applications/x'), 'https://github.com/settings/connections/applications/x');
    for (const bad of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://evil.example/github.com', 'javascript:alert(1)', 'https://a:b@github.com/', 42, null]) assert.equal(gc.githubHttpsUrl(bad), null, String(bad));
  });

  test('the empty state: the screen sentence, one button to /ui/connections?start=1 and the note', () => {
    const went: string[] = [];
    const states: unknown[] = [];
    const node = gc.connectEmptyFor('repos', (r: string, state?: unknown) => (went.push(r), states.push(state)));
    assert.equal(texto(node.querySelector('h2')), 'Conecte o console ao GitHub');
    assert.equal(texto(node.querySelector('.ghc-what')), gc.CONNECT_TEXT.repos);
    assert.match(texto(node.querySelector('.ghc-note')), /^Uma vez para todas as telas\. Abre Conexões já com o código/);
    const b = node.querySelector('[data-action="connect"]')!;
    assert.equal(texto(b), 'Conectar ao GitHub');
    b.click();
    assert.deepEqual(went, ['/ui/connections?start=1']);
    assert.deepEqual(states, [{ startConnect: true }], 'the history state that lets Conexões start the flow');
  });

  test('the footer says "GitHub · conectar", "esperando" or "<login> · conectado" (ghFooter)', () => {
    assert.deepEqual(gc.footerState({ state: 'disconnected' }), { name: 'GitHub', label: 'conectar', tone: 'off' });
    assert.deepEqual(gc.footerState({ state: 'pending' }), { name: 'GitHub', label: 'esperando', tone: 'pending' });
    assert.deepEqual(gc.footerState({ state: 'connected', login: 'dev-sintetico' }), { name: 'dev-sintetico', label: 'conectado', tone: 'on' });
    assert.deepEqual(gc.footerState({ state: 'connected', login: null }), { name: 'GitHub', label: 'conectado', tone: 'on' });
    assert.deepEqual(gc.footerState({ state: 'unavailable', reason: 'no-vault' }), { name: 'GitHub', label: 'indisponível', tone: 'off' });
    assert.equal(gc.footerState(null), null);
  });

  test('C92 (#372): with a revoked credential the empty state says so and opens Conexões without a flow', () => {
    const footer = gc.createGithubFooter({ node: new ElementoFalso('a'), read: async () => ({}) });
    footer.draw({ state: 'disconnected', lastError: 'revoked', login: 'dev-sintetico' });
    const went: unknown[][] = [];
    const node = gc.connectEmptyFor('repos', (...a: unknown[]) => void went.push(a));
    assert.equal(node.getAttribute('data-github'), 'revoked');
    assert.equal(texto(node.querySelector('h2')), 'O GitHub recusou a credencial guardada');
    assert.equal(texto(node.querySelector('.ghc-what')), gc.CONNECT_TEXT.repos);
    const b = node.querySelector('[data-action="connections"]')!;
    assert.equal(texto(b), 'Ir para Conexões');
    b.click();
    assert.deepEqual(went, [['/ui/connections']], 'no ?start=1: the person reads why first');
    footer.draw({ state: 'disconnected', lastError: null });
    assert.equal(gc.connectEmptyFor('repos', () => undefined).getAttribute('data-github'), 'not-connected');
  });

  test('the footer card reads /api/connections, links to Conexões and follows each refresh', async () => {
    let github: Record<string, unknown> = { state: 'disconnected' };
    const reads: string[] = [];
    const node = new ElementoFalso('a');
    node.setAttribute('hidden', '');
    const footer = gc.createGithubFooter({ node, read: async (r: string) => (reads.push(r), { github }) });
    assert.equal(node.getAttribute('href'), '/ui/connections');
    await footer.refresh();
    assert.deepEqual(reads, ['/api/connections']);
    assert.equal(node.hasAttribute('hidden'), false);
    assert.equal(texto(node), 'GitHub conectar');
    assert.equal(node.getAttribute('data-state'), 'off');
    github = { state: 'pending' };
    await footer.refresh();
    assert.equal(texto(node), 'GitHub esperando');
    github = { state: 'connected', login: '<b>dev</b>' };
    await footer.refresh();
    assert.equal(texto(node), '<b>dev</b> conectado', 'the login is text');
    assert.equal(node.getAttribute('aria-label'), 'GitHub: conectado como <b>dev</b>');
    const failing = gc.createGithubFooter({ node, read: async () => Promise.reject(new Error('404')) });
    await failing.refresh();
    assert.equal(texto(node), '<b>dev</b> conectado', 'a failed read keeps what was there');
  });

  test('the shell wires the footer: index.html has the card, app.js refreshes it on start, restart and connections', () => {
    assert.match(readFileSync(`${UI_FOLDER}index.html`, 'utf8'), /<a class="card cc-gh" id="github" hidden><\/a>/);
    const app = readFileSync(`${UI_FOLDER}app.js`, 'utf8');
    assert.match(app, /createGithubFooter\(\{ node: document\.getElementById\('github'\), read \}\)/);
    assert.match(app, /if \(connectionChanged\(changes\)\) githubFooter\.refresh\(\);/);
    assert.equal((app.match(/githubFooter\.refresh\(\)/g) ?? []).length, 3);
  });

  test('the write refusals are phrased in pt-BR, never the raw code', () => {
    const phrase = (status: number, body: unknown) => gc.writeErrorText(new WriteError('x', { status, body }));
    assert.equal(phrase(409, { error: 'github-unavailable', reason: 'gh-not-authenticated' }), 'O gh desta máquina não tem login.');
    assert.equal(phrase(409, { error: 'github-unavailable', reason: 'something-new' }), 'A conexão com o GitHub não está disponível nesta máquina.');
    assert.equal(phrase(415, { error: 'unsupported-media-type' }), 'O núcleo recusou o pedido.');
    assert.equal(phrase(500, null), 'O núcleo respondeu 500.');
  });
});

// ---------- every GitHub-backed screen, 409 github-not-connected ----------

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  navigated: string[];
  change: (c: unknown[]) => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

async function mountScreen(file: string, { params = {}, path = '/ui', read }: { params?: Record<string, string>; path?: string; read: (route: string) => Promise<unknown> }): Promise<Mounted> {
  const u = new URL(path, 'http://127.0.0.1');
  here.pathname = u.pathname;
  here.search = u.search;
  const { mount } = await import(`../../ui/screens/${file}`);
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const navigated: string[] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const signal = new AbortController();
  const ctx = {
    params,
    signal: signal.signal,
    read: (route: string) => (reads.push(route), read(route)),
    write: () => Promise.reject(new Error('no writes here')),
    onChange: (f: (c: unknown[]) => void) => changes.push(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (r: string) => navigated.push(r),
  };
  const cleanup = await mount(area, ctx);
  const m: Mounted = { area, reads, navigated, change: (c) => changes.forEach((f) => f(c)), leave: () => (signal.abort(), typeof cleanup === 'function' && cleanup()) };
  open.push(m);
  return m;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await tick(10);
  }
};
const refuse = async () => {
  throw notConnected();
};

// [the screen, its file, the URL, the params, the sentence id of CONNECT_TEXT]
const SCREENS: [string, string, string, Record<string, string>, string][] = [
  ['Repositórios', 'repos.js', '/ui/repos', {}, 'repos'],
  ['Repositório · Métricas', 'repo.js', '/ui/repos/exemplo-labs/motor-de-regras', { owner: 'exemplo-labs', repo: 'motor-de-regras' }, 'repo'],
  ['Repositório · Instruções', 'repo.js', '/ui/repos/exemplo-labs/motor-de-regras/instructions', { owner: 'exemplo-labs', repo: 'motor-de-regras', tab: 'instructions' }, 'instructions'],
  ['Repositório · ADRs', 'repo.js', '/ui/repos/exemplo-labs/motor-de-regras/adrs', { owner: 'exemplo-labs', repo: 'motor-de-regras', tab: 'adrs' }, 'instructions'],
  ['Kanban do projeto', 'project.js', '/ui/project', {}, 'project'],
  ['Dev Console', 'dev-console.js', '/ui/dev-console', {}, 'dev-console'],
  ['ADR', 'adrs.js', '/ui/adrs', {}, 'adrs'],
  ['PDR', 'adrs.js', '/ui/pdrs', {}, 'pdrs'],
  ['Uma ADR', 'adr-record.js', '/ui/adrs/exemplo-labs/motor-de-regras/0001-x', { owner: 'exemplo-labs', repo: 'motor-de-regras', id: '0001-x' }, 'record'],
  ['Analytics · Entregas', 'analytics.js', '/ui/analytics/delivery', { tab: 'delivery' }, 'delivery'],
];

describe('C42: every GitHub-backed screen shows "Conectar ao GitHub" on 409 github-not-connected', () => {
  for (const [name, file, path, params, key] of SCREENS) {
    test(`${name} (${file})`, async () => {
      const m = await mountScreen(file, { path, params, read: refuse });
      await until(() => Boolean(m.area.querySelector('.ghc-empty')));
      const box = m.area.querySelector('.ghc-empty')!;
      assert.equal(texto(box.querySelector('.ghc-what')), gc.CONNECT_TEXT[key]);
      assert.equal(m.area.querySelectorAll('.ghc-empty').length, 1, 'one empty state');
      assert.doesNotMatch(texto(m.area), /gh auth login|github-not-connected/, 'no terminal command, no raw code');
      box.querySelector('[data-action="connect"]')!.click();
      assert.deepEqual(m.navigated, ['/ui/connections?start=1']);
    });
  }
});

describe('C42: the screens re-read when the connection changes, and the empty state goes', () => {
  const REPOS = { state: 'ready', account: 'dev-sintetico', updatedAt: Date.now(), error: null, groups: [], computing: [] };

  test('Repositórios: a connections change re-reads, and the list replaces the empty state', async () => {
    let connected = false;
    const m = await mountScreen('repos.js', { path: '/ui/repos', read: async () => (connected ? REPOS : refuse()) });
    assert.ok(m.area.querySelector('.ghc-empty'));
    connected = true;
    m.change([{ type: 'connections', key: 'github' }]);
    await until(() => !m.area.querySelector('.ghc-empty'));
    assert.equal(m.reads.length, 2);
  });

  test('Repositórios: disconnecting while the list is open drops it for the empty state', async () => {
    let connected = true;
    const m = await mountScreen('repos.js', { path: '/ui/repos', read: async () => (connected ? REPOS : refuse()) });
    assert.equal(m.area.querySelector('.ghc-empty'), null);
    connected = false;
    m.change([{ type: 'connections', key: 'github' }]);
    await until(() => Boolean(m.area.querySelector('.ghc-empty')));
    assert.doesNotMatch(texto(m.area), /conta: dev-sintetico/, 'nothing read with the old credential stays');
  });

  test('Dev Console: a connections change re-reads even though it is not a session change', async () => {
    let connected = false;
    const m = await mountScreen('dev-console.js', { path: '/ui/dev-console', read: async () => (connected ? { contexts: [], mergeQueue: [], source: 'sessions' } : refuse()) });
    assert.ok(m.area.querySelector('.ghc-empty'));
    connected = true;
    m.change([{ type: 'connections', key: 'github' }]);
    await until(() => !m.area.querySelector('.ghc-empty'), 4000);
  });

  test('ADR: a connections change re-reads the list', async () => {
    const m = await mountScreen('adrs.js', { path: '/ui/adrs', read: refuse });
    const before = m.reads.length;
    m.change([{ type: 'connections', key: 'github' }]);
    await tick(5);
    assert.equal(m.reads.length, before + 1);
  });

  test('Kanban do projeto: connecting leads to the Project picker when none is chosen', async () => {
    let connected = false;
    const m = await mountScreen('project.js', {
      path: '/ui/project',
      read: async (route: string) => {
        if (!connected) return refuse();
        if (route === '/api/project/options') return { projects: [], selection: null, envOverride: null, fetchedAt: '', stale: false, reason: null };
        throw new ReadError('no project', { status: 503, body: { code: 'no-project' } });
      },
    });
    assert.ok(m.area.querySelector('.ghc-empty'));
    connected = true;
    m.change([{ type: 'connections', key: 'github' }]);
    await until(() => m.reads.includes('/api/project/options'), 3000);
    await until(() => !m.area.querySelector('.ghc-empty'));
    assert.match(texto(m.area), /Nenhum GitHub Project na conta/);
  });
});

describe('C42: framework install, mid-flow', () => {
  test('the plan re-read answering 409 turns the flow into the empty state, and nothing is written', async () => {
    const { mountInstallFlow } = await import('../../ui/screens/framework-install.js');
    const area = new ElementoFalso('div');
    const writes: unknown[] = [];
    const navigated: string[] = [];
    const ctx = { read: refuse, write: (...a: unknown[]) => (writes.push(a), Promise.resolve({})), navigate: (r: string) => navigated.push(r), signal: new AbortController().signal };
    mountInstallFlow(area, ctx, { owner: 'exemplo-labs', name: 'motor-de-regras', plan: null, step: 0, onClose: () => {} });
    await until(() => Boolean(area.querySelector('.ghc-empty')));
    assert.equal(texto(area.querySelector('.ghc-what')), gc.CONNECT_TEXT['framework-install']);
    assert.deepEqual(writes, []);
  });
});
