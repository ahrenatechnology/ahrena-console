/*
 * #532 "Executar plano" on the assembled work board (layer 3, the contract). The end-to-end lane of this project is node:test
 * on the fake DOM: /ui/work is mounted for real (the board screen, the issue layer, the run layer and their state), with the
 * real `httpReader` and `httpWriter` of ui/api.js over a stubbed fetch that answers as the core does (GET /api/work,
 * GET /api/work/issue, POST /api/work/run, POST /api/sessions/<uuid>/open: see api/work-run.ts for the answers). The last
 * block is the page-level accessibility check. Each test names the acceptance criterion it covers.
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
const SESSION = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f7a11';
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

const planned = (n: number, over: Obj = {}) => card(n, { plan: { steps: 3 }, ...over });
const issue = (n: number): Obj => ({
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
});

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** #532 The core, stubbed: the board's cards, what POST /api/work/run says and what the session-open route says. */
class Core {
  cards: Obj[] = [planned(506)];
  runAnswers: (() => Response)[] = [];
  runAnswer: () => Response = () => answer(200, { ok: true, opened: 'desktop', key: `${REPO}#506` });
  openAnswer: () => Response | Promise<Response> = () => answer(200, { ok: true, opened: 'desktop' });
  calls: string[] = [];
  runs: Obj[] = [];
  opens: string[] = [];

  board() {
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
      filters: { level: 'item' },
      columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
        const cards = this.cards.filter((c) => c.column === id);
        return { id, label, criterion, count: cards.length, cards };
      }),
    };
  }

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/work' && method === 'GET') return answer(200, this.board());
    if (url.pathname === '/api/work/issue' && method === 'GET') return answer(200, issue(Number(url.searchParams.get('number'))));
    if (url.pathname === '/api/work/run' && method === 'POST') {
      this.runs.push(JSON.parse(String(init.body)));
      return (this.runAnswers.shift() ?? this.runAnswer)();
    }
    const open = /^\/api\/sessions\/([^/]+)\/open$/.exec(url.pathname);
    if (open && method === 'POST') {
      this.opens.push(decodeURIComponent(open[1]!));
      return this.openAnswer();
    }
    return answer(404, { error: 'not-found' });
  };

  get boardReads() {
    return this.calls.filter((c) => c === 'GET /api/work').length;
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
  await until(() => area.querySelectorAll('article.wb-card').length > 0 || area.querySelectorAll('.wb-board').length > 0, 'the board is on screen');
  return screen;
}

const KEY = (n: number) => `${REPO}#${n}`;
const articleOf = (s: Screen, n: number) => {
  const found = s.area.querySelector(`article[data-key="${KEY(n)}"]`);
  assert.ok(found, `card #${n} is on screen`);
  return found;
};
const columnOf = (s: Screen, id: string) => s.area.querySelector(`section[data-column="${id}"]`)!;
const inColumn = (s: Screen, id: string, n: number) => columnOf(s, id).querySelector(`article[data-key="${KEY(n)}"]`) !== null;
const panelOf = (s: Screen) => s.area.querySelector('aside.wb-panel');
const buttonIn = (root: ElementoFalso, action: string) => root.querySelector(`button[data-action="${action}"]`);
const press = (node: ElementoFalso | null, what: string) => {
  assert.ok(node, `${what} is on screen`);
  node.dispatchEvent({ type: 'click' });
};
const popup = (s: Screen) => s.area.querySelector('div.wb-plan-pop');
const notice = (s: Screen) => s.area.querySelector('[data-field="notice"]');
const clickCard = (s: Screen, n: number) => articleOf(s, n).dispatchEvent({ type: 'click' });
async function openPanel(s: Screen, n: number) {
  clickCard(s, n);
  await until(() => panelOf(s) !== null && texto(panelOf(s)).includes(`Abrir a issue ${n} pelo card`), 'the panel shows the issue');
}
const confirmRun = async (s: Screen, core: Core, count = 1) => {
  press(buttonIn(popup(s)!, 'confirm'), 'the confirmation button');
  await until(() => core.runs.length === count, 'the POST goes out');
};

describe('#532/AC-1 Executar plano is on the card and in the panel only for an item with a plan; without one, Planejar', () => {
  test('#532/AC-1 a card with a plan in Planejamento and one in Na fila offer Executar plano; Replanejar stays a link; a card without a plan offers Planejar; an epic nothing', async () => {
    const core = new Core();
    core.cards = [planned(1), card(2), planned(3, { column: 'queued', queuePosition: 1 })];
    const s = await open(core);
    for (const n of [1, 3]) {
      assert.equal(articleOf(s, n).querySelectorAll('button[data-action="run"]').length, 1, `Executar plano on #${n}`);
      assert.match(texto(buttonIn(articleOf(s, n), 'run')!), /Executar plano/);
      assert.equal(articleOf(s, n).querySelectorAll('button[data-action="plan"]').length, 0, `no Planejar on #${n}`);
    }
    const replan = buttonIn(articleOf(s, 1), 'replan');
    assert.ok(replan, 'Replanejar on the planned card');
    assert.match(replan.getAttribute('class') ?? '', /wb-plan-link/, 'Replanejar stays a link');
    assert.equal(articleOf(s, 2).querySelectorAll('button[data-action="run"]').length, 0);
    assert.equal(articleOf(s, 2).querySelectorAll('button[data-action="plan"]').length, 1, 'Planejar without a plan');
  });

  test('#532/AC-1 an epic gets no action', async () => {
    const core = new Core();
    core.cards = [card(6, { level: 'epic', type: 'epic', typeName: 'Epic', children: { total: 2, done: 0, byColumn: { planning: 2 }, blocked: {} } })];
    const s = await open(core, '/ui/work?level=epic');
    assert.equal(s.area.querySelectorAll('button[data-action="run"], button[data-action="plan"]').length, 0);
    assert.ok(!s.text().includes('Executar plano'));
  });

  test('#532/AC-1 the issue panel opened from the card shows Executar plano, with Replanejar a link', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(s, 506);
    const run = buttonIn(panelOf(s)!, 'run');
    assert.ok(run, 'Executar plano in the panel');
    assert.match(texto(run), /Executar plano/);
    assert.match(buttonIn(panelOf(s)!, 'replan')!.getAttribute('class') ?? '', /wb-plan-link/);
    assert.equal(panelOf(s)!.querySelectorAll('button[data-action="plan"]').length, 0);
  });
});

describe('#532/AC-2 confirming posts to POST /api/work/run and the card shows Em execução with subindo…', () => {
  test('#532/AC-2 the whole scenario: Executar plano, the confirmation on the card, confirm, one POST, Em execução with subindo…, the notice, then the core takes over', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    const pop = popup(s)!;
    assert.ok(pop, 'the confirmation opens');
    assert.ok(articleOf(s, 506).parentNode?.querySelector('div.wb-plan-pop') ?? s.area.querySelector('.wb-anchor div.wb-plan-pop'), 'anchored on the card');
    assert.match(texto(pop), /Executar o plano da #506/);
    assert.match(texto(pop), new RegExp(REPO));
    assert.ok(!/Conta/.test(texto(pop)), 'decision 14 of #508: no Conta row');
    assert.equal(core.runs.length, 0, 'nothing is sent before the confirmation');
    await confirmRun(s, core);
    assert.deepEqual(core.runs, [{ repo: REPO, number: 506, target: 'desktop' }]);
    await until(() => inColumn(s, 'running', 506), 'the card moves to Em execução');
    assert.ok(!inColumn(s, 'planning', 506));
    assert.match(texto(articleOf(s, 506)), /subindo…/);
    assert.equal(articleOf(s, 506).querySelectorAll('button[data-action="run"]').length, 0, 'no Executar plano while it boots');
    assert.equal(popup(s), null);
    assert.match(texto(notice(s)!), /Sessão da Athena abrindo no Claude Desktop para a #506/);

    // #532 The next GET /api/work carries the core's own execution: it takes over, and no second POST goes out.
    core.cards = [planned(506, { column: 'running', execution: { state: 'booting' } })];
    s.change();
    await until(() => core.boardReads >= 2, 'the board is read again');
    await tick(1200);
    assert.ok(inColumn(s, 'running', 506));
    assert.match(texto(articleOf(s, 506)), /subindo…/);
    assert.equal(core.runs.length, 1);
    press(notice(s)!.querySelector('button[data-action="close"]'), 'close the notice');
    assert.equal(notice(s), null);
  });

  test('#532/AC-2 the destination chosen is what the POST carries and the notice says where it opened', async () => {
    const core = new Core();
    core.runAnswer = () => answer(200, { ok: true, opened: 'terminal', key: KEY(506) });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    press(popup(s)!.querySelector('button[data-target="terminal"]'), 'Terminal');
    await confirmRun(s, core);
    assert.equal(core.runs[0]!.target, 'terminal');
    await until(() => notice(s) !== null, 'the notice');
    assert.match(texto(notice(s)!), /abrindo no Terminal para a #506/);
  });

  test('#532/AC-2 from the panel the confirmation opens in the panel, and a card in Na fila runs too', async () => {
    const core = new Core();
    core.cards = [planned(506), planned(507, { column: 'queued', queuePosition: 1 })];
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'run'), 'Executar plano in the panel');
    assert.ok(panelOf(s)!.querySelector('div.wb-plan-pop'), 'the confirmation sits in the panel');
    press(buttonIn(popup(s)!, 'cancel'), 'Cancelar');
    assert.equal(popup(s), null);
    press(buttonIn(articleOf(s, 507), 'run'), 'Executar plano in Na fila');
    assert.match(texto(popup(s)!), /Executar o plano da #507/);
    await confirmRun(s, core);
    assert.deepEqual(core.runs[0], { repo: REPO, number: 507, target: 'desktop' });
    await until(() => inColumn(s, 'running', 507), 'the queued card moves to Em execução');
  });
});

describe('#532/AC-3 the limit full keeps the confirmation open with Executar mesmo assim, which sends force: true', () => {
  test('#532/AC-3 409 with a count: the warning, the same confirmation, then force: true', async () => {
    const core = new Core();
    core.runAnswers = [() => answer(409, { error: 'Já há 2 execuções rodando.', running: 2, limit: 2 })];
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => popup(s)?.getAttribute('data-kind') === 'run-full', 'the confirmation with the warning');
    assert.match(texto(popup(s)!.querySelector('[data-field="limit"]')!), /Já há 2 de 2 rodando/);
    assert.match(texto(buttonIn(popup(s)!, 'confirm')!), /Executar mesmo assim/);
    assert.ok(inColumn(s, 'planning', 506), 'the card has not moved');
    await confirmRun(s, core, 2);
    assert.deepEqual(core.runs[1], { repo: REPO, number: 506, target: 'desktop', force: true });
    await until(() => inColumn(s, 'running', 506), 'the card moves after the forced run');
    assert.match(texto(articleOf(s, 506)), /subindo…/);
  });

  test('#532/AC-3 a 409 without a count (a run already booting) is a failure with the core\'s text, not a second chance', async () => {
    const core = new Core();
    core.runAnswer = () => answer(409, { error: 'A execução desta issue já está subindo.' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => articleOf(s, 506).querySelector('.wb-plan-note') !== null, 'the failure note');
    assert.equal(texto(articleOf(s, 506).querySelector('.wb-plan-note')), 'A execução desta issue já está subindo.');
    assert.equal(popup(s), null);
    assert.equal(articleOf(s, 506).querySelectorAll('button[data-action="run"]').length, 1, 'back on Executar plano');
    assert.equal(core.runs.length, 1);
  });
});

describe('#532/AC-4 a missing folder shows the command with Copiar comando and the card stays where it was', () => {
  test('#532/AC-4 501: the core\'s message and command, Copiar comando copies it, Fechar leaves the card as it was', async () => {
    const core = new Core();
    const command = `claude 'Athena, execute o plano de ${REPO}#506'`;
    core.runAnswer = () => answer(501, { error: `O Console não achou ${REPO} em nenhuma pasta deste Mac.`, command });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => popup(s)?.getAttribute('data-kind') === 'folder', 'the missing-folder block');
    const block = popup(s)!;
    assert.match(texto(block), new RegExp(`O Console não achou ${REPO} em nenhuma pasta deste Mac`));
    assert.equal(texto(block.querySelector('pre.wb-plan-cmd')), command);
    press(buttonIn(block, 'copy'), 'Copiar comando');
    await until(() => copied.length === 1, 'the command is copied');
    assert.deepEqual(copied, [command]);
    assert.ok(inColumn(s, 'planning', 506), 'the card stays in Planejamento');
    assert.equal(notice(s), null, 'no notice: nothing opened');
    press(buttonIn(popup(s)!, 'close'), 'Fechar');
    assert.equal(popup(s), null);
    assert.equal(articleOf(s, 506).querySelectorAll('button[data-action="run"]').length, 1, 'the card is as it was');
    assert.equal(articleOf(s, 506).querySelector('.wb-plan-note'), null);
    assert.equal(core.runs.length, 1);
  });
});

describe('#532/AC-5 a card with a live session shows Abrir sessão, which opens it through the existing route', () => {
  const live = (n: number, over: Obj = {}) => card(n, { column: 'running', plan: { steps: 3 }, sessions: { count: 1, state: 'working', ids: [SESSION] }, ...over });

  test('#532/AC-5 Abrir sessão posts to /api/sessions/<uuid>/open with the card\'s session and no Executar plano', async () => {
    const core = new Core();
    core.cards = [live(506)];
    const s = await open(core);
    assert.equal(articleOf(s, 506).querySelectorAll('button[data-action="run"]').length, 0);
    press(buttonIn(articleOf(s, 506), 'open-session'), 'Abrir sessão');
    await until(() => core.opens.length === 1, 'the open route is called');
    assert.deepEqual(core.opens, [SESSION]);
    assert.equal(core.runs.length, 0);
  });

  const statusOf = (root: ElementoFalso) => root.querySelector('.open-status');

  test('#532/AC-5 the panel has Abrir sessão too, and a failed open shows the core\'s text beside the button, not at the top of the board', async () => {
    const core = new Core();
    core.cards = [live(506)];
    core.openAnswer = () => answer(502, { error: 'O Claude Desktop não abriu a sessão.' });
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'open-session'), 'Abrir sessão in the panel');
    await until(() => core.opens.length === 1, 'the open route is called');
    await until(() => /O Claude Desktop não abriu a sessão\./.test(texto(statusOf(panelOf(s)!) ?? panelOf(s)!)), 'the core\'s text is shown in the panel, by the button');
    assert.equal(s.area.querySelector('[data-field="open-failure"]'), null, 'no board-top note');
    assert.equal(s.area.querySelector('.wb-plan-note'), null);
    assert.equal(buttonIn(panelOf(s)!, 'open-session')!.parentNode, statusOf(panelOf(s)!)!.parentNode, 'beside the button');
  });

  test('#532/AC-5 busy: Abrindo… with the button aria-busy, and a second click sends no second POST', async () => {
    const core = new Core();
    core.cards = [live(506)];
    let release: () => void = () => {};
    core.openAnswer = () => new Promise<Response>((r) => (release = () => r(answer(200, { ok: true, opened: 'desktop' }))));
    const s = await open(core);
    const button = buttonIn(articleOf(s, 506), 'open-session')!;
    press(button, 'Abrir sessão');
    await until(() => core.opens.length === 1, 'the first POST');
    await until(() => /Abrindo…/.test(texto(statusOf(articleOf(s, 506)) ?? articleOf(s, 506))), 'Abrindo… beside the button');
    assert.equal(buttonIn(articleOf(s, 506), 'open-session')!.getAttribute('aria-busy'), 'true');
    press(buttonIn(articleOf(s, 506), 'open-session'), 'Abrir sessão again');
    await tick(30);
    assert.equal(core.opens.length, 1, 'one POST only');
    release();
    await until(() => /Aberta no Claude Desktop/.test(texto(articleOf(s, 506))), 'the success text');
    assert.equal(buttonIn(articleOf(s, 506), 'open-session')!.getAttribute('aria-busy'), null);
  });

  test('#532/AC-5 a success says where it opened, by the core\'s opened', async () => {
    const core = new Core();
    core.cards = [live(506)];
    core.openAnswer = () => answer(200, { ok: true, opened: 'terminal' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'open-session'), 'Abrir sessão');
    await until(() => /Aberta no terminal/.test(texto(statusOf(articleOf(s, 506)) ?? articleOf(s, 506))), 'Aberta no terminal beside the button');
  });

  test('#532/AC-5 a failure with a command offers Copiar comando, which copies it', async () => {
    const core = new Core();
    core.cards = [live(506)];
    core.openAnswer = () => answer(409, { error: 'Não deu para abrir o terminal.', command: 'claude --resume 3f2b' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'open-session'), 'Abrir sessão');
    await until(() => /Não deu para abrir o terminal\./.test(texto(articleOf(s, 506))), 'the core\'s text on the card');
    const copy = articleOf(s, 506).querySelector('button.open-copy');
    assert.ok(copy, 'Copiar comando is offered');
    press(copy, 'Copiar comando');
    await until(() => copied.length === 1, 'the command is copied');
    assert.deepEqual(copied, ['claude --resume 3f2b']);
  });

  test('#532/AC-5 a failure without a command has no Copiar comando', async () => {
    const core = new Core();
    core.cards = [live(506)];
    core.openAnswer = () => answer(502, { error: 'O Claude Desktop não abriu a sessão.' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'open-session'), 'Abrir sessão');
    await until(() => /O Claude Desktop não abriu a sessão\./.test(texto(articleOf(s, 506))), 'the core\'s text');
    assert.equal(articleOf(s, 506).querySelector('button.open-copy'), null);
  });
});

describe('#532 one confirmation at a time (465-6, decision 13): opening Planejar/Replanejar or Executar plano closes the other', () => {
  const dialogs = (s: Screen) => s.area.querySelectorAll('div.wb-plan-pop');
  const isRun = (n: ElementoFalso) => /Executar o plano da/.test(n.getAttribute('aria-label') ?? '');

  test('#532 Replanejar open, then Executar plano: only the run confirmation shows and has focus', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'replan'), 'Replanejar');
    assert.equal(dialogs(s).length, 1);
    assert.equal(isRun(dialogs(s)[0]!), false, 'the plan confirmation is open');
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    assert.equal(dialogs(s).length, 1, 'one confirmation');
    assert.ok(isRun(dialogs(s)[0]!), 'it is the run one');
    assert.ok(dialogs(s)[0]!.contains(documentoFalso.activeElement), 'focus is inside it');
  });

  test('#532 Executar plano open, then Replanejar: only the plan confirmation shows and has focus', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    press(buttonIn(articleOf(s, 506), 'replan'), 'Replanejar');
    assert.equal(dialogs(s).length, 1, 'one confirmation');
    assert.equal(isRun(dialogs(s)[0]!), false, 'it is the plan one');
    assert.ok(dialogs(s)[0]!.contains(documentoFalso.activeElement), 'focus is inside it');
  });

  test('#532 across two cards, in both orders', async () => {
    const core = new Core();
    core.cards = [planned(506), planned(507)];
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'replan'), 'Replanejar #506');
    press(buttonIn(articleOf(s, 507), 'run'), 'Executar plano #507');
    assert.equal(dialogs(s).length, 1);
    assert.ok(isRun(dialogs(s)[0]!) && /#507/.test(dialogs(s)[0]!.getAttribute('aria-label') ?? ''));
    assert.ok(dialogs(s)[0]!.contains(documentoFalso.activeElement));
    press(buttonIn(articleOf(s, 506), 'replan'), 'Replanejar #506');
    assert.equal(dialogs(s).length, 1);
    assert.equal(isRun(dialogs(s)[0]!), false);
    assert.ok(/#506/.test(dialogs(s)[0]!.getAttribute('aria-label') ?? ''));
    assert.ok(dialogs(s)[0]!.contains(documentoFalso.activeElement));
  });
});

describe('#532 the run confirmation does not depend on where the last plan confirmation was pressed', () => {
  test('#532 panel open, Replanejar in the panel, Cancelar, then Executar plano on the board card: one run confirmation on the card, and it posts', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'replan'), 'Replanejar in the panel');
    assert.equal(s.area.querySelectorAll('div.wb-plan-pop').length, 1, 'the plan confirmation is open');
    press(buttonIn(popup(s)!, 'cancel'), 'Cancelar');
    assert.equal(popup(s), null);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano on the board card');
    assert.equal(s.area.querySelectorAll('div.wb-plan-pop').length, 1, 'one run confirmation is drawn');
    assert.match(popup(s)!.getAttribute('aria-label') ?? '', /Executar o plano da/);
    await confirmRun(s, core);
    assert.deepEqual(core.runs, [{ repo: REPO, number: 506, target: 'desktop' }]);
  });

  test('#532 panel open, Replanejar in the panel, Cancelar, then Executar plano in the panel: one run confirmation inside the panel, and it posts', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'replan'), 'Replanejar in the panel');
    assert.equal(s.area.querySelectorAll('div.wb-plan-pop').length, 1, 'the plan confirmation is open');
    press(buttonIn(popup(s)!, 'cancel'), 'Cancelar');
    assert.equal(popup(s), null);
    press(buttonIn(panelOf(s)!, 'run'), 'Executar plano in the panel');
    assert.equal(s.area.querySelectorAll('div.wb-plan-pop').length, 1, 'one run confirmation is drawn');
    assert.ok(panelOf(s)!.contains(popup(s)!), 'it is inside the panel');
    assert.match(popup(s)!.getAttribute('aria-label') ?? '', /Executar o plano da/);
    await confirmRun(s, core);
    assert.deepEqual(core.runs, [{ repo: REPO, number: 506, target: 'desktop' }]);
  });
});

describe('#532 other failures:the core\'s error text and the card back on its action', () => {
  for (const [status, error] of [
    [422, 'A issue não tem plano.'],
    [502, 'O GitHub não respondeu.'],
    [503, 'Executar plano não está disponível neste núcleo.'],
  ] as const) {
    test(`#532/AC-2 a ${status} shows the core's error in the card's red note and the card stays on Executar plano`, async () => {
      const core = new Core();
      core.runAnswer = () => answer(status, { error });
      const s = await open(core);
      press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
      await confirmRun(s, core);
      await until(() => articleOf(s, 506).querySelector('.wb-plan-note') !== null, 'the red note');
      assert.equal(texto(articleOf(s, 506).querySelector('.wb-plan-note')), error);
      assert.equal(articleOf(s, 506).querySelectorAll('button[data-action="run"]').length, 1);
      assert.ok(inColumn(s, 'planning', 506));
      assert.equal(core.runs.length, 1, 'one POST, no loop');
      assert.equal(notice(s), null);
    });
  }

  test('#532/AC-2 the core not answering is the failure note too', async () => {
    const core = new Core();
    core.runAnswer = () => {
      throw new TypeError('fetch failed');
    };
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => articleOf(s, 506).querySelector('.wb-plan-note') !== null, 'the red note');
    assert.match(texto(articleOf(s, 506).querySelector('.wb-plan-note')), /não respondeu/);
  });

  test('#532/AC-2 a failed run on a card in Na fila shows the reason and stays in Na fila', async () => {
    const core = new Core();
    core.cards = [planned(507, { column: 'queued', queuePosition: 1 })];
    core.runAnswer = () => answer(502, { error: 'A sessão não subiu.' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 507), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => articleOf(s, 507).querySelector('.wb-plan-note') !== null, 'the red note');
    assert.equal(texto(articleOf(s, 507).querySelector('.wb-plan-note')), 'A sessão não subiu.');
    assert.ok(inColumn(s, 'queued', 507));
  });
});

describe('#532 the page, as a person using it with a keyboard and a screen reader', () => {
  const nameOf = (n: ElementoFalso) => (n.getAttribute('aria-label') ?? texto(n)).trim();

  test('the confirmation is a labelled dialog and focus moves into it; Escape cancels it and focus goes back to Executar plano', async () => {
    const core = new Core();
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    const pop = popup(s)!;
    assert.equal(pop.getAttribute('role'), 'dialog');
    assert.match(pop.getAttribute('aria-label') ?? '', /#506/);
    assert.ok(pop.contains(documentoFalso.activeElement), 'focus moved into the confirmation');
    documentoFalso.activeElement!.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(popup(s), null);
    assert.equal(documentoFalso.activeElement, buttonIn(articleOf(s, 506), 'run'), 'focus is back on Executar plano');
    assert.equal(core.runs.length, 0);
  });

  test('Escape on the confirmation in the panel cancels only it; the panel stays open and focus goes back to Executar plano', async () => {
    const core = new Core();
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'run'), 'Executar plano in the panel');
    assert.ok(popup(s)!.contains(documentoFalso.activeElement), 'focus moved into the confirmation');
    documentoFalso.activeElement!.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(popup(s), null);
    assert.ok(panelOf(s), 'the panel is still open');
    assert.equal(documentoFalso.activeElement, buttonIn(panelOf(s)!, 'run'));
  });

  test('the warning of a full limit and the notice are announced, and the missing-folder block is a labelled dialog', async () => {
    const core = new Core();
    core.runAnswers = [() => answer(409, { error: 'cheio', running: 2, limit: 2 })];
    const s = await open(core);
    press(buttonIn(articleOf(s, 506), 'run'), 'Executar plano');
    await confirmRun(s, core);
    await until(() => popup(s)?.getAttribute('data-kind') === 'run-full', 'the warning');
    assert.equal(popup(s)!.querySelector('[data-field="limit"]')!.getAttribute('role'), 'alert');
    assert.ok(popup(s)!.contains(documentoFalso.activeElement), 'focus stays inside the confirmation');
    await confirmRun(s, core, 2);
    await until(() => notice(s) !== null, 'the notice');
    assert.equal(notice(s)!.getAttribute('role'), 'status');
  });

  test('every button and link of the assembled page has a name, with the panel and the confirmation open', async () => {
    const core = new Core();
    core.cards = [planned(506), card(507), planned(508, { column: 'queued', queuePosition: 1 }), planned(509, { column: 'running', sessions: { count: 1, state: 'working', ids: [SESSION] } })];
    const s = await open(core);
    await openPanel(s, 506);
    press(buttonIn(panelOf(s)!, 'run'), 'Executar plano in the panel');
    const named = [...s.area.querySelectorAll('button'), ...s.area.querySelectorAll('a')];
    assert.ok(named.length > 8);
    for (const n of named) assert.notEqual(nameOf(n), '', `${n.tagName} ${n.getAttribute('class')} has no name`);
    for (const d of s.area.querySelectorAll('[role="dialog"]')) assert.notEqual(d.getAttribute('aria-label') ?? '', '', 'a dialog has a name');
    const ids = s.area.querySelectorAll('[id]').map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
    const radios = popup(s)!.querySelectorAll('[role="radio"]');
    assert.equal(radios.length, 2);
    assert.equal(radios.filter((r) => r.getAttribute('aria-checked') === 'true').length, 1);
    assert.ok(s.area.querySelector('[role="region"][aria-label]'), 'the board is a labelled region');
  });
});
