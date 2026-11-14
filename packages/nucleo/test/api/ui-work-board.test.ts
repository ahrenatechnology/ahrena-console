import { OWNER_TOKEN, ownerFetch } from '../owner-http.ts';
/*
 * #465 #466 the work board screen (layer 4, the contract): /ui/work mounted in the fake DOM over the core's
 * real HTTP server and GET /api/work, fed by the simulator's Project (the --demo board). GitHub is the
 * simulator's source, which a test can make fail; the sessions and the queue are empty, as in the demo.
 * Each test names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { respondUi } from '../../src/api/ui.ts';
import { selectedProjectBoard } from '../../src/api/work-board.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubProject, type ProjectBoardValue, type ProjectCard, type ProjectSource } from '../../src/github/project.ts';
import { workKey } from '../../src/github/work.ts';
import { EMPTY_WORK_QUEUE, WORK_BOARD_COLUMNS, type WorkSessionLink } from '../../src/github/work-board.ts';
import { SqliteWorkColumnHistory } from '../../src/github/work-board-history.ts';
import { WorkBoardService } from '../../src/github/work-board-service.ts';
import { SIMULATOR_REPO } from '../../src/simulator/panel.ts';
import { SIMULATOR_PROJECT, SimulatorProject } from '../../src/simulator/project.ts';
import { clock, type Clock } from '../github/helpers.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// #466 what the screen uses from the browser besides the DOM: the address, the history and the clipboard.
const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
const pushed: string[] = [];
const replaced: string[] = [];
const copied: string[] = [];
const go = (url: string) => {
  const u = new URL(url, here.origin);
  here.pathname = u.pathname;
  here.search = u.search;
};
Object.assign(globalThis, {
  location: here,
  history: {
    state: null,
    pushState: (_s: unknown, _t: string, url: string) => (go(url), pushed.push(url)),
    replaceState: (_s: unknown, _t: string, url: string) => (go(url), replaced.push(url)),
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t: string) => void copied.push(t) } } });

// @ts-expect-error: browser module, plain JavaScript
import { httpReader } from '../../ui/api.js';
// @ts-expect-error: idem
import { CONNECT_TEXT } from '../../ui/github-connect.js';
// @ts-expect-error: idem
import { findScreen, sidebarSections, SCREENS } from '../../ui/screens.js';
// @ts-expect-error: idem
import { errorMessage, mount } from '../../ui/screens/work-board.js';
// @ts-expect-error: idem
import { firstReadFailure, GITHUB_DOWN_REASONS, githubDownReason, staleBand } from '../../ui/screens/work-board-parts.js';

const NOW = Date.parse('2026-10-20T15:00:00Z');
const EPIC = 6;

/** The demo's Project (C11's 11 cards); `epic` adds epic #6 over #42 and #64; `fail` makes GitHub fail; `empty` has no issue. */
class DemoSource implements ProjectSource {
  private readonly demo = new SimulatorProject(NOW);
  fail: Error | null = null;
  empty = false;
  epic = false;
  titles = new Map<number, string>();
  async board(): Promise<ProjectBoardValue> {
    if (this.fail) throw this.fail;
    const demo = await this.demo.board();
    const value = { ...demo, items: demo.items.map((i) => (this.titles.has(i.number!) ? { ...i, title: this.titles.get(i.number!)! } : i)) };
    if (this.empty) return { ...value, items: [] };
    if (!this.epic) return value;
    const parent = workKey(SIMULATOR_REPO, EPIC);
    const items = value.items.map((i) => (i.number === 42 || i.number === 64 ? { ...i, parent } : i));
    const epic: ProjectCard = { ...value.items[0]!, itemId: 'PVTI_simulado6', key: parent, number: EPIC, title: 'Quadro do trabalho', url: `https://github.com/${SIMULATOR_REPO}/issues/${EPIC}`, type: 'Epic', pullRequest: null, subIssues: null, milestone: null };
    return { ...value, items: [epic, ...items] };
  }
  async move(): Promise<never> {
    throw new Error('the work board never moves a card');
  }
}

const noSessions = { links: async (): Promise<WorkSessionLink[]> => [] };

interface Core {
  api: LocalApi;
  source: DemoSource;
  now: Clock;
  choose(project: boolean): void;
  close(): Promise<void>;
}

/** #465 the core's real server with GET /api/work over the demo Project; `work: false` is --no-github, `connected: false` is no GitHub credential. */
async function boot({ work = true, connected = true }: { work?: boolean; connected?: boolean } = {}): Promise<Core> {
  const storage: SqliteStorage = openSqliteStorage({ path: ':memory:' });
  const now = clock(NOW);
  const source = new DemoSource();
  const kanban = new GithubProject({ source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), project: SIMULATOR_PROJECT, now });
  let chosen = true;
  const service = new WorkBoardService({
    project: selectedProjectBoard({ kanban: () => (chosen ? kanban : null) }),
    sessions: noSessions,
    queue: EMPTY_WORK_QUEUE,
    history: new SqliteWorkColumnHistory(storage.db),
    now,
  });
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder: new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null }),
    hooks: { storage },
    port: 0,
    log: () => {},
    ...(work ? { work: { service } } : {}),
    ...(connected ? {} : { githubConnected: async () => false }),
  });
  return {
    api,
    source,
    now,
    choose: (project) => void (chosen = project),
    async close() {
      await api.close();
      await storage.close();
    },
  };
}

type Reader = (route: string) => Promise<unknown>;

interface Screen {
  area: ElementoFalso;
  reads: string[];
  navigated: string[];
  change(c: unknown[]): void;
  restart(): void;
  leave(): void;
  text(): string;
  columns(): string[];
  numbers(): number[];
  button(label: string): ElementoFalso;
  refresh(): ElementoFalso;
}

const mounted: Screen[] = [];
afterEach(() => mounted.splice(0).forEach((s) => s.leave()));

/** #465 mounts /ui/work at `path`; `read` wraps the HTTP reader (to hold an answer or count reads). */
async function open(core: Core, path = '/ui/work', read?: (route: string, http: Reader) => Promise<unknown>): Promise<Screen> {
  go(path);
  pushed.length = 0;
  replaced.length = 0;
  copied.length = 0;
  const http: Reader = httpReader({ base: core.api.url, fetch: ownerFetch });
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const navigated: string[] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const restarts: (() => void)[] = [];
  const leave = new AbortController();
  const ctx = {
    params: {},
    signal: leave.signal,
    read: (route: string) => (reads.push(route), read ? read(route, http) : http(route)),
    write: () => Promise.reject(new Error('the work board writes nothing')),
    onChange: (f: (c: unknown[]) => void) => changes.push(f),
    onRestart: (f: () => void) => restarts.push(f),
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (route: string) => navigated.push(route),
  };
  const cleanup = await mount(area, ctx);
  const button = (label: string) => {
    const hit = area.querySelectorAll('button').find((b) => texto(b) === label || b.getAttribute('aria-label') === label);
    assert.ok(hit, `button "${label}" is on screen`);
    return hit;
  };
  const screen: Screen = {
    area,
    reads,
    navigated,
    change: (c) => changes.forEach((f) => f(c)),
    restart: () => restarts.forEach((f) => f()),
    leave: () => (leave.abort(), typeof cleanup === 'function' && cleanup()),
    text: () => texto(area),
    columns: () => area.querySelectorAll('section.wb-col').map((c) => c.getAttribute('data-column')!),
    numbers: () => area.querySelectorAll('article.wb-card').map((c) => Number(texto(c.querySelector('.wb-number')).slice(1))),
    button,
    refresh: () => button('Atualizar'),
  };
  mounted.push(screen);
  return screen;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await tick(5);
  }
}

/** #465 an answer held until `release()`. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
}

/** #465 the cards of GET /api/work itself, to compare with what the screen draws. */
async function apiNumbers(core: Core, query = '') {
  const view = (await (await ownerFetch(`${core.api.url}/api/work${query}`)).json()) as { columns: { id: string; cards: { number: number }[] }[] };
  return view.columns.flatMap((c) => c.cards.map((card) => card.number));
}

const showing = (s: Screen, expected: number[]) => JSON.stringify(s.numbers()) === JSON.stringify(expected);

function choose(area: ElementoFalso, param: string, value: string) {
  const select = area.querySelector(`select[data-param="${param}"]`);
  assert.ok(select, `the ${param} select is on screen`);
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

let core: Core;
before(async () => {
  core = await boot();
});
after(async () => {
  await core.close();
});
afterEach(() => {
  core.source.fail = null;
  core.choose(true);
});

describe('#465/AC-2 the six columns over GET /api/work', () => {
  test('#465/AC-2 /ui/work renders the six lifecycle columns, in order, with the demo cards of GET /api/work', async () => {
    const s = await open(core);
    assert.deepEqual(s.reads, ['/api/work?level=item']);
    assert.deepEqual(s.columns(), WORK_BOARD_COLUMNS.map((c) => c.id));
    assert.deepEqual(
      s.area.querySelectorAll('section.wb-col').map((c) => texto(c.querySelector('.wb-col-name'))),
      ['Planejamento', 'Na fila', 'Em execução', 'Em review', 'Bloqueado', 'Concluído'],
    );
    const expected = await apiNumbers(core, '?level=item');
    assert.ok(expected.length >= 5, 'the demo board has cards');
    assert.deepEqual(s.numbers(), expected);
    assert.match(s.text(), /Quadro do trabalho/);
    assert.match(s.text(), /Kanban de sessões/, 'a demo card title is drawn');
    assert.match(s.text(), /GitHub Project “Ahrena Console”/);
    assert.equal(s.area.querySelector('.wb-board')!.getAttribute('data-mode'), 'cards');
    assert.deepEqual(replaced, ['/ui/work?level=item'], 'the sidebar link is replaced by its canonical slice, not pushed');
    assert.deepEqual(pushed, []);
    // #508 Planejar and Replanejar are drawn now (issue 508); the actions of the other issues still are not.
    assert.doesNotMatch(s.text(), /Executar plano|Pôr na fila|Abrir sessão|Tirar da fila/, 'the actions of other issues are not drawn');
    assert.equal(s.area.querySelectorAll('[draggable="true"]').length, 0, 'no drag');
  });

  test('#465/AC-3 the demo card whose CI failed is in Bloqueado and says why', async () => {
    const s = await open(core);
    const blocked = s.area.querySelector('section[data-column="blocked"]')!;
    assert.match(texto(blocked), /#64/);
    assert.match(texto(blocked), /CI falhou/);
  });

  test('#465/AC-2 while the first read is on the way, the columns are skeletons with "…" and Atualizar is busy', async () => {
    let seen: { mode: string | null; counts: string[]; busy: string | null; filtersOff: boolean; reading: boolean } | null = null;
    const watched = new ElementoFalso('main');
    const http: Reader = httpReader({ base: core.api.url, fetch: ownerFetch });
    const leave = new AbortController();
    go('/ui/work');
    const cleanup = await mount(watched, {
      params: {},
      signal: leave.signal,
      read: (route: string) => {
        seen = {
          mode: watched.querySelector('.wb-board')?.getAttribute('data-mode') ?? null,
          counts: watched.querySelectorAll('.wb-count').map((c) => texto(c)),
          busy: watched.querySelectorAll('button').find((b) => texto(b) === 'Atualizar')?.getAttribute('aria-busy') ?? null,
          filtersOff: watched.querySelectorAll('select.wb-select').every((x) => x.hasAttribute('disabled')),
          reading: /lendo o GitHub…/.test(texto(watched)),
        };
        return http(route);
      },
      write: () => Promise.reject(new Error('no')),
      onChange: () => {},
      onRestart: () => {},
      liveState: () => 'live',
      counter: () => {},
      title: () => {},
      navigate: () => {},
    });
    leave.abort();
    if (typeof cleanup === 'function') cleanup();
    assert.deepEqual(seen, { mode: 'skeleton', counts: ['…', '…', '…', '…', '…', '…'], busy: 'true', filtersOff: true, reading: true });
    assert.match(texto(watched), /lido às/, 'after the read the header says when GitHub was read');
  });
});

describe('#466/AC-3 the filters live in the URL, in English, and combine by AND', () => {
  test('#466/AC-3 opening /ui/work?repo=…&level=item reads GET /api/work with them, rewrites the URL canonically and shows the chip', async () => {
    const repo = SIMULATOR_REPO.split('/')[1]!;
    const s = await open(core, `/ui/work?repo=${repo}&level=item`);
    assert.deepEqual(s.reads, [`/api/work?level=item&repo=${repo}`]);
    assert.deepEqual(replaced, [`/ui/work?level=item&repo=${repo}`], 'the non-canonical link is replaced, not pushed');
    assert.deepEqual(pushed, []);
    const chip = s.area.querySelector('.wb-chip[data-param="repo"]');
    assert.ok(chip, 'the repo chip is on screen');
    assert.equal(texto(chip), `Repositório: ${repo}`);
    assert.equal(s.area.querySelector('select[data-param="repo"]')!.value, SIMULATOR_REPO);
    assert.deepEqual(s.numbers(), await apiNumbers(core, `?level=item&repo=${repo}`));
    assert.equal(texto(s.area.querySelector('.wb-link code')), `/ui/work?level=item&repo=${repo}`);
  });

  test('#466/AC-3 choosing a filter pushes the new URL and reads the API with it; only its cards stay', async () => {
    const s = await open(core);
    const bugs = await apiNumbers(core, '?level=item&type=bug');
    choose(s.area, 'type', 'bug');
    await until(() => showing(s, bugs));
    assert.deepEqual(pushed, ['/ui/work?level=item&type=bug']);
    assert.equal(s.reads[1], '/api/work?level=item&type=bug');
    assert.deepEqual(s.numbers(), [64], 'the demo has one bug');
    assert.equal(texto(s.area.querySelector('.wb-chip[data-param="type"]')), 'Tipo: Bug');
    assert.equal(here.search, '?level=item&type=bug');
  });

  test('#466/AC-3 two filters combine by AND, the chip × takes one out and Limpar filtros takes them all, each pushed', async () => {
    const s = await open(core, '/ui/work?level=item&type=story&status=ready');
    assert.deepEqual(s.numbers().sort(), [35, 36], 'stories in Ready');
    const stories = await apiNumbers(core, '?level=item&type=story');
    assert.ok(stories.length > 2);
    s.area.querySelector('.wb-chip[data-param="status"] .wb-chip-remove')!.click();
    await until(() => showing(s, stories));
    assert.equal(s.area.querySelector('.wb-chip[data-param="status"]'), null);
    assert.deepEqual(pushed, ['/ui/work?level=item&type=story']);
    const all = await apiNumbers(core, '?level=item');
    s.button('Limpar filtros').click();
    await until(() => showing(s, all));
    assert.equal(s.area.querySelector('.wb-chip'), null);
    assert.deepEqual(pushed, ['/ui/work?level=item&type=story', '/ui/work?level=item']);
    assert.deepEqual(s.numbers(), all);
  });

  test('#466/AC-3 the link reopens the same slice: mounting the pushed URL again reads the same filters', async () => {
    const first = await open(core);
    const stories = await apiNumbers(core, '?level=item&type=story');
    choose(first.area, 'type', 'story');
    await until(() => showing(first, stories));
    const link = pushed.at(-1)!;
    const again = await open(core, link);
    assert.deepEqual(again.reads, ['/api/work?level=item&type=story']);
    assert.deepEqual(again.numbers(), stories);
  });

  test('#466/AC-3 Copiar link puts the absolute link of the slice in the clipboard and says so', async () => {
    const s = await open(core, '/ui/work?level=item&type=bug');
    s.button('Copiar link').click();
    await until(() => copied.length === 1);
    assert.deepEqual(copied, [`${here.origin}/ui/work?level=item&type=bug`]);
    await until(() => /Copiado/.test(texto(s.area.querySelector('.wb-link'))));
  });

  test('#466/AC-3 without any filter nor another level there is no link to copy', async () => {
    const s = await open(core);
    assert.equal(s.area.querySelector('.wb-link'), null);
  });
});

describe('#465/AC-4 Atualizar and GitHub down (ADR-0001)', () => {
  test('#465/AC-4 Atualizar sends refresh=1, keeps the board on screen and only Atualizar is busy', async () => {
    const s = await open(core);
    const before = s.numbers();
    const hold = held();
    const gated = await open(core, '/ui/work', async (route, http) => {
      if (route.includes('refresh=1')) await hold.gate;
      return http(route);
    });
    gated.refresh().click();
    await until(() => gated.reads.length === 2);
    assert.equal(gated.reads[1], '/api/work?level=item&refresh=1');
    assert.deepEqual(gated.numbers(), before, 'the board stays');
    assert.equal(gated.area.querySelector('.wb-board')!.getAttribute('data-mode'), 'cards');
    assert.equal(gated.refresh().getAttribute('aria-busy'), 'true');
    assert.ok(gated.refresh().hasAttribute('disabled'));
    assert.ok(gated.area.querySelectorAll('select.wb-select').every((x) => !x.hasAttribute('disabled')), 'the filters stay usable');
    assert.ok(gated.area.querySelectorAll('button.wb-level').every((x) => !x.hasAttribute('disabled')), 'the level switch stays usable');
    assert.deepEqual(pushed, [], 'Atualizar is not a navigation');
    hold.release();
    await until(() => gated.refresh().getAttribute('aria-busy') === null);
    assert.ok(!gated.refresh().hasAttribute('disabled'));
  });

  test('#465/AC-4 GitHub down after a read: the last board stays, faded, with the band that says why and Tentar agora', async () => {
    const s = await open(core);
    const before = s.numbers();
    core.source.fail = new Error('GitHub fora do ar');
    core.now.add(31_000);
    s.refresh().click();
    await until(() => s.area.querySelector('.wb-stale-band') !== null);
    const band = s.area.querySelector('.wb-stale-band')!;
    assert.equal(band.getAttribute('role'), 'status');
    assert.match(texto(band), /GitHub indisponível\./);
    assert.match(texto(band), /Motivo: o GitHub respondeu com erro\./);
    assert.doesNotMatch(texto(band), /github-error|GitHub fora do ar/);
    assert.deepEqual(s.numbers(), before, 'the last data stays');
    assert.ok(s.area.querySelector('.wb-board')!.classList.contains('wb-board-stale'));
    assert.ok(s.area.querySelector('.wb-read-old'), 'the header hour is marked old');
    core.source.fail = null;
    core.now.add(31_000);
    s.button('Tentar agora').click();
    await until(() => s.area.querySelector('.wb-stale-band') === null);
    assert.ok(s.reads.at(-1)!.endsWith('&refresh=1'), 'Tentar agora re-reads GitHub');
  });

  test('#465/AC-4 the first read fails with nothing stored: the reason, Tentar agora and the six columns with "–"', async () => {
    const fresh = await boot();
    try {
      fresh.source.fail = new Error('GitHub fora do ar');
      const s = await open(fresh);
      const alert = s.area.querySelector('.wb-first-failure');
      assert.ok(alert, 'the first-read failure is on screen');
      assert.equal(alert.getAttribute('role'), 'alert');
      assert.match(texto(alert), /Ainda não conseguimos ler o GitHub/);
      assert.match(texto(alert), /\(o GitHub respondeu com erro\)/);
      assert.doesNotMatch(s.text(), /github-error|GitHub fora do ar/);
      assert.deepEqual(s.area.querySelectorAll('.wb-count').map((c) => texto(c)), ['–', '–', '–', '–', '–', '–']);
      assert.doesNotMatch(s.text(), /github-unavailable/);
      fresh.source.fail = null;
      s.button('Tentar agora').click();
      await until(() => s.numbers().length > 0);
      assert.equal(s.reads.at(-1), '/api/work?level=item&refresh=1');
    } finally {
      await fresh.close();
    }
  });
});

describe('#465 the empty project and #466 the slice with no result', () => {
  test('#465 a Project with no issue: the empty state, the link to switch the Project, the filters off and the six columns at zero', async () => {
    const fresh = await boot();
    try {
      fresh.source.empty = true;
      const s = await open(fresh);
      assert.match(s.text(), /Nenhuma issue neste projeto ainda/);
      const links = s.area.querySelectorAll('.wb-empty a').map((a) => a.getAttribute('href'));
      assert.ok(links.includes('/ui/project'), 'Trocar de Project goes to the project kanban');
      assert.ok(s.area.querySelectorAll('select.wb-select').every((x) => x.hasAttribute('disabled')));
      assert.deepEqual(s.columns(), WORK_BOARD_COLUMNS.map((c) => c.id));
      assert.deepEqual(s.area.querySelectorAll('.wb-count').map((c) => texto(c)), ['0', '0', '0', '0', '0', '0']);
    } finally {
      await fresh.close();
    }
  });

  test('#466/AC-3 a label no issue has: the columns stay at zero, the line says how to clear and what dropping the label brings back', async () => {
    const s = await open(core, '/ui/work?level=item&label=nenhuma');
    const box = s.area.querySelector('.wb-no-result');
    assert.ok(box, 'the no-result line is on screen');
    assert.match(texto(box), /Nenhuma issue com estes filtros\./);
    const everything = await apiNumbers(core, '?level=item');
    const total = everything.length;
    assert.match(texto(box), new RegExp(`Sem a label nenhuma, há ${total} issues neste recorte\\.`));
    assert.deepEqual(s.columns(), WORK_BOARD_COLUMNS.map((c) => c.id));
    assert.equal(s.numbers().length, 0);
    s.button('Limpar filtros').click();
    await until(() => showing(s, everything));
    assert.deepEqual(pushed, ['/ui/work?level=item']);
  });

  test('#466/AC-3 while the next read is on the way, the suggestion counted from the previous read is gone', async () => {
    const hold = held();
    const s = await open(core, '/ui/work?level=item&label=nenhuma', async (route, http) => {
      if (!route.includes('label=')) await hold.gate;
      return http(route);
    });
    assert.match(texto(s.area.querySelector('.wb-no-result')), /há \d+ issues/);
    s.button('Tirar a label').click();
    await until(() => s.reads.length === 2);
    assert.doesNotMatch(texto(s.area.querySelector('.wb-no-result')), /há \d+ issues/);
    assert.equal(s.area.querySelectorAll('button').find((b) => texto(b) === 'Tirar a label'), undefined);
    hold.release();
    await until(() => s.area.querySelector('.wb-no-result') === null);
  });
});

describe('#466/AC-2 the levels and #466/AC-4 the chain of parents', () => {
  let core: Core;
  before(async () => {
    core = await boot();
    core.source.epic = true;
  });
  after(async () => {
    await core.close();
  });

  test('#466/AC-2 the level switch reads the other level and pushes it', async () => {
    const s = await open(core);
    assert.deepEqual(
      s.area.querySelectorAll('button.wb-level').map((b) => [b.getAttribute('data-level'), texto(b)]),
      [['initiative', 'Iniciativa'], ['epic', 'Épico/Milestone'], ['item', 'Item'], ['plan', 'Plano de execução']],
    );
    s.area.querySelector('button.wb-level[data-level="epic"]')!.click();
    await until(() => s.reads.length === 2 && s.area.querySelector('.wb-parent-card') !== null);
    assert.deepEqual(pushed, ['/ui/work?level=epic']);
    assert.equal(s.reads[1], '/api/work?level=epic');
    assert.deepEqual(s.numbers(), [EPIC]);
    assert.equal(s.area.querySelector('button.wb-level[data-level="epic"]')!.getAttribute('aria-pressed'), 'true');
  });

  test('#466/AC-2 #466/AC-4 Ver filhos on epic #6 goes to level item with the epic filter, and each child shows the chain', async () => {
    const s = await open(core, '/ui/work?level=epic');
    s.area.querySelector('.wb-drill')!.click();
    await until(() => s.reads.length === 2 && s.area.querySelector('.wb-parent-card') === null && s.numbers().length > 0);
    assert.deepEqual(pushed, [`/ui/work?level=item&epic=${EPIC}`]);
    assert.equal(s.reads[1], `/api/work?level=item&epic=${EPIC}`);
    assert.deepEqual(s.numbers().sort((a, b) => a - b), [42, 64]);
    const chains = s.area.querySelectorAll('.wb-chain').map((c) => texto(c));
    assert.deepEqual(chains.sort(), ['#6 › #42', '#6 › #64'], 'a filter is on: the whole chain');
    assert.match(texto(s.area.querySelector('.wb-path')), /Épico #6/);
    assert.equal(texto(s.area.querySelector('.wb-chip[data-param="epic"]')), 'Épico/Milestone: #6');
  });

  test('#466/AC-2 after Ver filhos the focus lands on the level switch, not on the page', async () => {
    const s = await open(core, '/ui/work?level=epic');
    const drillButton = s.area.querySelector('.wb-drill')!;
    drillButton.focus();
    drillButton.click();
    await until(() => s.area.querySelector('.wb-parent-card') === null && s.numbers().length > 0);
    const focused = documentoFalso.activeElement;
    assert.ok(focused && s.area.contains(focused), 'the focus stays inside the screen');
    assert.equal(focused.getAttribute('data-level'), 'item');
    assert.equal(focused.getAttribute('aria-pressed'), 'true');
  });

  test('#466/AC-4 without a filter the chain is the compact parent', async () => {
    const s = await open(core);
    const chains = s.area.querySelectorAll('.wb-chain').map((c) => texto(c));
    assert.deepEqual(chains, ['↑ #6', '↑ #6']);
  });
});

describe('#465 each error code of GET /api/work in pt-BR', () => {
  const noCode = (s: Screen) => assert.doesNotMatch(s.text(), /bad-filter|no-project|github-not-connected|github-unavailable|\boff\b/, 'no raw code on screen');

  test('#465 bad-filter names the filter of the link and offers to take it out', async () => {
    const s = await open(core, '/ui/work?level=item&type=historia');
    assert.match(s.text(), /Este link tem um filtro inválido\./);
    assert.match(s.text(), /O valor de Tipo não é um que o quadro conhece\./);
    noCode(s);
    s.button('Tirar o filtro Tipo').click();
    await until(() => s.numbers().length > 0);
    assert.deepEqual(pushed, ['/ui/work?level=item']);
  });

  test('#465 bad-filter on the level offers to go back to Item', async () => {
    const s = await open(core, '/ui/work?level=nivel');
    assert.match(s.text(), /O valor de Nível não é um que o quadro conhece\./);
    noCode(s);
    s.button('Voltar ao nível Item').click();
    await until(() => s.numbers().length > 0);
    assert.deepEqual(pushed, ['/ui/work?level=item']);
  });

  test('#465 no-project points to choosing the Project in the project kanban', async () => {
    core.choose(false);
    const s = await open(core);
    assert.match(s.text(), /Nenhum GitHub Project escolhido/);
    const link = s.area.querySelectorAll('a').find((a) => texto(a) === 'Escolher o Project');
    assert.ok(link, 'the link to choose the Project');
    assert.equal(link.getAttribute('href'), '/ui/project');
    assert.equal(s.area.querySelector('.wb-board'), null, 'no board without a Project');
    noCode(s);
  });

  test('#465 off (--no-github) says the core started without GitHub', async () => {
    const off = await boot({ work: false });
    try {
      const s = await open(off);
      assert.match(s.text(), /O núcleo subiu sem GitHub/);
      assert.match(s.text(), /--no-github/);
      assert.equal(s.area.querySelectorAll('button').find((b) => texto(b) === 'Atualizar'), undefined, 'no Atualizar that cannot work');
      noCode(s);
    } finally {
      await off.close();
    }
  });

  test('#465 github-not-connected shows the shared "Conectar ao GitHub" with what the board would do', async () => {
    const offline = await boot({ connected: false });
    try {
      const s = await open(offline);
      const box = s.area.querySelector('.ghc-empty');
      assert.ok(box, 'the C42 empty state');
      assert.equal(texto(box.querySelector('.ghc-what')), CONNECT_TEXT.work);
      box.querySelector('[data-action="connect"]')!.click();
      assert.deepEqual(s.navigated, ['/ui/connections?start=1']);
      noCode(s);
    } finally {
      await offline.close();
    }
  });

  test('#465 a failed Atualizar (no-project) keeps the board with a band that says why', async () => {
    const s = await open(core);
    const before = s.numbers();
    core.choose(false);
    s.refresh().click();
    await until(() => s.area.querySelector('.error-band') !== null);
    const band = s.area.querySelector('.error-band')!;
    assert.equal(band.getAttribute('role'), 'alert');
    assert.match(texto(band), /Não deu para reler o quadro\..*Nenhum GitHub Project escolhido.*Mostrando a última leitura\./);
    assert.deepEqual(s.numbers(), before, 'the board stays');
    noCode(s);
  });

  test('#465 github-unavailable carries its reason in pt-BR; a failed Atualizar with it keeps the board', async () => {
    assert.deepEqual(errorMessage({ error: 'github-unavailable', reason: 'network', status: 502 }), { title: 'O GitHub não respondeu.', text: 'Motivo: falha de rede ao falar com o GitHub.' });
    assert.deepEqual(errorMessage({ error: 'github-unavailable', status: 502 }), { title: 'O GitHub não respondeu.', text: null });
    const s = await open(core, '/ui/work', async (route, http) => {
      if (route.includes('refresh=1')) throw Object.assign(new Error('x'), { name: 'ReadError', status: 502, body: { error: 'github-unavailable', reason: 'network' } });
      return http(route);
    });
    const before = s.numbers();
    s.refresh().click();
    await until(() => s.area.querySelector('.error-band') !== null);
    assert.match(texto(s.area.querySelector('.error-band')), /Não deu para reler o quadro\. O GitHub não respondeu\. Mostrando a última leitura\./);
    assert.deepEqual(s.numbers(), before);
    noCode(s);
  });

  test('#495/AC-2 each reason code reads in pt-BR in the stale strip and the raw code never shows', () => {
    const texts: Record<string, string> = {
      network: 'falha de rede ao falar com o GitHub',
      'rate-limited': 'o GitHub limitou as chamadas',
      'no-scope': 'o token do GitHub não tem a permissão necessária',
      'github-error': 'o GitHub respondeu com erro',
      'sync-pending': 'o sincronismo em segundo plano ainda não releu o quadro',
    };
    assert.deepEqual(Object.keys(GITHUB_DOWN_REASONS), Object.keys(texts));
    for (const [code, text] of Object.entries(texts)) {
      assert.equal(githubDownReason(code), text);
      const strip = texto(staleBand({ fetchedAt: 0, now: 1000, reason: code }));
      assert.ok(strip.includes(`Motivo: ${text}.`), `${code}: ${strip}`);
      assert.ok(!strip.includes(code) || text.includes(code), `${code} must not show raw`);
    }
    assert.doesNotMatch(texto(staleBand({ fetchedAt: 0, now: 1000, reason: null })), /Motivo/);
  });

  test('#495/AC-2 an unknown code, even an inherited name, shows the neutral fallback and not the raw value', () => {
    for (const code of ['proxy-timeout', 'constructor', 'toString']) {
      assert.equal(githubDownReason(code), 'motivo não identificado');
      assert.ok(texto(staleBand({ fetchedAt: 0, now: 1000, reason: code })).includes('Motivo: motivo não identificado.'));
      assert.ok(!texto(firstReadFailure({ reason: code })).includes(code));
    }
    assert.equal(githubDownReason(null), null);
  });

  test('#495/AC-2 errorMessage and the first-read failure say the code in pt-BR', () => {
    assert.deepEqual(errorMessage({ error: 'github-unavailable', reason: 'rate-limited', status: 502 }), { title: 'O GitHub não respondeu.', text: 'Motivo: o GitHub limitou as chamadas.' });
    assert.deepEqual(errorMessage({ error: 'github-unavailable', reason: 'weird', status: 502 }), { title: 'O GitHub não respondeu.', text: 'Motivo: motivo não identificado.' });
    assert.match(texto(firstReadFailure({ reason: 'no-scope' })), /\(o token do GitHub não tem a permissão necessária\)/);
    assert.doesNotMatch(texto(firstReadFailure({ reason: 'no-scope' })), /no-scope/);
  });

  test('#465 any other status says what the core answered, in pt-BR, with Tentar de novo', async () => {
    assert.deepEqual(errorMessage({ error: 'forbidden', status: 403 }), { title: 'Não deu para ler o quadro.', text: 'O núcleo respondeu 403.' });
    const s = await open(core, '/ui/work', async () => {
      throw Object.assign(new Error('forbidden'), { name: 'ReadError', status: 403, body: { error: 'forbidden' } });
    });
    assert.match(s.text(), /Não deu para ler o quadro\. O núcleo respondeu 403\./);
    assert.doesNotMatch(s.text(), /forbidden/);
    s.button('Tentar de novo');
  });

  test('#465 the core not answering says so in pt-BR', async () => {
    const s = await open(core, '/ui/work', async () => {
      throw Object.assign(new Error('O núcleo em 127.0.0.1 não respondeu'), { name: 'ReadError', status: 0, body: null });
    });
    assert.match(s.text(), /Sem conexão com o núcleo\./);
    s.button('Tentar de novo');
  });
});

describe('#465 the screen lives with the core', () => {
  test('#465 a live change re-reads quietly: Atualizar never spins and the board follows', async () => {
    const fresh = await boot();
    try {
      const hold = held();
      let busyDuring: string | null = 'unset';
      let quiet: Screen | null = null;
      quiet = await open(fresh, '/ui/work', async (route, http) => {
        if (quiet && quiet.reads.length > 1) {
          busyDuring = quiet.refresh().getAttribute('aria-busy');
          await hold.gate;
        }
        return http(route);
      });
      fresh.source.titles.set(42, 'Kanban de sessões, renomeado');
      fresh.now.add(2 * 60_000 + 1);
      quiet.change([{ type: 'session' }]);
      await until(() => quiet.reads.length === 2, 3000);
      assert.equal(quiet.reads[1], '/api/work?level=item', 'no refresh=1: the core cache answers');
      assert.equal(busyDuring, null);
      assert.doesNotMatch(quiet.text(), /renomeado/);
      hold.release();
      await until(() => /Kanban de sessões, renomeado/.test(quiet.text()));
    } finally {
      await fresh.close();
    }
  });

  test('#465 a GitHub connection change re-reads the board', async () => {
    const s = await open(core);
    s.change([{ type: 'connections', key: 'github' }]);
    await until(() => s.reads.length === 2);
  });

  test('#465 leaving drops the stylesheet and ignores a late answer', async () => {
    const hold = held();
    const s = await open(core);
    assert.equal(documentoFalso.head.querySelector('link[data-screen="work"]')?.getAttribute('href'), '/ui/work-board.css', 'the stylesheet is linked while the screen is open');
    const late = await open(core, '/ui/work', async (route, http) => {
      if (route.includes('refresh=1')) await hold.gate;
      return http(route);
    });
    late.refresh().click();
    await until(() => late.reads.length === 2);
    const before = late.text();
    s.leave();
    late.leave();
    mounted.length = 0;
    hold.release();
    await tick(50);
    assert.equal(late.text(), before, 'nothing drawn after leaving');
    assert.equal(documentoFalso.head.querySelector('link[data-screen="work"]'), null);
  });
});

describe('#465 the keyboard focus survives the redraws', () => {
  const active = () => documentoFalso.activeElement;

  test('#465 Atualizar keeps the focus: disabled while it reads, focused again when it comes back', async () => {
    const hold = held();
    const s = await open(core, '/ui/work', async (route, http) => {
      if (route.includes('refresh=1')) await hold.gate;
      return http(route);
    });
    s.refresh().focus();
    s.refresh().click();
    await until(() => s.reads.length === 2);
    hold.release();
    await until(() => s.refresh().getAttribute('aria-busy') === null);
    assert.equal(active(), s.refresh(), 'the new Atualizar has the focus');
  });

  test('#465 a click outside the screen during a read keeps its focus: Atualizar does not take it back', async () => {
    const hold = held();
    const s = await open(core, '/ui/work', async (route, http) => {
      if (route.includes('refresh=1')) await hold.gate;
      return http(route);
    });
    s.refresh().focus();
    s.refresh().click();
    await until(() => s.reads.length === 2);
    const outside = new ElementoFalso('button');
    outside.focus();
    hold.release();
    await until(() => s.refresh().getAttribute('aria-busy') === null);
    assert.equal(active(), outside, 'the focus stays where the person put it');
  });

  test('#465 a quiet re-read keeps the focus on the card title that had it', async () => {
    const fresh = await boot();
    try {
      const s = await open(fresh);
      const link = () => s.area.querySelectorAll('article.wb-card').find((c) => /#42/.test(texto(c.querySelector('.wb-number'))))!.querySelector('.wb-card-title button')!;
      link().focus();
      fresh.source.titles.set(42, 'Kanban de sessões, outra vez');
      fresh.now.add(2 * 60_000 + 1);
      s.change([{ type: 'session' }]);
      await until(() => /outra vez/.test(s.text()));
      assert.equal(active(), link(), 'the redrawn title of #42 has the focus');
    } finally {
      await fresh.close();
    }
  });

  test('#465 a filter select keeps the focus after the read it started', async () => {
    const s = await open(core);
    const select = () => s.area.querySelector('select[data-param="type"]')!;
    select().focus();
    choose(s.area, 'type', 'bug');
    await until(() => s.numbers().length === 1);
    assert.equal(active(), select());
  });
});

describe('#465 the screen is registered', () => {
  test('#465 /ui/work is the work board, "Quadro do trabalho", right after the project kanban under Entrega', () => {
    const found = findScreen('/ui/work');
    assert.ok(found, '/ui/work is a screen');
    assert.equal(found.screen.id, 'work');
    assert.equal(found.screen.route, '/ui/work');
    assert.equal(found.screen.title, 'Quadro do trabalho');
    assert.equal(found.screen.file, '/ui/screens/work-board.js');
    assert.deepEqual(found.screen.item, { label: 'Quadro do trabalho', icon: 'columns-3', section: 'delivery' });
    const ids = SCREENS.map((t: { id: string }) => t.id);
    assert.equal(ids.indexOf('work'), ids.indexOf('project') + 1);
    const delivery = sidebarSections().find((b: { id: string }) => b.id === 'delivery');
    assert.deepEqual(delivery.items.map((t: { id: string }) => t.id), ['repos', 'project', 'work', 'dev-console']);
  });

  test('#465/AC-5 the core serves screens/work-board.js as JavaScript', async () => {
    let status = 0;
    let headers: Record<string, string | number> = {};
    const res = {
      writeHead: (s: number, h?: Record<string, string | number>) => ((status = s), (headers = h ?? {}), res),
      end: () => {},
      setHeader: () => {},
    } as unknown as ServerResponse;
    await respondUi(res, '/ui/screens/work-board.js');
    assert.equal(status, 200);
    assert.match(String(headers['content-type']), /^text\/javascript/);
  });
});
