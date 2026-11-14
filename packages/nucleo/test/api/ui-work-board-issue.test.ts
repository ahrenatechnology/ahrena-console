/*
 * #467 #508 the issue panel and Planejar on the assembled work board (layer 4, the contract). The end-to-end
 * lane of this project is node:test on the fake DOM: /ui/work is mounted for real (the board screen, the panel,
 * the plan parts and the state), with the real `httpReader` and `httpWriter` of ui/api.js over a stubbed fetch
 * that answers as the core does (GET /api/work, GET /api/work/issue, POST /api/work/plan: see
 * test/api/work-issue.test.ts and test/api/work-plan.test.ts for the answers). The last block is the
 * page-level accessibility check. Each test names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
const copied: string[] = [];
Object.assign(globalThis, {
  location: here,
  history: { state: null, pushState: () => {}, replaceState: () => {} },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t: string) => void copied.push(t) } } });

// @ts-expect-error: browser module, plain JavaScript
import { httpReader, httpWriter } from '../../ui/api.js';
// @ts-expect-error: idem
import { mount } from '../../ui/screens/work-board.js';

const REPO = 'ahrenatechnology/ahrena-console';
const NOW = Date.now();
type Obj = Record<string, any>;

function card(n: number, over: Obj = {}): Obj {
  return {
    key: `${REPO}#${n}`,
    repo: REPO,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    level: 'item',
    type: 'story',
    typeName: 'User Story',
    state: 'open',
    column: 'planning',
    columnSince: new Date(NOW - 3_600_000).toISOString(),
    parent: null,
    chain: [],
    projectStatus: { id: 'todo', name: 'Todo' },
    labels: [],
    milestone: null,
    plan: null,
    planning: null,
    sessions: { count: 0, state: null, ids: [] },
    pullRequest: null,
    blocked: null,
    queuePosition: null,
    doneAt: null,
    doneBy: null,
    children: null,
    ...over,
  };
}

const steps = (nums: number[]) => nums.map((n) => ({ number: n, title: `Passo ${n}`, url: `https://github.com/${REPO}/issues/${n}`, state: 'OPEN' }));
function issue(n: number, over: Obj = {}): Obj {
  return {
    key: `${REPO}#${n}`,
    repo: REPO,
    type: 'story',
    number: n,
    title: `Abrir a issue ${n} pelo card`,
    state: 'OPEN',
    url: `https://github.com/${REPO}/issues/${n}`,
    labels: [],
    milestone: null,
    projectStatus: 'Todo',
    body: 'O detalhe abre ao lado do quadro.',
    comments: [],
    commentsTotal: 0,
    parents: [],
    subIssues: [],
    plan: { count: 0, steps: [] },
    pullRequest: null,
    fetchedAt: NOW,
    stale: false,
    staleReason: null,
    ...over,
  };
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** #508 The core, stubbed: the board's cards, the issue each number answers and what POST /api/work/plan says. */
class Core {
  cards: Obj[] = [card(508)];
  issues = new Map<number, Obj>([[508, issue(508)]]);
  issueFails: { status: number; body: Obj }[] = [];
  holdIssue: Promise<void> | null = null;
  planAnswer: () => Response = () => answer(200, { ok: true, opened: 'desktop', key: `${REPO}#508` });
  calls: string[] = [];
  posts: Obj[] = [];

  board(level = 'item') {
    return {
      project: { title: 'Console', primaryRepo: REPO },
      fetchedAt: NOW,
      stale: false,
      staleReason: null,
      total: this.cards.length,
      levels: ['initiative', 'epic', 'item', 'plan'],
      options: {},
      queue: { available: true },
      doneWindowDays: 14,
      filters: { level },
      columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
        const cards = this.cards.filter((c) => c.column === id);
        return { id, label, criterion, count: cards.length, cards };
      }),
    };
  }

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/work' && method === 'GET') return answer(200, this.board(url.searchParams.get('level') ?? 'item'));
    if (url.pathname === '/api/work/issue' && method === 'GET') {
      await this.holdIssue;
      const failure = this.issueFails.shift();
      if (failure) return answer(failure.status, failure.body);
      const found = this.issues.get(Number(url.searchParams.get('number')));
      return found ? answer(200, found) : answer(404, { error: 'not-found' });
    }
    if (url.pathname === '/api/work/plan' && method === 'POST') {
      this.posts.push(JSON.parse(String(init.body)));
      return this.planAnswer();
    }
    return answer(404, { error: 'not-found' });
  };

  get gets() {
    return this.calls.filter((c) => c.startsWith('GET /api/work/issue'));
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`did not happen in time: ${what}`);
    await tick(5);
  }
}

interface Screen {
  area: ElementoFalso;
  change(): void;
  leave(): void;
  text(): string;
}
const mounted: Screen[] = [];
afterEach(() => {
  mounted.splice(0).forEach((s) => s.leave());
  documentoFalso.activeElement = null;
  copied.length = 0;
});

async function open(core: Core, path = '/ui/work?level=item'): Promise<Screen> {
  const u = new URL(path, here.origin);
  here.pathname = u.pathname;
  here.search = u.search;
  const reader = httpReader({ base: here.origin, fetch: core.fetch });
  const writer = httpWriter({ base: here.origin, fetch: core.fetch });
  const area = new ElementoFalso('main');
  const changes: (() => void)[] = [];
  const leave = new AbortController();
  const ctx = {
    params: {},
    signal: leave.signal,
    read: (route: string, options?: object) => reader(route, { signal: leave.signal, ...options }),
    write: (route: string, body: unknown, options?: object) => writer(route, body, { signal: leave.signal, ...options }),
    onChange: (f: () => void) => changes.push(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const cleanup = await mount(area, ctx);
  const screen: Screen = {
    area,
    change: () => changes.forEach((f) => f()),
    leave: () => (leave.abort(), typeof cleanup === 'function' && cleanup()),
    text: () => texto(area),
  };
  mounted.push(screen);
  await until(() => area.querySelectorAll('article.wb-card').length > 0, 'the board is on screen');
  return screen;
}

const KEY = (n: number) => `${REPO}#${n}`;
const articleOf = (s: Screen, n: number) => {
  const found = s.area.querySelector(`article[data-key="${KEY(n)}"]`);
  assert.ok(found, `card #${n} is on screen`);
  return found;
};
const panelOf = (s: Screen) => s.area.querySelector('aside.wb-panel');
const buttonIn = (root: ElementoFalso, action: string) => root.querySelector(`button[data-action="${action}"]`);
const press = (node: ElementoFalso | null, what: string) => {
  assert.ok(node, `${what} is on screen`);
  node.dispatchEvent({ type: 'click' });
};
const popup = (s: Screen) => s.area.querySelector('div.wb-plan-pop');
/** #508 The clicks of a person on the card body, outside its buttons and links. */
const clickCard = (s: Screen, n: number) => articleOf(s, n).dispatchEvent({ type: 'click' });

async function openPanel(core: Core, s: Screen, n = 508) {
  clickCard(s, n);
  await until(() => panelOf(s) !== null && texto(panelOf(s)).includes(`Abrir a issue ${n} pelo card`), 'the panel shows the issue');
  void core;
}

describe('#508/AC-1 clicking a card, outside its buttons, opens the issue detail panel', () => {
  test('#508/AC-1 Given a story card, When the card body is clicked, Then GET /api/work/issue is read and the panel opens on the right with the board behind', async () => {
    const core = new Core();
    let release!: () => void;
    core.holdIssue = new Promise<void>((r) => (release = r));
    const s = await open(core);
    assert.equal(panelOf(s), null, 'closed at first');
    clickCard(s, 508);
    await until(() => panelOf(s) !== null, 'the panel appears while the issue loads');
    assert.ok(s.area.querySelector('.wb-panel .loading'), 'a skeleton body while the issue loads');
    assert.ok(s.area.querySelector('.wb-panel-stage .wb-board'), 'the board stays behind');
    assert.ok(s.area.querySelector('.wb-panel-scrim'), 'behind a scrim');
    release();
    await until(() => texto(panelOf(s)).includes('Abrir a issue 508 pelo card'), 'the issue is in the panel');
    assert.deepEqual(core.gets, [`GET /api/work/issue?repo=${encodeURIComponent(REPO)}&number=508`]);
    assert.ok(articleOf(s, 508).hasAttribute('data-selected'), 'the open card is marked');
  });

  test('#508/AC-1 a click on a button of the card does not open the panel', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar on the card');
    await tick(20);
    assert.equal(panelOf(s), null);
    assert.deepEqual(core.gets, []);
    assert.ok(popup(s), 'it opened the confirmation instead');
  });

  test('#508/AC-1 the close button closes the panel and the card is selected no more', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'close'), 'close');
    assert.equal(panelOf(s), null);
    assert.ok(!articleOf(s, 508).hasAttribute('data-selected'));
  });

  test('#508/AC-1 Given the core fails the issue read, Then the panel keeps its header and close, shows the red band with the reason and Tentar de novo reads again', async () => {
    const core = new Core();
    core.issueFails = [{ status: 502, body: { error: 'github-unavailable', reason: 'rate-limited' } }];
    const s = await open(core);
    clickCard(s, 508);
    await until(() => panelOf(s) !== null && s.area.querySelector('.wb-panel .error-band') !== null, 'the failure band');
    const band = texto(s.area.querySelector('.wb-panel .error-band'));
    assert.match(band, /Não deu para abrir a issue/);
    assert.match(band, /limitou/i, 'the reason of the core in pt-BR');
    assert.ok(buttonIn(panelOf(s)!, 'close'), 'close stays');
    assert.match(texto(panelOf(s)), /#508/, 'the header stays');
    press(s.area.querySelectorAll('.wb-panel button').find((b) => texto(b) === 'Tentar de novo') ?? null, 'Tentar de novo');
    await until(() => texto(panelOf(s)).includes('Abrir a issue 508 pelo card'), 'the second read shows the issue');
    assert.equal(core.gets.length, 2);
  });

  test('#508/AC-1 a stale read shows the stale band "Mostrando a issue de HH:MM"', async () => {
    const core = new Core();
    core.issues.set(508, issue(508, { stale: true, staleReason: 'network' }));
    const s = await open(core);
    await openPanel(core, s);
    assert.match(texto(s.area.querySelector('.wb-panel .wb-stale-band')), /Mostrando a issue de \d\d:\d\d/);
  });
});

describe('#508/AC-2 Planejar shows on story, task, bug and spike cards without a plan, and confirming it calls POST /api/work/plan', () => {
  test('#508/AC-2 Planejar is on the card and in the panel; the confirmation has no Pasta or prompt rows; Cancelar closes it', async () => {
    const core = new Core();
    const s = await open(core);
    assert.equal(articleOf(s, 508).querySelectorAll('button[data-action="plan"]').length, 1);
    await openPanel(core, s);
    assert.equal(panelOf(s)!.querySelectorAll('button[data-action="plan"]').length, 1);
    press(buttonIn(panelOf(s)!, 'plan'), 'Planejar in the panel');
    const pop = popup(s);
    assert.ok(pop);
    assert.match(texto(pop), /Planejar a #508 com a Athena/);
    assert.ok(!/Pasta|Athena, só planejamento/.test(texto(pop)), 'decision 3: no Pasta, no prompt');
    press(buttonIn(pop, 'cancel'), 'Cancelar');
    assert.equal(popup(s), null);
    assert.equal(core.posts.length, 0);
  });

  test('#508/AC-2 epic and initiative cards get no Planejar', async () => {
    const core = new Core();
    core.cards = [
      card(6, { level: 'epic', type: 'epic', typeName: 'Epic', children: { total: 2, done: 0, byColumn: { planning: 2 }, blocked: {} } }),
      card(1, { level: 'initiative', type: 'initiative', typeName: 'Initiative', children: { total: 1, done: 0, byColumn: { planning: 1 }, blocked: {} } }),
    ];
    const s = await open(core, '/ui/work?level=epic');
    assert.equal(s.area.querySelectorAll('button[data-action="plan"]').length, 0);
    assert.ok(!s.text().includes('Planejar'));
  });

  test('#508/AC-2 a task, a bug and a spike are offered Planejar; a card outside Planejamento is not', async () => {
    const core = new Core();
    core.cards = [card(1, { type: 'task' }), card(2, { type: 'bug' }), card(3, { type: 'spike' }), card(4, { column: 'running' })];
    const s = await open(core);
    for (const n of [1, 2, 3]) assert.equal(articleOf(s, n).querySelectorAll('button[data-action="plan"]').length, 1, `#${n}`);
    assert.equal(articleOf(s, 4).querySelectorAll('button[data-action="plan"]').length, 0);
  });
});

describe('#508/AC-3 the card says planejando… and then plano · N passos, and the panel lists the steps', () => {
  test('#508/AC-3 the whole scenario: open, Planejar, confirm, POST once, planejando…, plano · 3 passos, steps in the panel, Replanejar secondary', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'plan'), 'Planejar in the panel');
    press(buttonIn(popup(s)!, 'confirm'), 'Planejar in the confirmation');
    await until(() => core.posts.length === 1, 'the POST goes out');
    assert.deepEqual(core.posts, [{ repo: REPO, number: 508, target: 'desktop', replan: false }]);
    await until(() => articleOf(s, 508).querySelector('[data-state="planning"]') !== null, 'the card says planejando…');
    assert.match(texto(articleOf(s, 508)), /planejando…/);
    assert.match(texto(panelOf(s)), /planejando…/, 'decision 5: the panel reuses the card badge');
    assert.equal(s.area.querySelectorAll('button[data-action="plan"]').length, 0, 'no Planejar while it plans');
    assert.equal(popup(s), null);

    // #508 The core now tells the card is planning (the board's own state), then that the plan is out.
    core.cards = [card(508, { planning: { state: 'running' } })];
    s.change();
    await tick(1300);
    assert.match(texto(articleOf(s, 508)), /planejando…/);
    core.cards = [card(508, { plan: { steps: 3 } })];
    core.issues.set(508, issue(508, { plan: { count: 3, steps: steps([601, 602, 603]) }, subIssues: steps([601, 602, 603]) }));
    s.change();
    await until(() => /plano · 3 passos/.test(texto(articleOf(s, 508))), 'the card says plano · 3 passos');
    assert.ok(!/planejando…/.test(texto(articleOf(s, 508))));
    await until(() => panelOf(s)!.querySelectorAll('ol.wb-panel-steps li').length === 3, 'the panel lists the steps');
    assert.equal(core.posts.length, 1, 'the POST went out once: post is an edge, not a level');
    const replan = buttonIn(panelOf(s)!, 'replan');
    assert.ok(replan, 'Replanejar in the panel');
    assert.ok(!/\bfilled\b/.test(replan.getAttribute('class') ?? ''), 'Replanejar is the secondary action');
    assert.equal(s.area.querySelectorAll('button[data-action="plan"]').length, 0, 'the primary Planejar is gone');
  });

  test('#508/AC-3 Replanejar reuses the confirmation and posts replan: true', async () => {
    const core = new Core();
    core.cards = [card(508, { plan: { steps: 2 } })];
    const s = await open(core);
    assert.match(texto(articleOf(s, 508)), /plano · 2 passos/);
    press(buttonIn(articleOf(s, 508), 'replan'), 'Replanejar');
    assert.match(texto(popup(s)), /Replanejar a #508 com a Athena/);
    press(buttonIn(popup(s)!, 'confirm'), 'Replanejar in the confirmation');
    await until(() => core.posts.length === 1, 'the POST');
    assert.deepEqual(core.posts[0], { repo: REPO, number: 508, target: 'desktop', replan: true });
  });

  test('#508/AC-3 the chosen destination is what the POST carries', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar');
    press(popup(s)!.querySelector('button[data-target="terminal"]'), 'Terminal');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => core.posts.length === 1, 'the POST');
    assert.equal(core.posts[0]!.target, 'terminal');
  });

  test('#508/AC-3 a page opened while the core is planning shows planejando… without any click', async () => {
    const core = new Core();
    core.cards = [card(508, { planning: { state: 'running' } })];
    const s = await open(core);
    assert.match(texto(articleOf(s, 508)), /planejando…/);
    assert.equal(s.area.querySelectorAll('button[data-action="plan"]').length, 0);
  });
});

describe('#508/AC-4 a failed planning puts the card back on Planejar with the reason; a missing folder shows the message and Copiar comando', () => {
  test('#508/AC-4 Given the plan ends without steps, Then the card is back on Planejar with the core\'s reason alone', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => /planejando…/.test(texto(articleOf(s, 508))), 'planejando…');
    core.cards = [card(508, { planning: { state: 'failed', reason: 'A sessão de planejamento terminou sem criar o plano.' } })];
    s.change();
    await until(() => articleOf(s, 508).querySelector('.wb-plan-note') !== null, 'the failure note', 5000);
    assert.equal(texto(articleOf(s, 508).querySelector('.wb-plan-note')), 'A sessão de planejamento terminou sem criar o plano.');
    assert.equal(articleOf(s, 508).querySelectorAll('button[data-action="plan"]').length, 1, 'back on Planejar');
    assert.ok(!/planejando…/.test(texto(articleOf(s, 508))));
  });

  test('#508/AC-4 a failed replan keeps the plan: the failure note plus Replanejar (decision 13)', async () => {
    const core = new Core();
    core.cards = [card(508, { plan: { steps: 2 } })];
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'replan'), 'Replanejar');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => /planejando…/.test(texto(articleOf(s, 508))), 'planejando…');
    core.cards = [card(508, { plan: { steps: 2 }, planning: { state: 'failed', reason: 'A sessão terminou antes de o plano sair.' } })];
    s.change();
    await until(() => articleOf(s, 508).querySelector('.wb-plan-note') !== null, 'the failure note', 5000);
    assert.ok(buttonIn(articleOf(s, 508), 'replan'), 'Replanejar stays');
    assert.match(texto(articleOf(s, 508)), /plano · 2 passos/);
  });

  test('#508/AC-4 a POST error other than 501 shows the core\'s error in the card\'s red note and the card stays on Planejar (decision 6)', async () => {
    const core = new Core();
    core.planAnswer = () => answer(409, { error: 'Já há um planejamento desta issue em andamento.' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => articleOf(s, 508).querySelector('.wb-plan-note') !== null, 'the red note');
    assert.equal(texto(articleOf(s, 508).querySelector('.wb-plan-note')), 'Já há um planejamento desta issue em andamento.');
    assert.equal(articleOf(s, 508).querySelectorAll('button[data-action="plan"]').length, 1);
    assert.equal(core.posts.length, 1, 'one POST, no loop');
    assert.ok(!/planejando…/.test(texto(articleOf(s, 508))));
  });

  test('#508/AC-4 a 501 shows the core\'s message and command with Copiar comando; Fechar leaves the card as it was (decisions 9)', async () => {
    const core = new Core();
    const command = `claude 'Athena, só planejamento: leia ${REPO}#508'`;
    core.planAnswer = () => answer(501, { error: `O Console não achou ${REPO} em nenhuma pasta deste Mac.`, command });
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => popup(s)?.getAttribute('data-kind') === 'folder', 'the missing-folder block');
    const block = popup(s)!;
    assert.match(texto(block), new RegExp(`O Console não achou ${REPO} em nenhuma pasta deste Mac`));
    assert.equal(texto(block.querySelector('pre.wb-plan-cmd')), command);
    press(buttonIn(block, 'copy'), 'Copiar comando');
    await until(() => copied.length === 1, 'the command is copied');
    assert.deepEqual(copied, [command]);
    assert.equal(core.posts.length, 1);
    press(buttonIn(popup(s)!, 'close'), 'Fechar');
    assert.equal(popup(s), null);
    assert.equal(articleOf(s, 508).querySelectorAll('button[data-action="plan"]').length, 1, 'the card is as it was');
    assert.equal(articleOf(s, 508).querySelector('.wb-plan-note'), null);
  });

  test('#508/AC-4 the core not answering is the failure note of the card too', async () => {
    const core = new Core();
    core.planAnswer = () => {
      throw new TypeError('fetch failed');
    };
    const s = await open(core);
    press(buttonIn(articleOf(s, 508), 'plan'), 'Planejar');
    press(buttonIn(popup(s)!, 'confirm'), 'confirm');
    await until(() => articleOf(s, 508).querySelector('.wb-plan-note') !== null, 'the red note');
    assert.match(texto(articleOf(s, 508).querySelector('.wb-plan-note')), /não respondeu/);
  });
});

describe('#508 the page, as a person using it with a keyboard and a screen reader', () => {
  const nameOf = (n: ElementoFalso) => (n.getAttribute('aria-label') ?? texto(n)).trim();

  test('the panel is a labelled dialog and focus moves into it', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    const panel = panelOf(s)!;
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.match(panel.getAttribute('aria-label') ?? '', /#508/);
    assert.ok(panel.contains(documentoFalso.activeElement), 'focus is inside the panel');
  });

  test('Escape closes the panel and focus goes back to the card', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    documentoFalso.activeElement!.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(panelOf(s), null);
    assert.equal(documentoFalso.activeElement, articleOf(s, 508), 'focus is back on the card');
  });

  test('the close button returns the focus to the card too', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'close'), 'close');
    assert.equal(documentoFalso.activeElement, articleOf(s, 508));
  });

  test('Escape on the confirmation cancels it and leaves the panel open; focus goes back to Planejar', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'plan'), 'Planejar in the panel');
    assert.ok(popup(s)!.contains(documentoFalso.activeElement), 'focus moved into the confirmation');
    documentoFalso.activeElement!.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(popup(s), null);
    assert.ok(panelOf(s), 'the panel is still open');
    assert.equal(documentoFalso.activeElement, buttonIn(panelOf(s)!, 'plan'));
  });

  test('Enter on the focused card opens the panel', async () => {
    const core = new Core();
    const s = await open(core);
    const article = articleOf(s, 508);
    article.focus();
    article.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await until(() => panelOf(s) !== null, 'the panel');
  });

  test('every button and link of the assembled page has a name, with the panel and the confirmation open', async () => {
    const core = new Core();
    core.cards = [card(508), card(509, { plan: { steps: 2 } })];
    core.issues.set(508, issue(508, { parents: [{ key: KEY(6), repo: REPO, number: 6, title: 'Quadro', url: 'u', state: 'OPEN', type: 'epic' }], ...{ plan: { count: 2, steps: steps([601, 602]) } } }));
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'plan'), 'Planejar in the panel');
    const named = [...s.area.querySelectorAll('button'), ...s.area.querySelectorAll('a')];
    assert.ok(named.length > 8);
    for (const n of named) assert.notEqual(nameOf(n), '', `${n.tagName} ${n.getAttribute('class')} has no name`);
    const radios = s.area.querySelectorAll('[role="radio"]');
    assert.equal(radios.length, 2);
    assert.equal(radios.filter((r) => r.getAttribute('aria-checked') === 'true').length, 1);
  });

  test('landmarks and references: dialogs are labelled, aria-labelledby points at ids that exist once, the scrim is hidden', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(core, s);
    press(buttonIn(panelOf(s)!, 'plan'), 'Planejar in the panel');
    for (const d of s.area.querySelectorAll('[role="dialog"]')) assert.notEqual(d.getAttribute('aria-label') ?? '', '', 'a dialog has a name');
    const ids = s.area.querySelectorAll('[id]').map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
    for (const n of s.area.querySelectorAll('[aria-labelledby]')) assert.ok(ids.includes(n.getAttribute('aria-labelledby')), 'aria-labelledby resolves');
    assert.equal(s.area.querySelector('.wb-panel-scrim')!.getAttribute('aria-hidden'), 'true');
    assert.ok(s.area.querySelector('[role="region"][aria-label]'), 'the board is a labelled region');
    for (const h of s.area.querySelectorAll('h1, h2, h3')) assert.notEqual(texto(h), '', 'no empty heading');
  });

  test('the styles of the panel are loaded with the screen and go away with it', async () => {
    const core = new Core();
    const s = await open(core);
    const sheets = () => documentoFalso.head.querySelectorAll('link').map((l) => l.getAttribute('href'));
    assert.ok(sheets().includes('/ui/work-board-issue-panel.css'));
    s.leave();
    assert.ok(!sheets().includes('/ui/work-board-issue-panel.css'));
  });
});
