/*
 * #477 the execution queue on the assembled work board (layer 3: components, state and contract). The end-to-end lane of this
 * project is node:test on the fake DOM: /ui/work is mounted for real (board, issue layer, run layer, queue layer), with the real
 * `httpReader` and `httpWriter` of ui/api.js over a stubbed fetch that answers as the core does (GET /api/work with its `queue`,
 * POST and DELETE /api/work/queue, POST /api/work/queue/order, POST /api/work/queue/retry: see api/work-queue.ts). Each test
 * names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
Object.assign(globalThis, { location: here, history: { state: null, pushState: () => {}, replaceState: () => {} } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });

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
const planned = (n: number, over: Obj = {}) => card(n, { plan: { steps: 3 }, ...over });
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The core, stubbed: the cards, the queue (an ordered list of issue numbers) and what each queue route answers. */
class Core {
  cards: Obj[] = [];
  queued: number[] = [];
  running = 0;
  limit = 2;
  stopped: { key: string; reason: string } | null = null;
  calls: string[] = [];
  bodies: Obj[] = [];
  refuse: { status: number; body: Obj } | null = null;
  refuseOrder: { status: number; body: Obj } | null = null;
  retryAnswer: () => Response = () => answer(200, { ok: true, resumed: true });

  board() {
    const cards = this.cards.map((c) => {
      const at = this.queued.indexOf(c.number);
      return at >= 0 ? { ...c, column: 'queued', queuePosition: at + 1 } : c;
    });
    return {
      project: { title: 'Console', primaryRepo: REPO },
      fetchedAt: NOW,
      stale: false,
      staleReason: null,
      total: cards.length,
      levels: ['initiative', 'epic', 'item', 'plan'],
      options: {},
      queue: { available: true, running: this.running, limit: this.limit, stopped: this.stopped },
      doneWindowDays: 14,
      filters: { level: 'item' },
      columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
        const list = cards.filter((c) => c.column === id);
        return { id, label, criterion, count: list.length, cards: list };
      }),
    };
  }

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/work' && method === 'GET') return answer(200, this.board());
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith('/api/work/queue')) this.bodies.push({ route: `${method} ${url.pathname}`, ...body, headers: init.headers });
    if (url.pathname === '/api/work/queue/retry') return this.retryAnswer();
    if (url.pathname === '/api/work/queue/order' && this.refuseOrder) return answer(this.refuseOrder.status, this.refuseOrder.body);
    if (url.pathname.startsWith('/api/work/queue')) {
      if (this.refuse) return answer(this.refuse.status, this.refuse.body);
      const n = body.number as number;
      this.queued = this.queued.filter((q) => q !== n);
      if (method === 'POST' && url.pathname === '/api/work/queue') this.queued.push(n);
      if (method === 'POST' && url.pathname === '/api/work/queue/order') {
        const after = body.after ? Number(String(body.after).split('#')[1]) : null;
        this.queued.splice(after === null ? 0 : this.queued.indexOf(after) + 1, 0, n);
      }
      return answer(200, { ok: true, key: `${REPO}#${n}`, position: this.queued.indexOf(n) + 1 });
    }
    return answer(404, { error: 'not-found' });
  };
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
  leave(): void;
  text(): string;
}
const mounted: Screen[] = [];
afterEach(() => {
  mounted.splice(0).forEach((s) => s.leave());
  documentoFalso.activeElement = null;
});

async function open(core: Core): Promise<Screen> {
  const reader = httpReader({ base: here.origin, fetch: core.fetch });
  const writer = httpWriter({ base: here.origin, fetch: core.fetch });
  const area = new ElementoFalso('main');
  const leave = new AbortController();
  const ctx = {
    params: {},
    signal: leave.signal,
    read: (route: string, options?: object) => reader(route, { signal: leave.signal, ...options }),
    write: (route: string, body: unknown, options?: object) => writer(route, body, { signal: leave.signal, ...options }),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const cleanup = await mount(area, ctx);
  const screen: Screen = { area, leave: () => (leave.abort(), typeof cleanup === 'function' && cleanup()), text: () => texto(area) };
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
const columnOf = (s: Screen, id: string) => s.area.querySelector(`section[data-column="${id}"]`)!;
const inColumn = (s: Screen, id: string, n: number) => columnOf(s, id).querySelector(`article[data-key="${KEY(n)}"]`) !== null;
const order = (s: Screen) => columnOf(s, 'queued').querySelectorAll('article.wb-card').map((a) => Number(a.getAttribute('data-key')!.split('#')[1]));
const buttonIn = (root: ElementoFalso, action: string) => root.querySelector(`button[data-action="${action}"]`);
const press = (node: ElementoFalso | null, what: string) => {
  assert.ok(node, `${what} is on screen`);
  node.dispatchEvent({ type: 'click' });
};
const transfer = () => ({ effectAllowed: '', dropEffect: '', setData() {} });

async function dragStart(s: Screen, n: number) {
  articleOf(s, n).dispatchEvent({ type: 'dragstart', dataTransfer: transfer() });
  await tick(5);
}
const dragEnd = (s: Screen, n: number) => articleOf(s, n).dispatchEvent({ type: 'dragend' });
function over(s: Screen, column: string, onto?: number) {
  const ev: Obj = { type: 'dragover', dataTransfer: transfer() };
  if (onto) ev.target = articleOf(s, onto);
  columnOf(s, column).dispatchEvent(ev);
  return ev;
}
const drop = (s: Screen, column: string, onto?: number) => columnOf(s, column).dispatchEvent({ type: 'drop', ...(onto ? { target: articleOf(s, onto) } : {}), dataTransfer: transfer() });
const writes = (core: Core) => core.bodies.map((b) => b.route);

describe('#477/AC-2 the limit at the top of Na fila', () => {
  test('#477/AC-2 shows "N de L rodando"; an empty queue says Nenhuma and 0 de 2 rodando', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    const s = await open(core);
    const queued = columnOf(s, 'queued');
    assert.match(texto(queued), /0 de 2 rodando/);
    assert.match(texto(queued), /Nenhuma/);
    assert.equal(queued.querySelector('.wb-limit')!.getAttribute('data-state'), 'free');
  });

  test('#477/AC-2 a full limit is marked, and a limit lowered under the running count reads "3 de 2 rodando"', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    core.running = 3;
    const s = await open(core);
    assert.match(texto(columnOf(s, 'queued').querySelector('.wb-limit')!), /3 de 2 rodando/);
    assert.equal(columnOf(s, 'queued').querySelector('.wb-limit')!.getAttribute('data-state'), 'full');
  });

  test('#477/AC-2 the cards of Na fila carry 1º and 2º, in queue order', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2), planned(3)];
    core.queued = [2, 3];
    const s = await open(core);
    assert.deepEqual(order(s), [2, 3]);
    assert.match(texto(articleOf(s, 2).querySelector('.wb-queue-pos')!), /1º/);
    assert.match(texto(articleOf(s, 3).querySelector('.wb-queue-pos')!), /2º/);
  });
});

describe('#477/AC-2 Pôr na fila and Tirar da fila', () => {
  test('#477/AC-2 Pôr na fila posts the repo, the number and the last target, then the board shows the card in Na fila', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    const s = await open(core);
    press(buttonIn(articleOf(s, 1), 'enqueue'), 'Pôr na fila');
    await until(() => inColumn(s, 'queued', 1), 'the card is in Na fila');
    assert.deepEqual(writes(core), ['POST /api/work/queue']);
    assert.equal(core.bodies[0]!.repo, REPO);
    assert.equal(core.bodies[0]!.number, 1);
    assert.equal(core.bodies[0]!.target, 'desktop');
    assert.ok(buttonIn(articleOf(s, 1), 'dequeue'), 'and offers Tirar da fila');
  });

  test('#477/AC-2 a card without a plan offers no Pôr na fila', async () => {
    const core = new Core();
    core.cards = [card(1)];
    const s = await open(core);
    assert.equal(buttonIn(articleOf(s, 1), 'enqueue'), null);
  });

  test('#477/AC-2 Tirar da fila sends a DELETE with the JSON body and the card goes back to Planejamento', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    core.queued = [1];
    const s = await open(core);
    press(buttonIn(articleOf(s, 1), 'dequeue'), 'Tirar da fila');
    await until(() => inColumn(s, 'planning', 1), 'the card is back in Planejamento');
    assert.deepEqual(writes(core), ['DELETE /api/work/queue']);
    assert.equal(core.bodies[0]!.number, 1);
  });
});

describe('#477/AC-2 dragging between Planejamento and Na fila and inside Na fila', () => {
  test('#477/AC-2 dropping a planned card on Na fila puts it at the end, with the place shown while it hovers', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [2];
    const s = await open(core);
    await dragStart(s, 1);
    const ev = over(s, 'queued');
    assert.equal(ev.defaultPrevented, true, 'Na fila takes the card');
    assert.match(texto(columnOf(s, 'queued')), /Solta aqui · entra em 2º/);
    drop(s, 'queued');
    dragEnd(s, 1);
    await until(() => inColumn(s, 'queued', 1), 'the card is in Na fila');
    assert.deepEqual(writes(core), ['POST /api/work/queue']);
    assert.deepEqual(order(s), [2, 1]);
  });

  test('#477/AC-2 dropping it above a queued card enqueues and then orders it to that place', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [2];
    const s = await open(core);
    await dragStart(s, 1);
    drop(s, 'queued', 2);
    dragEnd(s, 1);
    await until(() => order(s).join() === '1,2', 'the card is first');
    assert.deepEqual(writes(core), ['POST /api/work/queue', 'POST /api/work/queue/order']);
    assert.equal(core.bodies[1]!.after, null);
  });

  test('#477/AC-2 dragging a queued card above the first one reorders it to the top', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2), planned(3)];
    core.queued = [1, 2, 3];
    const s = await open(core);
    await dragStart(s, 3);
    drop(s, 'queued', 1);
    dragEnd(s, 3);
    await until(() => order(s).join() === '3,1,2', 'issue 3 is first');
    assert.deepEqual(writes(core), ['POST /api/work/queue/order']);
    assert.equal(core.bodies[0]!.after, null);
  });

  test('#477/AC-2 dragging a queued card to Planejamento takes it out of the queue', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    core.queued = [1];
    const s = await open(core);
    await dragStart(s, 1);
    drop(s, 'planning');
    dragEnd(s, 1);
    await until(() => inColumn(s, 'planning', 1), 'the card is in Planejamento');
    assert.deepEqual(writes(core), ['DELETE /api/work/queue']);
  });

  test('#477/AC-2 the arrow keys reorder the focused queued card, and stop at the ends', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [1, 2];
    const s = await open(core);
    articleOf(s, 1).dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    await tick(20);
    assert.deepEqual(writes(core), [], 'the first one cannot go up');
    articleOf(s, 2).dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    await until(() => order(s).join() === '2,1', 'issue 2 is first');
    assert.deepEqual(writes(core), ['POST /api/work/queue/order']);
    assert.equal(core.bodies[0]!.after, null);
    await until(() => documentoFalso.activeElement === articleOf(s, 2), 'the focus stays on the moved card');
    articleOf(s, 2).dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    await until(() => order(s).join() === '1,2', 'issue 2 is second again');
    assert.equal(core.bodies[1]!.after, KEY(1));
  });

  test('#477/AC-2 a card that entered the queue but whose place the core refused keeps its note after the board is read again', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [2];
    core.refuseOrder = { status: 409, body: { error: 'A fila mudou.' } };
    const s = await open(core);
    await dragStart(s, 1);
    drop(s, 'queued', 2);
    dragEnd(s, 1);
    await until(() => inColumn(s, 'queued', 1), 'the card is in Na fila');
    await tick(30);
    assert.match(texto(articleOf(s, 1)), /Entrou na fila, mas não deu para mudar a posição: A fila mudou\./);
  });

  test('#477/AC-2 a drag cancelled outside any column draws the board again and leaves no note', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    const s = await open(core);
    await dragStart(s, 1);
    over(s, 'done');
    columnOf(s, 'done').dispatchEvent({ type: 'dragleave' });
    dragEnd(s, 1);
    await tick(10);
    assert.equal(s.area.querySelector('.wb-note, [data-field="queue-note"]'), null);
    assert.deepEqual(writes(core), []);
  });

  test('#477/AC-2 a drop the core refuses leaves the card where it was, with the core\'s text in red', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    core.refuse = { status: 422, body: { code: 'no-plan', error: 'Esta issue ainda não tem plano.' } };
    const s = await open(core);
    await dragStart(s, 1);
    drop(s, 'queued');
    dragEnd(s, 1);
    await until(() => texto(articleOf(s, 1)).includes('Esta issue ainda não tem plano.'), 'the red note is on the card');
    assert.ok(inColumn(s, 'planning', 1));
    assert.equal(articleOf(s, 1).querySelector('[role="alert"]')!.getAttribute('data-field'), 'queue-note');
  });
});

describe('#477/AC-2 #477/AC-5 what the board refuses', () => {
  test('#477/AC-5 while a card is dragged the four fact columns are dimmed with a lock and refuse the drop, with nothing sent', async () => {
    const core = new Core();
    core.cards = [planned(1)];
    const s = await open(core);
    await dragStart(s, 1);
    assert.match(s.area.querySelector('.wb-board')!.getAttribute('class') ?? '', /wb-dragging/);
    for (const id of ['running', 'review', 'blocked', 'done']) {
      const column = columnOf(s, id);
      assert.equal(column.getAttribute('data-fact'), 'true', `${id} is a fact`);
      assert.ok(column.querySelector('.wb-lock'), `${id} has a lock`);
      const ev = over(s, id);
      assert.equal(ev.dataTransfer.dropEffect, 'none', `${id} refuses`);
      assert.match(texto(column), /não recebe card/);
      drop(s, id);
    }
    dragEnd(s, 1);
    await until(() => texto(articleOf(s, 1)).includes('não recebe card'), 'the card says why');
    assert.deepEqual(writes(core), []);
    assert.ok(inColumn(s, 'planning', 1));
  });

  test('#477/AC-2 a card with no plan is refused by Na fila with "Planeje antes", and nothing is sent', async () => {
    const core = new Core();
    core.cards = [card(1)];
    const s = await open(core);
    await dragStart(s, 1);
    over(s, 'queued');
    assert.match(columnOf(s, 'queued').getAttribute('class') ?? '', /wb-refuse/);
    drop(s, 'queued');
    dragEnd(s, 1);
    await until(() => texto(articleOf(s, 1)).includes('Planeje antes'), 'the card says Planeje antes');
    assert.deepEqual(writes(core), []);
  });

  test('#477/AC-2 a card of a repository outside the trusted list is refused with "Planeje antes" and "Fora da lista de confiança"', async () => {
    const core = new Core();
    core.cards = [planned(1, { trusted: false })];
    const s = await open(core);
    assert.equal(buttonIn(articleOf(s, 1), 'enqueue'), null);
    await dragStart(s, 1);
    drop(s, 'queued');
    dragEnd(s, 1);
    await until(() => texto(articleOf(s, 1)).includes('Planeje antes'), 'the refusal is on the card');
    assert.match(texto(articleOf(s, 1)), /Fora da lista de confiança/);
    assert.deepEqual(writes(core), []);
  });

  test('#477/AC-5 a card in Em review is not draggable', async () => {
    const core = new Core();
    core.cards = [planned(1, { column: 'review' })];
    const s = await open(core);
    assert.equal(articleOf(s, 1).getAttribute('draggable'), null);
  });
});

describe('#477/AC-6 a pull that failed stops the queue on screen', () => {
  const stopped = () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [1, 2];
    core.running = 1;
    core.stopped = { key: KEY(1), reason: 'A sessão não subiu: o Claude Desktop não respondeu' };
    return core;
  };

  test('#477/AC-6 the banner says "Fila parada · 1 de 2 rodando", the reason is on the first card, with Tentar de novo and Tirar da fila', async () => {
    const s = await open(stopped());
    const banner = columnOf(s, 'queued').querySelector('.wb-limit')!;
    assert.match(texto(banner), /Fila parada · 1 de 2 rodando/);
    assert.match(texto(banner), /#1/);
    assert.match(texto(articleOf(s, 1)), /A sessão não subiu: o Claude Desktop não respondeu/);
    assert.ok(buttonIn(articleOf(s, 1), 'queue-retry'));
    assert.ok(buttonIn(articleOf(s, 1), 'dequeue'));
    assert.equal(buttonIn(articleOf(s, 1), 'run'), null, 'Executar plano is replaced by Tentar de novo');
    assert.equal(buttonIn(articleOf(s, 2), 'queue-retry'), null);
  });

  test('#477/AC-6 Tentar de novo posts {} to the retry route and reads the board again', async () => {
    const core = stopped();
    const s = await open(core);
    const reads = () => core.calls.filter((c) => c === 'GET /api/work').length;
    const before = reads();
    press(buttonIn(articleOf(s, 1), 'queue-retry'), 'Tentar de novo');
    await until(() => core.bodies.some((b) => b.route === 'POST /api/work/queue/retry') && reads() > before, 'the retry goes out and the board is read again');
    const { route: _route, headers: _headers, ...sent } = core.bodies.find((b) => b.route === 'POST /api/work/queue/retry')!;
    assert.deepEqual(sent, {});
  });

  test('#477/AC-6 a retry the core answers with an error shows its text in red on the card', async () => {
    const core = stopped();
    core.retryAnswer = () => answer(409, { error: 'A fila não está parada.' });
    const s = await open(core);
    press(buttonIn(articleOf(s, 1), 'queue-retry'), 'Tentar de novo');
    await until(() => texto(articleOf(s, 1)).includes('A fila não está parada.'), 'the core text is on the card');
  });
});

describe('#477/AC-7 the page-level accessibility of the queue', () => {
  test('#477/AC-7 the limit is a status, the lock is hidden from readers, each queue button is named, and the position is read aloud', async () => {
    const core = new Core();
    core.cards = [planned(1), planned(2)];
    core.queued = [2];
    const s = await open(core);
    assert.equal(columnOf(s, 'queued').querySelector('.wb-limit')!.getAttribute('role'), 'status');
    assert.equal(columnOf(s, 'running').querySelector('.wb-lock')!.getAttribute('aria-hidden'), 'true');
    assert.equal(buttonIn(articleOf(s, 1), 'enqueue')!.getAttribute('aria-label'), 'Pôr na fila (#1)');
    assert.equal(buttonIn(articleOf(s, 2), 'dequeue')!.getAttribute('aria-label'), 'Tirar da fila (#2)');
    assert.match(texto(articleOf(s, 2)), /1º na fila/);
    assert.equal(articleOf(s, 2).getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
    assert.equal(articleOf(s, 2).getAttribute('tabindex'), '0');
  });
});
