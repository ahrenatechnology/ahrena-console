// The console interface at /ui (#26): the server serves the page and the sub-routes, refuses a foreign
// Origin and Host (decision 0003), and the read layer and the "Ao vivo" (live) work against the API with
// simulator data.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, TrabalhoPorBranch, type LocalApi } from '../../src/api/index.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { withChanges, ChangeCursor } from '../../src/changes/index.ts';
import { seedPanelScenario, PANEL_SESSION } from '../../src/simulator/panel.ts';
// @ts-expect-error: browser modules, in plain JavaScript
import { ReadError, httpWriter, httpReader } from '../../ui/api.js';
// @ts-expect-error: same
import { startLive } from '../../ui/live.js';
// @ts-expect-error: same
import { findScreen, litItem, machineItems, MACHINES_ROUTE, SECTIONS, sidebarSections, SCREENS } from '../../ui/screens.js';
// @ts-expect-error: same
import * as agentConfigScreen from '../../ui/screens/agent-config.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function fetchPath(url: string, path: string, { method = 'GET', headers = {} as Record<string, string>, body = '' } = {}): Promise<Reply> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (text += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('não aconteceu a tempo');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('/ui in the core', () => {
  let sqlite: SqliteStorage;
  let cursor: ChangeCursor;
  let api: LocalApi;
  let host: string;
  before(async () => {
    cursor = new ChangeCursor({ batchMs: 0, minIntervalMs: 0 });
    sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = withChanges(sqlite, cursor);
    await seedPanelScenario(storage, 'p1');
    const work = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const builder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: work });
    api = await startLocalApi({ panelBuilder: builder, hooks: { storage }, port: 0, log: () => {}, changes: cursor });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await sqlite.close();
  });

  test('/ui, /ui/sessions and /ui/sessions/<id> (and any other /ui URL, like the old /ui/sessoes/<id>) return the same page, with the content policy', async () => {
    const page = readFileSync(`${UI_FOLDER}index.html`, 'utf8');
    for (const path of ['/ui', '/ui/', '/ui/sessions', `/ui/sessions/${PANEL_SESSION}`, '/ui/sessoes', `/ui/sessoes/${PANEL_SESSION}`, '/ui/historico', '/ui/analytics/custo', '/ui/qualquer/coisa', '/ui/agent-config', '/ui/agent-config?tab=skills&project=%2Fx']) {
      const r = await fetchPath(api.url, path);
      assert.equal(r.status, 200, path);
      assert.match(String(r.headers['content-type']), /^text\/html/);
      assert.equal(r.body, page, path);
      assert.match(String(r.headers['content-security-policy']), /connect-src 'self'/);
      assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('the page files go out with the right type; what does not exist or is outside the folder gives 404', async () => {
    const js = await fetchPath(api.url, '/ui/app.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /^text\/javascript/);
    assert.match(String((await fetchPath(api.url, '/ui/brand.css')).headers['content-type']), /^text\/css/);
    // The Agent Config screen (#63): the module in screens/ and its own CSS.
    const screen = await fetchPath(api.url, '/ui/screens/agent-config.js');
    assert.equal(screen.status, 200);
    assert.match(String(screen.headers['content-type']), /^text\/javascript/);
    assert.match(screen.body, /export async function mount/);
    // The old folder (`/ui/telas/`) left with the aliases (#173, phase 6).
    assert.equal((await fetchPath(api.url, '/ui/telas/agent-config.js')).status, 404);
    const css = await fetchPath(api.url, '/ui/agent-config.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    for (const path of ['/ui/nada.js', '/ui/screens/nada.js', '/ui/index.html', '/ui/README.md', '/ui/%2e%2e/src/api/ui.ts', '/ui/..%2fpackage.json']) {
      const r = await fetchPath(api.url, path);
      assert.ok(r.status === 404 || r.body.startsWith('<!doctype html>'), `${path}: ${r.status}`);
      assert.doesNotMatch(r.body, /import \{ readFile \}|"name": "@ahrena-console/, path);
    }
  });

  test('a foreign Origin gives 403, on the page and on the API; the page itself can read', async () => {
    for (const origin of ['https://exemplo.com', 'null', `http://localhost:1`, `https://${host}`]) {
      assert.equal((await fetchPath(api.url, '/ui', { headers: { origin } })).status, 403, origin);
      assert.equal((await fetchPath(api.url, '/api/mudancas?desde=&espera=0', { headers: { origin } })).status, 403, origin);
    }
    assert.equal((await fetchPath(api.url, '/ui', { headers: { host: `exemplo.com:${new URL(api.url).port}` } })).status, 403);
    // A browser reading from the same origin: accepted.
    assert.equal((await fetchPath(api.url, '/api/overview', { headers: { origin: `http://${host}` } })).status, 200);
    // A write with Origin, even ours: refused.
    const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    assert.equal((await fetchPath(api.url, '/api/hooks', { method: 'POST', headers: { origin: `http://${host}`, 'content-type': 'application/json' }, body: hook })).status, 403);
  });

  // Addresses that only become the `href` of a link the person opens (new tab, `noopener`), never a call:
  // the Instructions tab (#183) points to the file on GitHub and to the CLAUDE.md documentation.
  // Each is the exact piece the URL search catches and appears exactly once in the file: the
  // `blobUrl` template does not open the door to another github.com address.
  const LINK_TARGETS: Record<string, string[]> = {
    'screens/agent-instructions.js': ['https://docs.claude.com/en/docs/claude-code/memory'],
    'screens/agent-instructions-markdown.js': ['https://github.com/${repo.split('],
    // ADR e PDR (#174): "Como escrever uma ADR", no vazio.
    'screens/adrs-common.js': ['https://adr.github.io/'],
    // Conexões (issue 241): "Como configurar", when the console has no OAuth App (C44).
    'screens/connections.js': ['https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow'],
  };
  const externalUrls = (file: string, text: string) => {
    const allowed = LINK_TARGETS[file] ?? [];
    const found = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    for (const l of allowed) assert.equal(found.filter((u) => u === l).length, 1, `${file}: ${l} must appear exactly once`);
    return found.filter((u) => u !== 'http://www.w3.org/2000/svg' && !allowed.includes(u));
  };
  test('the page calls nothing outside its own origin and writes no color by hand', () => {
    // The folder and the screens (`screens/`): the rules hold for every served file.
    const files = readdirSync(UI_FOLDER, { recursive: true })
      .map(String)
      .filter((a) => /\.(js|css|html)$/.test(a) && a !== 'brand.css');
    assert.ok(files.includes('index.html') && files.includes('app.js') && files.includes('screens/repos.js'));
    for (const a of files) {
      const text = readFileSync(`${UI_FOLDER}${a}`, 'utf8');
      const urls = externalUrls(a, text);
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(text, /\sstyle\s*=|setAttribute\(\s*['"]style/, `${a} usa estilo inline`);
      if (a !== 'api.js') assert.doesNotMatch(text, /\bfetch\(/, `${a} chama fetch: só api.js fala com o núcleo`);
      // `innerHTML` only in the icons (dom.js constants), never with data.
      if (a !== 'dom.js') assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML/, `${a} monta HTML com texto`);
    }
    // The screens, in ui/screens/: the same rule, and no inline style, innerHTML or direct fetch.
    const screens = readdirSync(`${UI_FOLDER}screens`).filter((a) => /\.(js|css)$/.test(a));
    for (const a of screens) {
      const text = readFileSync(`${UI_FOLDER}screens/${a}`, 'utf8');
      const urls = externalUrls(`screens/${a}`, text);
      assert.deepEqual(urls, [], `screens/${a} cita endereço externo`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `screens/${a} escreve cor à mão`);
      if (a.endsWith('.js')) {
        // What the CSP (`style-src 'self'`) blocks is the `style` attribute: `{ style: … }` in el(),
        // `style="…"` and `setAttribute('style', …)`. It lets the CSSOM (`x.style.setProperty`) through.
        assert.doesNotMatch(text, /(?<![.\w-])style\s*[=:]|['"]style['"]|innerHTML|insertAdjacentHTML|\bfetch\(/, `screens/${a} usa estilo inline, HTML ou fetch`);
      }
    }
    const page = readFileSync(`${UI_FOLDER}index.html`, 'utf8');
    for (const [, ref] of page.matchAll(/(?:href|src)="\/ui\/([^"]+)"/g)) assert.ok(readdirSync(UI_FOLDER).includes(ref!), `index.html cita ${ref}, que não existe`);
  });

  test('read(route) reads the API over HTTP and only the local core API', async () => {
    const read = httpReader({ base: api.url });
    const overview = await read('/api/overview');
    assert.equal(overview.name, 'ahrena-console');
    // The old Portuguese key `nome` is gone (#173, phase 6).
    assert.equal(overview.nome, undefined);
    const panel = await read(`/api/panel/${PANEL_SESSION}`);
    assert.ok(JSON.stringify(panel).includes(PANEL_SESSION), 'o painel da sessão do simulador');

    await assert.rejects(read('/api/nao-existe'), (e: InstanceType<typeof ReadError>) => e instanceof ReadError && e.status === 404);
    await assert.rejects(read('/ui'), /rota fora da API/);
    await assert.rejects(read('https://exemplo.com/api/overview'), /rota fora da API/);
    await assert.rejects(read('/api/../../ui'), /rota fora do núcleo/);
    assert.throws(() => httpReader({ base: 'http://exemplo.com:4720' }), /só lê o núcleo local/);
    assert.throws(() => httpReader({ base: 'https://127.0.0.1:4720' }), /só lê o núcleo local/);

    const closed = httpReader({ base: 'http://127.0.0.1:1' });
    await assert.rejects(closed('/api/overview'), (e: InstanceType<typeof ReadError>) => e.status === 0 && /não respondeu/.test(e.message));
  });

  test('live: connects with reset, delivers a hook change and stops', async () => {
    const states: string[] = [];
    const changes: { type: string; key: string }[][] = [];
    let restarts = 0;
    const live = startLive({
      read: httpReader({ base: api.url }),
      wait: 5,
      onState: ({ state }: { state: string }) => states.push(state),
      onRestart: () => restarts++,
      onChange: (m: { type: string; key: string }[]) => changes.push(m),
    });
    await until(() => restarts === 1 && cursor.openWaits === 1);
    assert.deepEqual(states, ['live']);

    const hook = { session_id: 'sess-ui', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
    const h = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
    assert.equal(h.status, 202);
    await until(() => changes.flat().some((m) => m.type === 'session' && m.key === 'sess-ui'));
    assert.equal(restarts, 1, 'mudança comum não pede releitura');

    await live.stop();
    await until(() => cursor.openWaits === 0);
  });

  test('live: without the core shows the failure, retries and re-reads when it is back', async () => {
    const states: string[] = [];
    const waits: number[] = [];
    let restarts = 0;
    let offline = 3;
    const real = httpReader({ base: api.url });
    const live = startLive({
      read: (route: string, o: unknown) => (offline-- > 0 ? httpReader({ base: 'http://127.0.0.1:1' })(route, o) : real(route, o)),
      wait: 5,
      delays: [10, 20],
      sleep: (ms: number) => (waits.push(ms), Promise.resolve()),
      onState: ({ state }: { state: string }) => states.push(state),
      onRestart: () => restarts++,
    });
    await until(() => restarts === 1);
    assert.deepEqual(waits, [10, 20, 20]);
    assert.equal(states[0], 'offline');
    assert.equal(states.at(-1), 'live');
    assert.ok(live.state === 'live');
    await live.stop();
  });

  test('live: 503 with Retry-After waits what the core asked for', async () => {
    const waits: number[] = [];
    let n = 0;
    const live = startLive({
      read: async () => {
        if (n++ === 0) throw new ReadError('lotado', { status: 503, retryIn: 5000 });
        await new Promise((r) => setTimeout(r, 5));
        return { cursor: 'c', changes: [], reset: true, timedOut: false };
      },
      sleep: (ms: number) => (waits.push(ms), Promise.resolve()),
    });
    await until(() => n >= 2);
    assert.deepEqual(waits, [5000]);
    await live.stop();
  });
});

describe('UI rule 9 (#255): cards in the same row have the same height', () => {
  const rules = (css: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((x) => x.trim()), body: m[2]! }));
  const screenFiles = (ext: string) =>
    readdirSync(UI_FOLDER, { recursive: true })
      .map(String)
      .filter((a) => a.endsWith(ext) && !['shell.css', 'brand.css'].includes(a));

  test('shell.css stretches every card of a screen to its grid row and stacks short cards in .card-column', () => {
    const shell = rules(readFileSync(`${UI_FOLDER}shell.css`, 'utf8'));
    const body = (selector: string) => shell.find((r) => r.selectors.includes(selector))?.body ?? '';
    // One class of specificity, so a screen that has to place one card still can.
    assert.match(body(':where(.cc-main) .card'), /align-self:\s*stretch/);
    assert.match(body('.card-column'), /display:\s*flex;[^}]*flex-direction:\s*column/);
    assert.match(body('.card-column > .card:last-child'), /flex:\s*1/);
  });

  test('no screen CSS takes a card out of its row height', () => {
    // Every class a screen gives together with `card` (class: 'card tm-card …').
    const cardClasses = new Set(['card']);
    for (const a of screenFiles('.js')) {
      const js = readFileSync(`${UI_FOLDER}${a}`, 'utf8');
      for (const [, list] of js.matchAll(/class: [`'"]([^`'"]*)[`'"]/g)) {
        const names = list!.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
        if (names.includes('card')) for (const n of names) cardClasses.add(n);
      }
    }
    assert.ok(cardClasses.has('tm-card') && cardClasses.size > 20);
    const optOuts: string[] = [];
    for (const a of screenFiles('.css')) {
      for (const r of rules(readFileSync(`${UI_FOLDER}${a}`, 'utf8'))) {
        if (!/align-self:\s*(?!stretch|auto)[a-z-]+/.test(r.body)) continue;
        for (const sel of r.selectors) {
          const last = sel.split(/[\s>+~]+/).pop() ?? '';
          if ([...last.matchAll(/\.([\w-]+)/g)].some(([, c]) => cardClasses.has(c!))) optOuts.push(`${a}: ${sel}`);
        }
      }
    }
    assert.deepEqual(optOuts, []);
  });
});

describe('screen registry', () => {
  test('the sidebar has Dashboard, Mural ao vivo, Sessões, the Feed, Kanban, Analytics, Workflows and Histórico; under Entrega Repositórios, the project Kanban and Dev Console; under Decisões, Das sessões, ADR and PDR; under Máquinas Esta máquina and, under Controle, Agent Config and Conexões; the Detail opens by a session and lights Sessões', () => {
    assert.deepEqual(SCREENS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id), ['dashboard', 'wall', 'sessions', 'feed', 'kanban', 'repos', 'project', 'dev-console', 'analytics', 'workflows', 'history', 'decisions', 'adrs', 'pdrs', 'this-machine', 'agent-config', 'connections']);
    assert.deepEqual(
      sidebarSections().map((s: { id: string; label: string | null; items: { id: string }[] }) => [s.id, s.label, s.items.map((t) => t.id)]),
      [
        ['main', null, ['dashboard', 'wall', 'sessions', 'feed', 'kanban', 'analytics', 'workflows', 'history']],
        ['delivery', 'Entrega', ['repos', 'project', 'dev-console']],
        ['decisions', 'Decisões', ['decisions', 'adrs', 'pdrs']],
        ['machines', 'Máquinas', ['this-machine']],
        ['control', 'Controle', ['agent-config', 'connections']],
      ],
    );
    assert.equal(findScreen('/ui/decisions').screen.file, '/ui/screens/decisions.js');
    // ADR e PDR (#174): a mesma tela de lista; o registro aberto acende o item do tipo.
    assert.equal(findScreen('/ui/adrs').screen.file, '/ui/screens/adrs.js');
    assert.equal(findScreen('/ui/pdrs').screen.file, '/ui/screens/adrs.js');
    const adr = findScreen('/ui/adrs/exemplo-labs/motor-de-regras/0008-regras-em-tabela');
    assert.deepEqual([adr.screen.id, adr.screen.highlights, adr.params], ['adr', 'adrs', { owner: 'exemplo-labs', repo: 'motor-de-regras', id: '0008-regras-em-tabela' }]);
    assert.equal(findScreen('/ui/pdrs/a/b/PDR-001-x').screen.highlights, 'pdrs');
    // O id do registro é o nome do arquivo: acento e espaço valem ali, e só ali.
    assert.equal(findScreen(`/ui/adrs/a/b/${encodeURIComponent('0004-decisão de fila')}`).params.id, '0004-decisão de fila');
    assert.equal(findScreen(`/ui/repos/${encodeURIComponent('dono ruim')}/b`), null);
    assert.equal(findScreen('/ui/repos/a/b/adrs').screen.id, 'repo-tab');
    assert.equal(findScreen('/ui/wall').screen.id, 'wall');
    assert.equal(findScreen('/ui/workflows').screen.id, 'workflows');
    assert.equal(findScreen('/ui/feed').screen.file, '/ui/screens/feed.js');
    assert.equal(findScreen('/ui').screen.id, 'dashboard');
    assert.equal(findScreen('/ui/').screen.id, 'dashboard');
    assert.equal(findScreen('/ui/sessions').screen.id, 'sessions');
    assert.equal(findScreen('/ui/history').screen.id, 'history');
    const d = findScreen('/ui/sessions/b91d04aa-4e1');
    assert.equal(d.screen.id, 'session-detail');
    assert.equal(d.screen.highlights, 'sessions');
    assert.deepEqual(d.params, { id: 'b91d04aa-4e1' });
    assert.equal(findScreen('/ui/sessions/a%20b'), null);
    assert.equal(findScreen('/ui/kanban').screen.id, 'kanban');
    assert.equal(findScreen('/ui/dev-console').screen.file, '/ui/screens/dev-console.js');
    // Conexões (issue 241): the last item of Controle, with an English route.
    assert.equal(findScreen('/ui/connections').screen.file, '/ui/screens/connections.js');
    assert.equal(findScreen('/ui/nao-existe'), null);
    // The old URLs match nothing: the shell shows "Página não encontrada" (#173, phase 6).
    for (const old of ['/ui/sessoes', '/ui/sessoes/b91d04aa-4e1', '/ui/historico', '/ui/mural', '/ui/projeto', '/ui/decisoes']) assert.equal(findScreen(old), null, old);
  });

  test('the sidebar has the sections: the everyday screens without a title, Entrega, Decisões, Máquinas and Controle; an empty section does not show', () => {
    assert.deepEqual(SECTIONS, [
      { id: 'main', label: null },
      { id: 'delivery', label: 'Entrega' },
      { id: 'decisions', label: 'Decisões' },
      { id: 'machines', label: 'Máquinas' },
      { id: 'control', label: 'Controle' },
    ]);
    for (const t of SCREENS.filter((x: { item?: unknown }) => x.item)) assert.ok(SECTIONS.some((s: { id: string }) => s.id === t.item.section), t.id);
    // A Controle item registered before the everyday ones still goes in its block, after Máquinas.
    const screens = [
      { id: 'config', item: { label: 'Agent Config', icon: 'x', section: 'control' } },
      { id: 'dashboard', item: { label: 'Dashboard', icon: 'x', section: 'main' } },
      { id: 'session-detail', highlights: 'dashboard' },
      { id: 'local', item: { label: 'Esta máquina', icon: 'x', section: 'machines' } },
      { id: 'dev', item: { label: 'Dev Console', icon: 'x', section: 'main' } },
    ];
    const sectionsOf = (ts: unknown[]) => sidebarSections(ts).map((s: { id: string; items: { id: string }[] }) => [s.id, s.items.map((t) => t.id)]);
    assert.deepEqual(sectionsOf(screens), [['main', ['dashboard', 'dev']], ['machines', ['local']], ['control', ['config']]]);
    assert.deepEqual(sectionsOf(screens.filter((t) => t.id !== 'local')), [['main', ['dashboard', 'dev']], ['control', ['config']]]);
    // An item with a wrong section does not vanish: it falls in the top block (and the loop above refuses the registration).
    assert.deepEqual(sectionsOf([{ id: 'x', item: { label: 'X', icon: 'x', section: 'unknown' } }]), [['main', ['x']]]);
  });

  test('the shell draws each section title with the shell classes, without inline style', () => {
    const app = readFileSync(`${UI_FOLDER}nav.js`, 'utf8');
    assert.match(app, /sidebarSections\(\[\.\.\.screens, \.\.\.remoteItems\]\)/);
    assert.match(app, /'cc-nav-section'/);
    assert.match(app, /'cc-nav-title eyebrow'/);
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    assert.match(css, /\.cc-nav-section \{/);
    assert.match(css, /\.cc-nav-title \{/);
  });

  test('sidebar breathing: items keep their height and only the item list scrolls on a short window', () => {
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
    // The wireframe item is about 34 px tall; it never shrinks to fit the window.
    assert.match(rule('.cc-nav'), /min-height: 34px/);
    assert.match(rule('.cc-nav'), /flex: none/);
    assert.match(rule('.cc-nav-title'), /padding: 18px 12px 8px/);
    // The list scrolls; the brand and the footer stay put.
    assert.match(rule('#nav'), /overflow-y: auto/);
    assert.match(rule('#nav'), /min-height: 0/);
    assert.match(rule('.cc-side'), /overflow: hidden/);
    assert.match(rule('.cc-brand'), /flex: none/);
    assert.match(rule('.cc-foot'), /flex: none/);
    assert.match(rule('.cc-foot'), /padding-top: 16px/);
    // The lit item is brought into view when the list scrolls.
    assert.match(readFileSync(`${UI_FOLDER}nav.js`, 'utf8'), /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/);
  });

  // Issue 178, criterion 1: the remote machines are not in the static registry; the shell reads
  // GET /api/machines and adds one item per remote to the Máquinas block, after "Esta máquina".
  test('#178 criterion 1: Máquinas has "Esta máquina" and one item per remote of /api/machines, with its state; without remotes, only "Esta máquina"', () => {
    const local = { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, version: 1, port: null, lastReadAt: null, alerts: 0 };
    const ws = { id: 'ws-exemplo', label: 'Workstation', state: 'unreachable', reason: 'port-closed', version: 1, port: 14720, lastReadAt: null, alerts: 1 };
    const lab = { id: 'lab', label: 'Laboratório', state: 'connected', reason: null, version: 1, port: 14721, lastReadAt: null, alerts: 0 };
    assert.equal(MACHINES_ROUTE, '/api/machines');
    const machinesBlock = (list: unknown) => sidebarSections([...SCREENS, ...machineItems(list)]).find((s: { id: string }) => s.id === 'machines');
    // Without remotes (only `local`, or the core without telemetry): only "Esta máquina".
    for (const list of [[local], [], null, { error: 'x' }]) assert.deepEqual(machinesBlock(list).items.map((t: { id: string }) => t.id), ['this-machine'], JSON.stringify(list));
    const block = machinesBlock([local, ws, lab]);
    assert.equal(block.label, 'Máquinas');
    assert.deepEqual(
      block.items.map((t: { id: string; route: string; item: { label: string; icon: string }; state?: string }) => [t.id, t.route, t.item.label, t.item.icon, t.state ?? null]),
      [
        ['this-machine', '/ui/machines/local', 'Esta máquina', 'monitor', null],
        ['machine-ws-exemplo', '/ui/machines/ws-exemplo', 'Workstation', 'server', 'unreachable'],
        ['machine-lab', '/ui/machines/lab', 'Laboratório', 'server', 'connected'],
      ],
    );
    // The other blocks do not move.
    assert.deepEqual(sidebarSections([...SCREENS, ...machineItems([local, ws])]).map((s: { id: string }) => s.id), ['main', 'delivery', 'decisions', 'machines', 'control']);
    // What the core sends is checked: a bad id, a repeated one, `local` and junk are left out.
    assert.deepEqual(machineItems([ws, { ...ws }, { id: '../x', label: 'x' }, { id: 'local' }, 'junk', null, { id: 'sem-rotulo', state: 'weird' }]).map((t: { id: string; item: { label: string }; state: string }) => [t.id, t.item.label, t.state]), [
      ['machine-ws-exemplo', 'Workstation', 'unreachable'],
      ['machine-sem-rotulo', 'sem-rotulo', 'unreachable'],
    ]);
    // The routes: /ui/machines/local is this machine; /ui/machines/<id> opens the same screen and lights its item.
    const here = findScreen('/ui/machines/local');
    assert.equal(here.screen.id, 'this-machine');
    assert.equal(here.screen.file, '/ui/screens/machine.js');
    assert.equal(litItem(here.screen, here.params), 'this-machine');
    const there = findScreen('/ui/machines/ws-exemplo');
    assert.equal(there.screen.id, 'machine');
    assert.equal(there.screen.file, '/ui/screens/machine.js');
    assert.deepEqual(there.params, { id: 'ws-exemplo' });
    assert.equal(litItem(there.screen, there.params), 'machine-ws-exemplo');
    assert.equal(litItem(findScreen('/ui/sessions/abc').screen, { id: 'abc' }), 'sessions');
    assert.equal(findScreen('/ui/machines/a/b'), null);
  });

  // The drawing itself (nav.js) is tested on the fake DOM in ui-machines.test.ts; here, the wiring.
  test('#178 criterion 1: the shell draws the sidebar through nav.js and re-reads the machines on an alert', () => {
    const app = readFileSync(`${UI_FOLDER}app.js`, 'utf8');
    assert.match(app, /createNav\(\{ nav, read \}\)/);
    assert.match(app, /highlight\(litItem\(screen, params\)\)/);
    assert.match(app, /changes\.some\(\(c\) => c\.type === 'alert'\)\) readMachines\(\)/);
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    assert.match(css, /\.cc-nav-dot \{/);
    assert.match(css, /\.cc-nav-dot\[data-state="connected"\]/);
  });

  test('#104 criterion 1: /ui/repos opens the repository list, with a sidebar item', () => {
    const r = findScreen('/ui/repos');
    assert.equal(r.screen.id, 'repos');
    assert.equal(r.screen.item.label, 'Repositórios');
    assert.equal(r.screen.item.section, 'delivery');
    assert.equal(findScreen('/ui/repos/').screen.id, 'repos');
  });

  test('#105: /ui/repos/<owner>/<repo> opens the repository and lights Repositórios', () => {
    const r = findScreen('/ui/repos/exemplo-labs/vitrine-demo');
    assert.equal(r.screen.id, 'repo');
    assert.equal(r.screen.highlights, 'repos');
    assert.deepEqual(r.params, { owner: 'exemplo-labs', repo: 'vitrine-demo' });
    // GitHub names with a dot and an underscore.
    assert.deepEqual(findScreen('/ui/repos/meu_org/site.github.io').params, { owner: 'meu_org', repo: 'site.github.io' });
    assert.deepEqual(findScreen('/ui/repos/meu_org/site.github.io/').params, { owner: 'meu_org', repo: 'site.github.io' });
  });

  test('#105: a strange repository path matches nothing', () => {
    for (const path of ['/ui/repos/a/..', '/ui/repos/a/.', '/ui/repos/../x', '/ui/repos/a/%2e%2e', '/ui/repos/a%20b/x', '/ui/repos/a%2Fb/x', '/ui/repos/a', '/ui/repos/a/b/c/d', '/ui/repos/a/b/..', '/ui/sessions/..']) {
      assert.equal(findScreen(path), null, path);
    }
  });

  test('#183: the Instructions tab has its own URL, on the same screen as the repository', () => {
    const found = findScreen('/ui/repos/exemplo-labs/vitrine-demo/instructions');
    assert.equal(found?.screen.id, 'repo-tab');
    assert.equal(found?.screen.file, '/ui/screens/repo.js');
    assert.deepEqual(found?.params, { owner: 'exemplo-labs', repo: 'vitrine-demo', tab: 'instructions' });
    assert.equal(litItem(found!.screen, found!.params), 'repos');
  });

  test('every screen with a file points to a file that exists in ui/screens/', () => {
    for (const t of SCREENS as { id: string; file?: string | null }[]) {
      if (!t.file) continue;
      assert.match(t.file, /^\/ui\/screens\/[a-z0-9-]+\.js$/, t.id);
      readFileSync(`${UI_FOLDER}${t.file.slice('/ui/'.length)}`);
    }
  });

  test('the shell routes the URL as it came: no old /ui URL is swapped any more (#173, phase 6)', () => {
    const app = readFileSync(`${UI_FOLDER}app.js`, 'utf8');
    assert.doesNotMatch(app, /legacyUrl|replaceState/);
    assert.match(app, /const found = findScreen\(location\.pathname\);\n\s+if \(!found\) \{[\s\S]{0,200}Página não encontrada/);
  });
});

describe('write(route, body): the /ui write (#63)', () => {
  test('POSTs JSON to its own origin; an error becomes ReadError with the status; only the local core API', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const responses = [new Response(JSON.stringify({ ok: true, backup: '/b/x' }), { status: 200 }), new Response(JSON.stringify({ error: 'a skill mudou desde a leitura' }), { status: 409 })];
    const write = httpWriter({ base: 'http://127.0.0.1:4720', fetch: async (url: URL, init: RequestInit) => (requests.push({ url: String(url), init }), responses.shift()!) });
    assert.deepEqual(await write('/api/agent-config/skill', { root: 'u0', name: 'x', content: 'oi' }), { ok: true, backup: '/b/x' });
    assert.equal(requests[0]!.url, 'http://127.0.0.1:4720/api/agent-config/skill');
    assert.equal(requests[0]!.init.method, 'POST');
    assert.equal((requests[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { root: 'u0', name: 'x', content: 'oi' });
    assert.equal(requests[0]!.init.credentials, 'omit');
    await assert.rejects(write('/api/agent-config/skill', {}), (e: InstanceType<typeof ReadError>) => e instanceof ReadError && e.status === 409 && /mudou/.test(e.message));
    await assert.rejects(write('/ui', {}), /rota fora da API/);
    await assert.rejects(write('/api/../../ui', {}), /rota fora do núcleo/);
    assert.throws(() => httpWriter({ base: 'http://exemplo.com:4720' }), /só escreve no núcleo local/);
    assert.equal(requests.length, 2);
  });
});

describe('Agent Config screen (#63): registration and pure functions', () => {
  // Each screen's CSS stays loaded after it opens once: a selector without the screen's own class
  // (`ac-…`) would leak into the other screens (/ui rules, item 1).
  test('every selector in agent-config.css goes through an ac- class', () => {
    const css = readFileSync(`${UI_FOLDER}agent-config.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(',')).map((s) => s.trim()).filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s));
    assert.ok(selectors.length > 20);
    assert.deepEqual(selectors.filter((s) => !s.includes('.ac-')), []);
  });

  test('registered at /ui/agent-config, with the Agent Config item (bot icon) and the file in screens/', () => {
    const found = findScreen('/ui/agent-config');
    assert.equal(found.screen.id, 'agent-config');
    assert.equal(found.screen.file, '/ui/screens/agent-config.js');
    assert.deepEqual(found.screen.item, { label: 'Agent Config', icon: 'bot', section: 'control' });
    assert.equal(findScreen('/ui/agent-config/').screen.id, 'agent-config');
  });

  test('tab and project in the URL, round trip', () => {
    const { readUrl, urlFor } = agentConfigScreen;
    assert.deepEqual(readUrl(''), { tab: 'overview', project: null });
    assert.deepEqual(readUrl('?tab=skills&project=%2Fa%2Fb'), { tab: 'skills', project: '/a/b' });
    assert.deepEqual(readUrl('?tab=made-up'), { tab: 'overview', project: null });
    assert.equal(urlFor({ tab: 'overview' }), '/ui/agent-config');
    assert.equal(urlFor({ tab: 'skills', project: '/a b' }), '/ui/agent-config?tab=skills&project=%2Fa+b');
    assert.deepEqual(readUrl(urlFor({ tab: 'hooks', project: '/x/y' }).split('?')[1]), { tab: 'hooks', project: '/x/y' });
  });

  test('scope and search filter on the client', () => {
    const { inScope, searchSkills } = agentConfigScreen;
    const skills = [
      { name: 'revisar-pr', declaredName: null, description: 'Revisa um PR contra o guia', scope: 'user' },
      { name: 'migracao-segura', declaredName: 'Migração', description: 'Escreve migrações com volta', scope: 'project' },
    ];
    assert.equal(inScope(skills, 'all').length, 2);
    assert.deepEqual(inScope(skills, 'project').map((s: { name: string }) => s.name), ['migracao-segura']);
    assert.deepEqual(searchSkills(skills, '  MIGRAÇÃO ').map((s: { name: string }) => s.name), ['migracao-segura']);
    assert.deepEqual(searchSkills(skills, 'guia').map((s: { name: string }) => s.name), ['revisar-pr']);
    assert.equal(searchSkills(skills, '').length, 2);
  });

  test('"editado há N dias"', () => {
    const { editedAgo } = agentConfigScreen;
    const now = Date.parse('2026-10-20T12:00:00Z');
    assert.equal(editedAgo(now - 10_000, now), 'editado agora');
    assert.equal(editedAgo(now + 60_000, now), 'editado agora');
    assert.equal(editedAgo(now - 5 * 60_000, now), 'editado há 5 min');
    assert.equal(editedAgo(now - 3 * 3600_000, now), 'editado há 3 h');
    assert.equal(editedAgo(now - 26 * 3600_000, now), 'editado há 1 dia');
    assert.equal(editedAgo(now - 3 * 86400_000, now), 'editado há 3 dias');
    assert.equal(editedAgo(undefined, now), '');
  });

  test("a new skill's name follows the core's pattern and does not repeat the folder", async () => {
    const { validateSkillName, SKILL_NAME, skillTemplate } = agentConfigScreen;
    const { SKILL_NAME: fromCore } = await import('../../src/agent-config/skills.ts');
    assert.equal(String(SKILL_NAME), String(fromCore));
    assert.equal(validateSkillName('revisar-pr'), null);
    assert.equal(validateSkillName('v1.2_ok'), null);
    assert.match(validateSkillName(''), /Dê um nome/);
    for (const bad of ['Maiuscula', '-comeca', 'com espaco', 'a/b', '..', 'x'.repeat(65)]) assert.match(validateSkillName(bad), /minúsculas/, bad);
    assert.match(validateSkillName('revisar-pr', new Set(['revisar-pr'])), /Já existe/);
    assert.match(skillTemplate('minha'), /^---\nname: minha\ndescription: .+\n---\n/);
  });

  test('the summary: total and "N do usuário · M do projeto", or the filtered scope', () => {
    const { countFor, captionFor } = agentConfigScreen;
    const c = { total: 24, user: 18, project: 6 };
    assert.equal(countFor(c, 'all'), 24);
    assert.equal(countFor(c, 'user'), 18);
    assert.equal(countFor(c, 'project'), 6);
    assert.equal(captionFor(c, 'all'), '18 do usuário · 6 do projeto');
    assert.equal(captionFor(c, 'project'), 'do projeto');
  });
});
