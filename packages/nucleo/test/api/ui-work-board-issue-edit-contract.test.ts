/*
 * issue 535 "Editar a issue e o plano" on the assembled work board (layer 4, the contract). The end-to-end lane of this project is
 * node:test on the fake DOM (no Playwright, workbench, visual or axe tool): /ui/work is mounted for real (the board screen, the
 * issue layer, the edit layer and their state), with the real `httpReader` and `httpWriter` of ui/api.js over a stubbed fetch that
 * answers as the core does (api/work-issue-write.ts and api/work-issue-steps.ts: the methods, the bodies, the 409 conflict, the
 * 502 refusals). The last block is the page-level accessibility check, as roles, accessible names and focus over the assembled
 * panel. Each test names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { WORK_BOARD_COLUMNS } from '../../src/github/work-board.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
const copied: string[] = [];
let clipboardFails = false;
Object.assign(globalThis, {
  location: here,
  history: { state: null, pushState: () => {}, replaceState: () => {} },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (t: string) => {
        if (clipboardFails) throw new Error('denied');
        copied.push(t);
      },
    },
  },
});

// @ts-expect-error: browser module, plain JavaScript
import { httpReader, httpWriter } from '../../ui/api.js';
// @ts-expect-error: idem
import { mount } from '../../ui/screens/work-board.js';
// @ts-expect-error: idem
import { WRITE_TIMEOUT_MS } from '../../ui/screens/work-board-issue-edit-layer.js';

const REPO = 'ahrenatechnology/ahrena-console';
const NOW = Date.now();
type Obj = Record<string, any>;
const KEY = (n: number) => `${REPO}#${n}`;

function card(n: number, over: Obj = {}): Obj {
  return {
    key: KEY(n),
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
    milestone: 'M3',
    plan: { steps: 3 },
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

const step = (n: number, over: Obj = {}): Obj => ({ number: n, title: `Passo ${n}`, url: `https://github.com/${REPO}/issues/${n}`, state: 'OPEN', updatedAt: `S${n}`, ...over });
const freshIssue = (n = 506): Obj => ({
  key: KEY(n),
  repo: REPO,
  type: 'User Story',
  number: n,
  title: 'Abrir a issue pelo card',
  state: 'OPEN',
  url: `https://github.com/${REPO}/issues/${n}`,
  updatedAt: 'T1',
  labels: ['ui'],
  milestone: 'M3',
  projectStatus: 'Todo',
  body: 'O detalhe abre ao lado do quadro.',
  comments: [{ author: 'ana-exemplo', body: 'Começar pelo painel.', createdAt: new Date(NOW - 3_600_000).toISOString() }],
  commentsTotal: 1,
  parents: [{ key: KEY(6), repo: REPO, number: 6, title: 'Quadro do trabalho', url: '', state: 'OPEN', type: 'Epic' }],
  subIssues: [],
  plan: { count: 3, steps: [step(520), step(521), step(522)] },
  pullRequest: null,
  fetchedAt: NOW,
  stale: false,
  staleReason: null,
});

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

interface Write {
  method: string;
  path: string;
  body: Obj;
  contentType: string | null;
}

/** issue 535 The core, stubbed: GitHub's issue, and the routes of api/work-issue-write.ts and api/work-issue-steps.ts over it. */
class Core {
  cards: Obj[] = [card(506), card(507, { typeName: 'Bug', type: 'bug', milestone: 'M4', plan: null })];
  gh: Obj = freshIssue();
  removed: Obj[] = [];
  version = 1;
  nextStep = 530;
  reads: string[] = [];
  writes: Write[] = [];
  boardReadCount = 0;
  /** What the next writes answer instead of applying themselves (a queue; an entry may throw, or wait for the abort). */
  scripted: ((init: RequestInit) => Response | Promise<Response>)[] = [];

  board() {
    return {
      project: { title: 'Console', primaryRepo: REPO },
      fetchedAt: NOW,
      stale: false,
      staleReason: null,
      total: this.cards.length,
      levels: ['initiative', 'epic', 'item', 'plan'],
      options: {
        initiatives: [],
        epics: [
          { key: KEY(6), repo: REPO, number: 6, title: 'Quadro do trabalho', count: 1 },
          { key: KEY(7), repo: REPO, number: 7, title: 'Fila', count: 1 },
        ],
        types: [],
        labels: [
          { name: 'ui', count: 2 },
          { name: 'docs', count: 1 },
        ],
        repos: [],
        statuses: [],
      },
      queue: { available: true },
      doneWindowDays: 14,
      filters: { level: 'item' },
      columns: WORK_BOARD_COLUMNS.map(({ id, label, criterion }) => {
        const cards = this.cards.filter((c) => c.column === id);
        return { id, label, criterion, count: cards.length, cards };
      }),
    };
  }

  private bump(): string {
    this.version += 1;
    return `T${this.version}`;
  }
  private sync() {
    this.gh.plan = { count: this.gh.plan.steps.length, steps: this.gh.plan.steps };
  }
  private conflict(current: Obj) {
    return answer(409, { error: 'conflict', title: current.title, body: current.body ?? '', updatedAt: current.updatedAt });
  }

  private apply(method: string, path: string, b: Obj): Response {
    const g = this.gh;
    if (path === '/api/work/issue' && method === 'PATCH') {
      if (('title' in b || 'body' in b) && b.updatedAt !== g.updatedAt) return this.conflict(g);
      for (const k of ['title', 'body', 'labels', 'type', 'milestone'] as const) if (k in b) g[k] = b[k];
      if ('parent' in b) {
        const m = b.parent === null ? null : /^(.+)#(\d+)$/.exec(b.parent);
        g.parents = m ? [{ key: b.parent, repo: m[1], number: Number(m[2]), title: `Pai ${m[2]}`, url: '', state: 'OPEN', type: 'Epic' }] : [];
      }
      g.updatedAt = this.bump();
      return answer(200, clone(g));
    }
    if (path === '/api/work/issue/comments' && method === 'POST') {
      g.comments = [...g.comments, { author: 'voce', body: b.body, createdAt: new Date().toISOString() }];
      g.commentsTotal += 1;
      return answer(200, clone(g));
    }
    const steps: Obj[] = g.plan.steps;
    const find = (key: string) => steps.findIndex((s) => KEY(s.number) === key);
    if (path === '/api/work/issue/steps' && method === 'POST') {
      const n = this.nextStep++;
      steps.push(step(n, { title: b.title }));
    } else if (path === '/api/work/issue/steps' && method === 'PATCH') {
      const i = find(b.step);
      if (i < 0) return answer(422, { error: 'unknown-value', param: 'step' });
      if (b.updatedAt !== steps[i].updatedAt) return this.conflict(steps[i]);
      steps[i] = { ...steps[i], title: b.title, updatedAt: `S${steps[i].number}.${this.version++}` };
    } else if (path === '/api/work/issue/steps' && method === 'DELETE') {
      const i = find(b.step);
      if (i < 0) return answer(422, { error: 'unknown-value', param: 'step' });
      this.removed.push(...steps.splice(i, 1));
    } else if (path === '/api/work/issue/steps/order' && method === 'POST') {
      const i = find(b.step);
      const [moved] = steps.splice(i, 1);
      steps.splice(b.after === null ? 0 : find(b.after) + 1, 0, moved!);
    } else if (path === '/api/work/issue/steps/restore' && method === 'POST') {
      const i = this.removed.findIndex((s) => KEY(s.number) === b.step);
      if (i < 0) return answer(409, { error: 'not-removed' });
      steps.push(...this.removed.splice(i, 1));
    } else return answer(404, { error: 'not-found' });
    this.sync();
    return answer(200, clone(g));
  }

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname === '/api/work' && method === 'GET') {
      this.boardReadCount += 1;
      // the board shows the plan GitHub holds: its card carries the step count of the issue
      const n = this.gh.plan.steps.length;
      return answer(200, { ...this.board(), columns: this.board().columns.map((c) => ({ ...c, cards: c.cards.map((k: Obj) => (k.number === 506 ? { ...k, plan: n > 0 ? { steps: n } : null } : k)) })) });
    }
    if (url.pathname === '/api/work/issue' && method === 'GET') {
      this.reads.push(url.search);
      const n = Number(url.searchParams.get('number'));
      return answer(200, clone({ ...(n === this.gh.number ? this.gh : freshIssue(n)), fetchedAt: Date.now() }));
    }
    if (url.pathname.startsWith('/api/work/issue') && method !== 'GET') {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body ?? 'null'));
      this.writes.push({ method, path: url.pathname, body, contentType: headers?.['content-type'] ?? null });
      const scripted = this.scripted.shift();
      return scripted ? scripted(init) : this.apply(method, url.pathname, body);
    }
    return answer(404, { error: 'not-found' });
  };

  get refreshReads() {
    return this.reads.filter((q) => q.includes('refresh=1')).length;
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
  leave(): void;
  text(): string;
}
const mounted: Screen[] = [];
afterEach(() => {
  mounted.splice(0).forEach((s) => s.leave());
  documentoFalso.activeElement = null;
  copied.length = 0;
  clipboardFails = false;
});

async function open(core: Core): Promise<Screen> {
  here.pathname = '/ui/work';
  here.search = '?level=item';
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

// ---------- reading the screen ----------

const articleOf = (s: Screen, n: number) => {
  const found = s.area.querySelector(`article[data-key="${KEY(n)}"]`);
  assert.ok(found, `card #${n} is on screen`);
  return found;
};
const readPanel = (s: Screen) => s.area.querySelectorAll('aside.wb-panel').find((n) => !n.classList.contains('wb-edit-panel')) ?? null;
const editPanel = (s: Screen) => s.area.querySelector('aside.wb-edit-panel');
const need = (root: ElementoFalso | null, selector: string) => {
  assert.ok(root, `a root for ${selector}`);
  const found = root.querySelector(selector);
  assert.ok(found, `${selector} is on screen`);
  return found;
};
const named = (root: ElementoFalso | null, name: string) => {
  assert.ok(root, `a root for "${name}"`);
  const found = root.querySelectorAll('[aria-label]').find((n) => n.getAttribute('aria-label') === name);
  assert.ok(found, `"${name}" is on screen`);
  return found;
};
const press = (node: ElementoFalso | null, what: string) => {
  assert.ok(node, `${what} is on screen`);
  node.dispatchEvent({ type: 'click' });
};
const typeInto = (node: ElementoFalso, value: string) => {
  node.value = value;
  node.dispatchEvent({ type: 'input' });
};
const choose = (node: ElementoFalso, value: string) => {
  node.value = value;
  node.dispatchEvent({ type: 'change' });
};
const key = (node: ElementoFalso, k: string) => node.dispatchEvent({ type: 'keydown', key: k });

async function openEdit(s: Screen): Promise<ElementoFalso> {
  articleOf(s, 506).dispatchEvent({ type: 'click' });
  await until(() => readPanel(s) !== null && texto(readPanel(s)).includes('Abrir a issue pelo card'), 'the panel shows the issue');
  press(need(readPanel(s), 'button[data-action="edit"]'), 'Editar');
  assert.ok(editPanel(s), 'the edit mode is open');
  return editPanel(s)!;
}
const saved = (s: Screen) => /gravado no GitHub às \d\d:\d\d/.test(texto(editPanel(s)));
const lastWrite = (core: Core) => core.writes.at(-1)!;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// =================================================================================================

describe('issue 535 the writer sends what the issue routes ask: PATCH, and DELETE with a JSON body', () => {
  test('PATCH goes as a JSON write; DELETE carries its body only when asked to; the old rules stay', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const write = httpWriter({ base: here.origin, fetch: async (url: URL, init: RequestInit) => (sent.push({ url: String(url), init }), answer(200, { ok: true })) });
    await write('/api/work/issue', { repo: REPO, number: 1, title: 'x', updatedAt: 'T1' }, { method: 'PATCH' });
    assert.equal(sent[0]!.init.method, 'PATCH');
    assert.equal((sent[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { repo: REPO, number: 1, title: 'x', updatedAt: 'T1' });
    assert.equal(sent[0]!.init.credentials, 'omit');
    await write('/api/work/issue/steps', { repo: REPO, number: 1, step: KEY(2) }, { method: 'DELETE', jsonBody: true });
    assert.equal(sent[1]!.init.method, 'DELETE');
    assert.equal((sent[1]!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(sent[1]!.init.body)), { repo: REPO, number: 1, step: KEY(2) });
    await write('/api/docker/jobs/abcdefabcdef', { machine: 'local' }, { method: 'DELETE' });
    assert.equal(sent[2]!.init.body, undefined, 'a DELETE with no request for a body still goes without one');
    for (const method of ['PUT', 'GET']) await assert.rejects(write('/api/work/issue', {}, { method }), /método de escrita não aceito/);
    await assert.rejects(write('/ui/work', {}, { method: 'PATCH' }), /rota fora da API/);
  });
});

describe('issue 535/AC-1 Editar opens the edit mode and each field is saved through the core, the panel showing GitHub answer', () => {
  test('issue 535/AC-1 Editar in the panel head turns the panel into the edit mode on the title, with nothing sent', async () => {
    const core = new Core();
    const s = await open(core);
    articleOf(s, 506).dispatchEvent({ type: 'click' });
    await until(() => readPanel(s) !== null && texto(readPanel(s)).includes('Abrir a issue pelo card'), 'the panel');
    const editar = need(readPanel(s), 'button[data-action="edit"]');
    assert.match(texto(editar), /Editar/);
    press(editar, 'Editar');
    const panel = editPanel(s)!;
    assert.ok(panel, 'the edit mode');
    assert.equal(readPanel(s), null, 'the read panel is gone');
    assert.equal(named(panel, 'Título da issue').value, 'Abrir a issue pelo card');
    assert.equal(named(panel, 'Descrição da issue (Markdown)').value, 'O detalhe abre ao lado do quadro.');
    assert.equal(documentoFalso.activeElement, named(panel, 'Título da issue'), 'the focus goes to the title');
    assert.equal(core.writes.length, 0);
    assert.ok(!texto(panel).includes('gravado no GitHub'), 'nothing saved yet');
  });

  test('issue 535/AC-1 typing sends nothing; Enter on the title sends PATCH { repo, number, title, updatedAt } trimmed, and the panel shows GitHub answer and the time', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    const title = named(panel, 'Título da issue');
    typeInto(title, '  Abrir a issue pelo card e pelo link  ');
    await tick(30);
    assert.equal(core.writes.length, 0, 'typing writes nothing');
    assert.equal(documentoFalso.activeElement, title, 'typing does not redraw the field away');
    key(title, 'Enter');
    await until(() => core.writes.length === 1, 'the PATCH goes out');
    assert.deepEqual(lastWrite(core), { method: 'PATCH', path: '/api/work/issue', body: { repo: REPO, number: 506, title: 'Abrir a issue pelo card e pelo link', updatedAt: 'T1' }, contentType: 'application/json' });
    await until(() => saved(s), 'gravado no GitHub às');
    assert.equal(named(editPanel(s), 'Título da issue').value, 'Abrir a issue pelo card e pelo link');
    assert.equal(documentoFalso.activeElement, named(editPanel(s), 'Título da issue'), 'the focus stays in the title after the answer');
  });

  test('issue 535/AC-1 a blank or unchanged title writes nothing', async () => {
    const core = new Core();
    const s = await open(core);
    const title = named(await openEdit(s), 'Título da issue');
    typeInto(title, '   ');
    key(title, 'Enter');
    typeInto(title, ' Abrir a issue pelo card ');
    key(title, 'Enter');
    await tick(40);
    assert.equal(core.writes.length, 0);
  });

  test('issue 535/AC-1 Salvar descrição sends PATCH { body, updatedAt }; the textarea shows what GitHub answered, and a second save carries the new version', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'Novo texto\n\ncom dois parágrafos');
    press(need(panel, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => core.writes.length === 1, 'the PATCH');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, body: 'Novo texto\n\ncom dois parágrafos', updatedAt: 'T1' });
    await until(() => saved(s), 'saved');
    typeInto(named(editPanel(s), 'Descrição da issue (Markdown)'), 'Outra');
    press(need(editPanel(s), 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => core.writes.length === 2, 'the second PATCH');
    assert.equal(lastWrite(core).body.updatedAt, 'T2', 'the second save carries the version GitHub answered');
  });

  test('issue 535/AC-1 Pré-visualizar shows the typed text and sends nothing; Cancelar gives the description back as GitHub holds it', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'rascunho **sem gravar**');
    press(panel.querySelectorAll('[role="tab"]').find((t) => texto(t) === 'Pré-visualizar')!, 'Pré-visualizar');
    assert.ok(texto(need(editPanel(s), '.wb-edit-preview')).includes('rascunho **sem gravar**'));
    press(editPanel(s)!.querySelectorAll('[role="tab"]').find((t) => texto(t) === 'Escrever')!, 'Escrever');
    assert.equal(named(editPanel(s), 'Descrição da issue (Markdown)').value, 'rascunho **sem gravar**', 'the typed text survived the tab');
    press(need(editPanel(s), 'button[data-action="cancel-body"]'), 'Cancelar');
    assert.equal(named(editPanel(s), 'Descrição da issue (Markdown)').value, 'O detalhe abre ao lado do quadro.');
    assert.equal(core.writes.length, 0);
  });

  test('issue 535/AC-1 type, milestone and parent save on choose, each alone; the parent as an owner/name#N key and "—" clears', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    assert.deepEqual(
      need(panel, '[data-action="type"]').querySelectorAll('option').map((o) => o.getAttribute('value')),
      ['User Story', 'Bug'],
      'the types the board knows, by their GitHub name',
    );
    choose(need(panel, '[data-action="type"]'), 'Bug');
    await until(() => core.writes.length === 1, 'type');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, type: 'Bug' });
    await until(() => saved(s), 'saved');
    choose(need(editPanel(s), '[data-action="milestone"]'), 'M4');
    await until(() => core.writes.length === 2, 'milestone');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, milestone: 'M4' });
    await until(() => core.gh.milestone === 'M4' && need(editPanel(s), '[data-action="milestone"]').value === 'M4', 'milestone shown');
    choose(need(editPanel(s), '[data-action="parent"]'), KEY(7));
    await until(() => core.writes.length === 3, 'parent');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, parent: KEY(7) });
    await until(() => core.gh.parents[0]?.number === 7, 'parent written');
    await until(() => editPanel(s) !== null && !editPanel(s)!.querySelector('[data-action="parent"]')!.hasAttribute('disabled'), 'parent control free again');
    choose(need(editPanel(s), '[data-action="milestone"]'), '');
    await until(() => core.writes.length === 4, 'clear the milestone');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, milestone: null });
  });

  test('issue 535/AC-1 labels: + label adds to the set, the x on a chip takes it off, the whole set is sent', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    choose(named(panel, 'Adicionar uma label'), 'docs');
    await until(() => core.writes.length === 1, 'add');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, labels: ['ui', 'docs'] });
    await until(() => editPanel(s)!.querySelectorAll('.wb-edit-chip').length === 2, 'the chip appears');
    press(named(editPanel(s), 'Tirar a label ui'), 'the x of ui');
    await until(() => core.writes.length === 2, 'remove');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, labels: ['docs'] });
  });

  test('issue 535/AC-1 a comment is sent to the comments route, the box is emptied and the comment shows with the new count', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    const box = named(panel, 'Escreva um comentário (Markdown)…');
    typeInto(box, 'Fechado pelo painel.');
    press(need(panel, 'button[data-action="comment"]'), 'Comentar');
    await until(() => core.writes.length === 1, 'the POST');
    assert.deepEqual(lastWrite(core), { method: 'POST', path: '/api/work/issue/comments', body: { repo: REPO, number: 506, body: 'Fechado pelo painel.' }, contentType: 'application/json' });
    await until(() => texto(editPanel(s)).includes('Fechado pelo painel.'), 'the comment shows');
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, '');
    assert.ok(texto(need(editPanel(s), '[data-section="comments"]')).includes('Comentários · 2'));
    assert.ok(saved(s));
  });

  test('issue 535/AC-1 Concluir goes back to the read panel, which shows what GitHub holds now, with the focus on Editar', async () => {
    const core = new Core();
    const s = await open(core);
    const title = named(await openEdit(s), 'Título da issue');
    typeInto(title, 'Título novo');
    key(title, 'Enter');
    await until(() => saved(s), 'saved');
    press(need(editPanel(s), 'button[data-action="done"]'), 'Concluir');
    assert.equal(editPanel(s), null);
    assert.ok(readPanel(s));
    assert.equal(texto(need(readPanel(s), 'h2.wb-panel-title')), 'Título novo');
    assert.equal(documentoFalso.activeElement, need(readPanel(s), 'button[data-action="edit"]'));
  });
});

describe('issue 535/AC-2 the plan steps are edited, reordered, added and removed, with Desfazer and the new count on the card', () => {
  test('issue 535/AC-2 the pencil opens the step as a field; Enter sends PATCH { step, updatedAt, title } with the step own version', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    press(named(panel, 'Editar o passo 2: Passo 521'), 'the pencil');
    const input = named(editPanel(s), 'Título do passo 2');
    assert.equal(input.value, 'Passo 521');
    assert.equal(documentoFalso.activeElement, input, 'the focus goes to the field');
    typeInto(input, 'Passo 521 revisto');
    key(input, 'Enter');
    await until(() => core.writes.length === 1, 'the PATCH');
    assert.deepEqual(lastWrite(core), { method: 'PATCH', path: '/api/work/issue/steps', body: { repo: REPO, number: 506, step: KEY(521), updatedAt: 'S521', title: 'Passo 521 revisto' }, contentType: 'application/json' });
    await until(() => texto(editPanel(s)).includes('Passo 521 revisto') && editPanel(s)!.querySelectorAll('input[aria-label="Título do passo 2"]').length === 0, 'the row shows GitHub answer');
  });

  test('issue 535/AC-2 Escape on the step field cancels it with nothing sent and the focus back on its pencil', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    press(named(panel, 'Editar o passo 1: Passo 520'), 'the pencil');
    key(named(editPanel(s), 'Título do passo 1'), 'Escape');
    assert.equal(editPanel(s)!.querySelectorAll('input[aria-label="Título do passo 1"]').length, 0);
    assert.equal(documentoFalso.activeElement, named(editPanel(s), 'Editar o passo 1: Passo 520'));
    assert.equal(core.writes.length, 0);
  });

  test('issue 535/AC-2 a step the core read with no version makes the panel read the issue again first, and writes nothing', async () => {
    const core = new Core();
    core.gh.plan.steps[1].updatedAt = '';
    const s = await open(core);
    const panel = await openEdit(s);
    press(named(panel, 'Editar o passo 2: Passo 521'), 'the pencil');
    await until(() => core.refreshReads === 1, 'the issue is read again with ?refresh=1');
    await tick(30);
    assert.equal(core.writes.length, 0);
  });

  test('issue 535/AC-2 Acrescentar passo opens a field; Salvar sends POST { title }; the plan has 4 steps and the card says plano · 4 passos', async () => {
    const core = new Core();
    const s = await open(core);
    assert.ok(texto(articleOf(s, 506)).includes('plano · 3 passos'));
    const panel = await openEdit(s);
    press(need(panel, 'button[data-action="add-step"]'), 'Acrescentar passo');
    const input = named(editPanel(s), 'Título do novo passo');
    assert.equal(documentoFalso.activeElement, input);
    typeInto(input, 'Passo novo');
    press(need(editPanel(s), 'button[data-action="save-new-step"]'), 'Salvar');
    await until(() => core.writes.length === 1, 'the POST');
    assert.deepEqual(lastWrite(core), { method: 'POST', path: '/api/work/issue/steps', body: { repo: REPO, number: 506, title: 'Passo novo' }, contentType: 'application/json' });
    await until(() => texto(editPanel(s)).includes('Plano · 4 passos'), 'the plan has 4 steps');
    await until(() => texto(articleOf(s, 506)).includes('plano · 4 passos'), 'the card has 4 steps');
  });

  test('issue 535/AC-2 the handle moves a step with the arrow keys: POST steps/order { step, after }, and the new order shows', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    key(named(panel, 'Reordenar o passo 1: Passo 520'), 'ArrowDown');
    await until(() => core.writes.length === 1, 'the POST');
    assert.deepEqual(lastWrite(core), { method: 'POST', path: '/api/work/issue/steps/order', body: { repo: REPO, number: 506, step: KEY(520), after: KEY(521) }, contentType: 'application/json' });
    await until(() => editPanel(s)!.querySelectorAll('ol.wb-edit-steps li[data-number]').map((li) => li.getAttribute('data-number')).join() === '521,520,522', 'the order shows');
    key(named(editPanel(s), 'Reordenar o passo 3: Passo 522'), 'ArrowUp');
    await until(() => core.writes.length === 2, 'the second move');
    assert.equal(lastWrite(core).body.after, KEY(521));
    key(named(editPanel(s), 'Reordenar o passo 1: Passo 521'), 'ArrowUp');
    assert.equal(core.writes.length, 2, 'the first step goes no higher: nothing is sent');
  });

  test('issue 535/AC-2 Remover sends DELETE with the step in a JSON body, the notice offers Desfazer, the card says 2 steps; Desfazer posts steps/restore and the card says 3', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    press(named(panel, 'Remover o passo 2: Passo 521'), 'Remover');
    await until(() => core.writes.length === 1, 'the DELETE');
    assert.deepEqual(lastWrite(core), { method: 'DELETE', path: '/api/work/issue/steps', body: { repo: REPO, number: 506, step: KEY(521) }, contentType: 'application/json' });
    await until(() => texto(editPanel(s)).includes('Plano · 2 passos'), 'the plan has 2 steps');
    const note = need(editPanel(s), '.wb-edit-notice');
    assert.ok(texto(note).includes('Passo 521'));
    await until(() => texto(articleOf(s, 506)).includes('plano · 2 passos'), 'the card has 2 steps');
    press(need(note, 'button[data-action="undo"]'), 'Desfazer');
    await until(() => core.writes.length === 2, 'the restore');
    assert.deepEqual(lastWrite(core), { method: 'POST', path: '/api/work/issue/steps/restore', body: { repo: REPO, number: 506, step: KEY(521) }, contentType: 'application/json' });
    await until(() => texto(editPanel(s)).includes('Plano · 3 passos') && editPanel(s)!.querySelector('.wb-edit-notice') === null, 'the plan is back to 3 steps');
    await until(() => texto(articleOf(s, 506)).includes('plano · 3 passos'), 'the card has 3 steps again');
  });

  test('issue 535/AC-2 removing the last step leaves a card with no plan, and Desfazer on a step that is no longer removed reads the issue again', async () => {
    const core = new Core();
    core.gh.plan.steps = [step(520)];
    core.gh.plan.count = 1;
    const s = await open(core);
    const panel = await openEdit(s);
    press(named(panel, 'Remover o passo 1: Passo 520'), 'Remover');
    await until(() => texto(editPanel(s)).includes('Plano · 0 passos'), 'no steps');
    core.removed = [];
    press(need(editPanel(s), 'button[data-action="undo"]'), 'Desfazer');
    await until(() => core.refreshReads === 1, 'the issue is read again after 409 not-removed');
    assert.equal(editPanel(s)!.querySelector('.wb-edit-notice'), null, 'the notice goes');
    assert.equal(core.writes.length, 2);
  });
});

describe('issue 535/AC-3 a 409 shows both versions and three exits, and writes nothing until the person chooses', () => {
  async function conflicted(core: Core) {
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'A minha versão\nlinha igual');
    core.gh.body = 'A versão do GitHub\nlinha igual';
    core.gh.updatedAt = 'T9';
    press(need(panel, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => editPanel(s)!.querySelector('.wb-edit-conflict') !== null, 'the conflict shows');
    return s;
  }

  test('issue 535/AC-3 both versions with the differing lines marked, the three exits, and the editor gone; nothing was written over', async () => {
    const core = new Core();
    const s = await conflicted(core);
    const view = need(editPanel(s), '.wb-edit-conflict');
    assert.ok(texto(view).includes('A #506 mudou no GitHub enquanto você editava.'));
    const versions = view.querySelectorAll('[role="group"]');
    assert.deepEqual(versions.map((v) => v.getAttribute('aria-label')), ['A sua versão', 'A versão do GitHub']);
    assert.ok(texto(versions[0]!).includes('A minha versão'));
    assert.ok(texto(versions[1]!).includes('A versão do GitHub'));
    assert.equal(versions[0]!.querySelectorAll('mark').length, 1, 'only the differing line is marked');
    assert.deepEqual(view.querySelectorAll('.wb-edit-exits button').map((b) => texto(b)), ['Gravar a minha por cima', 'Ficar com a do GitHub', 'Copiar a minha']);
    assert.equal(editPanel(s)!.querySelectorAll('textarea[aria-label="Descrição da issue (Markdown)"]').length, 0);
    assert.equal(core.writes.length, 1, 'only the save that was refused');
    assert.equal(core.gh.body, 'A versão do GitHub\nlinha igual', 'GitHub still holds its own');
    await tick(60);
    assert.equal(core.writes.length, 1, 'nothing goes out while the person decides');
  });

  test('issue 535/AC-3 Gravar a minha por cima is the one write, carrying GitHub version', async () => {
    const core = new Core();
    const s = await conflicted(core);
    press(need(editPanel(s), 'button[data-action="overwrite"]'), 'Gravar a minha por cima');
    await until(() => core.writes.length === 2, 'the second PATCH');
    assert.deepEqual(lastWrite(core).body, { repo: REPO, number: 506, body: 'A minha versão\nlinha igual', updatedAt: 'T9' });
    await until(() => editPanel(s)!.querySelector('.wb-edit-conflict') === null && saved(s), 'the conflict is gone and saved');
    assert.equal(named(editPanel(s), 'Descrição da issue (Markdown)').value, 'A minha versão\nlinha igual');
    assert.equal(core.gh.body, 'A minha versão\nlinha igual');
  });

  test('issue 535/AC-3 Ficar com a do GitHub writes nothing and the editor takes GitHub text', async () => {
    const core = new Core();
    const s = await conflicted(core);
    press(need(editPanel(s), 'button[data-action="keep-github"]'), 'Ficar com a do GitHub');
    assert.equal(editPanel(s)!.querySelector('.wb-edit-conflict'), null);
    assert.equal(named(editPanel(s), 'Descrição da issue (Markdown)').value, 'A versão do GitHub\nlinha igual');
    await tick(60);
    assert.equal(core.writes.length, 1);
  });

  test('issue 535/AC-3 Copiar a minha puts my version on the clipboard, writes nothing and leaves the conflict open', async () => {
    const core = new Core();
    const s = await conflicted(core);
    press(need(editPanel(s), 'button[data-action="copy-mine"]'), 'Copiar a minha');
    await until(() => copied.length === 1, 'the clipboard');
    assert.deepEqual(copied, ['A minha versão\nlinha igual']);
    assert.ok(editPanel(s)!.querySelector('.wb-edit-conflict'), 'still open');
    assert.equal(core.writes.length, 1);
    assert.match(texto(need(editPanel(s), '[data-action="copy-mine"]')), /Copiado/);
  });

  test('issue 535/AC-3 a conflict on the title is shown as the title versions, and a conflict on a step with that step', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    core.gh.title = 'Título mudado no GitHub';
    core.gh.updatedAt = 'T7';
    const title = named(panel, 'Título da issue');
    typeInto(title, 'O meu título');
    key(title, 'Enter');
    await until(() => editPanel(s)!.querySelector('.wb-edit-conflict') !== null, 'the title conflict');
    const view = need(editPanel(s), '.wb-edit-conflict');
    assert.ok(texto(view).includes('A sua versão do título · não gravada'));
    assert.ok(texto(view).includes('O meu título'));
    assert.ok(texto(view).includes('Título mudado no GitHub'));
    press(need(view, 'button[data-action="keep-github"]'), 'Ficar com a do GitHub');
    assert.equal(named(editPanel(s), 'Título da issue').value, 'Título mudado no GitHub');
    press(named(editPanel(s), 'Editar o passo 3: Passo 522'), 'the pencil');
    core.gh.plan.steps[2].updatedAt = 'S522.new';
    core.gh.plan.steps[2].title = 'Passo 522 no GitHub';
    const input = named(editPanel(s), 'Título do passo 3');
    typeInto(input, 'Passo 522 meu');
    key(input, 'Enter');
    await until(() => editPanel(s)!.querySelector('.wb-edit-conflict') !== null, 'the step conflict');
    assert.ok(texto(need(editPanel(s), '.wb-edit-conflict')).includes('Passo 522 meu'));
    assert.ok(texto(need(editPanel(s), '.wb-edit-conflict')).includes('Passo 522 no GitHub'));
  });

  test('issue 535/AC-3 while a conflict waits no other write goes out and Concluir does not leave', async () => {
    const core = new Core();
    const s = await conflicted(core);
    choose(need(editPanel(s), '[data-action="type"]'), 'Bug');
    press(need(editPanel(s), 'button[data-action="done"]'), 'Concluir');
    await tick(60);
    assert.equal(core.writes.length, 1);
    assert.ok(editPanel(s), 'still in the edit mode');
  });
});

describe('issue 535/AC-4 a refusal keeps the text, the red band says why, with Tentar de novo and Copiar texto', () => {
  const refused = () => answer(502, { error: 'github-refused', reason: 'no-permission' });

  test('issue 535/AC-4 a refused description: the band in the description, the text kept, Tentar de novo sends the same write once more, only on the click', async () => {
    const core = new Core();
    core.scripted = [refused];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'Texto que não passou');
    press(need(panel, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => need(editPanel(s), '[data-section="description"]').querySelector('.wb-edit-refusal') !== null, 'the band');
    const band = need(editPanel(s), '.wb-edit-refusal');
    assert.equal(band.getAttribute('role'), 'alert');
    assert.ok(texto(band).includes('O GitHub recusou a edição.'));
    assert.ok(texto(band).includes('a conta não pode editar esta issue'));
    assert.equal(named(editPanel(s), 'Descrição da issue (Markdown)').value, 'Texto que não passou');
    assert.equal(core.refreshReads, 0, 'a refusal needs no reload');
    await tick(60);
    assert.equal(core.writes.length, 1, 'nothing is retried by itself');
    press(need(editPanel(s), 'button[data-action="retry"]'), 'Tentar de novo');
    await until(() => core.writes.length === 2, 'the retry');
    assert.deepEqual(core.writes[1]!.body, core.writes[0]!.body, 'the same write');
    await until(() => saved(s) && editPanel(s)!.querySelector('.wb-edit-refusal') === null, 'saved, the band gone');
  });

  test('issue 535/AC-4 Copiar texto puts the refused text on the clipboard and says so', async () => {
    const core = new Core();
    core.scripted = [refused];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'Para copiar');
    press(need(panel, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => editPanel(s)!.querySelector('.wb-edit-refusal') !== null, 'the band');
    press(need(editPanel(s), 'button[data-action="copy"]'), 'Copiar texto');
    await until(() => copied.length === 1, 'the clipboard');
    assert.deepEqual(copied, ['Para copiar']);
    assert.match(texto(need(editPanel(s), 'button[data-action="copy"]')), /Copiado/);
    clipboardFails = true;
    press(need(editPanel(s), 'button[data-action="copy"]'), 'Copiar texto');
    await until(() => /Não deu para copiar/.test(texto(need(editPanel(s), 'button[data-action="copy"]'))), 'the failure is said');
  });

  test('issue 535/AC-4 the band stands next to the refused control: the title, the details, the plan and the comment', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    const place = (selector: string) => need(editPanel(s), selector).querySelectorAll('.wb-edit-refusal').length;

    core.scripted = [refused];
    const title = named(panel, 'Título da issue');
    typeInto(title, 'Título recusado');
    key(title, 'Enter');
    await until(() => editPanel(s)!.querySelectorAll('.wb-edit-refusal').length === 1, 'the title band');
    const kids = editPanel(s)!.children;
    assert.ok(kids[kids.findIndex((k) => k.classList.contains('wb-edit-title')) + 1]!.querySelector('.wb-edit-refusal'), 'the band is right under the title');
    assert.equal(named(editPanel(s), 'Título da issue').value, 'Título recusado');

    core.scripted = [() => answer(422, { error: 'unknown-value', param: 'milestone' })];
    choose(need(editPanel(s), '[data-action="milestone"]'), 'M4');
    await until(() => place('[data-section="details"]') === 1, 'the details band');
    assert.ok(texto(need(editPanel(s), '[data-section="details"] .wb-edit-refusal')).includes('O GitHub não conhece o valor escolhido (milestone).'));
    assert.equal(editPanel(s)!.querySelectorAll('.wb-edit-refusal').length, 1, 'one band at a time');

    core.scripted = [refused];
    press(named(editPanel(s), 'Remover o passo 1: Passo 520'), 'Remover');
    await until(() => place('[data-section="plan"]') === 1, 'the plan band');
    assert.equal(editPanel(s)!.querySelector('[data-action="copy"]'), null, 'no text to copy for a removal');
    assert.ok(editPanel(s)!.querySelector('[data-action="retry"]'), 'but it can be tried again');

    core.scripted = [refused];
    typeInto(named(editPanel(s), 'Escreva um comentário (Markdown)…'), 'Comentário recusado');
    press(need(editPanel(s), 'button[data-action="comment"]'), 'Comentar');
    await until(() => place('[data-section="comments"]') === 1, 'the comment band');
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, 'Comentário recusado');
    press(need(editPanel(s), 'button[data-action="copy"]'), 'Copiar texto');
    await until(() => copied.length === 1, 'the clipboard');
    assert.deepEqual(copied, ['Comentário recusado']);
  });

  test('issue 535/AC-4 a refusal for lack of scope says the connection cannot write', async () => {
    const core = new Core();
    core.scripted = [() => answer(502, { error: 'github-refused', reason: 'no-scope' })];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Descrição da issue (Markdown)'), 'x');
    press(need(panel, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => editPanel(s)!.querySelector('.wb-edit-refusal') !== null, 'the band');
    assert.ok(texto(need(editPanel(s), '.wb-edit-refusal')).includes('A conexão do Console não tem permissão para escrever nesta issue.'));
  });
});

describe('issue 535 REL-3 an unknown outcome is never retried by the /ui: it reads the issue again with ?refresh=1', () => {
  test('issue 535 github-unavailable on the comment: the band with no Tentar de novo, one reload with ?refresh=1, and never a second POST', async () => {
    const core = new Core();
    core.scripted = [() => answer(502, { error: 'github-unavailable', reason: 'timeout' })];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Escreva um comentário (Markdown)…'), 'Será que gravou?');
    press(need(panel, 'button[data-action="comment"]'), 'Comentar');
    await until(() => editPanel(s)!.querySelector('[data-section="comments"] .wb-edit-refusal') !== null, 'the band');
    await until(() => core.refreshReads === 1, 'the issue is read again');
    assert.ok(texto(need(editPanel(s), '.wb-edit-refusal')).includes('não sei se a mudança foi gravada'));
    assert.equal(editPanel(s)!.querySelector('[data-action="retry"]'), null, 'a comment is never offered again');
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, 'Será que gravou?', 'the text is kept');
    await tick(120);
    assert.equal(core.writes.length, 1, 'a single POST, ever');
    assert.equal(core.refreshReads, 1, 'a single reload');
  });

  test('issue 535 a rejected fetch on the comment POST is github-unavailable: band, reload, no retry', async () => {
    const core = new Core();
    core.scripted = [
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Escreva um comentário (Markdown)…'), 'Sem rede');
    press(need(panel, 'button[data-action="comment"]'), 'Comentar');
    await until(() => editPanel(s)!.querySelector('[data-section="comments"] .wb-edit-refusal') !== null, 'the band');
    await until(() => core.refreshReads === 1, 'the reload');
    assert.equal(editPanel(s)!.querySelector('[data-action="retry"]'), null);
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, 'Sem rede');
    await tick(120);
    assert.equal(core.writes.length, 1);
  });

  test('issue 535 a rejected fetch on the new-step POST is github-unavailable: band, reload, the text kept, no second POST', async () => {
    const core = new Core();
    core.scripted = [
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    const s = await open(core);
    const panel = await openEdit(s);
    press(need(panel, 'button[data-action="add-step"]'), 'Acrescentar passo');
    typeInto(named(editPanel(s), 'Título do novo passo'), 'Passo sem rede');
    press(need(editPanel(s), 'button[data-action="save-new-step"]'), 'Salvar');
    await until(() => editPanel(s)!.querySelector('[data-section="plan"] .wb-edit-refusal') !== null, 'the band');
    await until(() => core.refreshReads === 1, 'the reload');
    assert.equal(editPanel(s)!.querySelector('[data-action="retry"]'), null, 'a new step is never offered again');
    assert.equal(named(editPanel(s), 'Título do novo passo').value, 'Passo sem rede');
    await tick(120);
    assert.equal(core.writes.length, 1);
  });

  test('issue 535 a timeout on the comment POST is github-unavailable: the request is aborted, band, reload, no retry', async (t) => {
    const core = new Core();
    core.scripted = [(init) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))];
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Escreva um comentário (Markdown)…'), 'Demorou');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    press(need(panel, 'button[data-action="comment"]'), 'Comentar');
    await settle();
    assert.equal(core.writes.length, 1, 'the POST is out and waiting');
    t.mock.timers.tick(WRITE_TIMEOUT_MS + 1);
    await settle();
    t.mock.timers.reset();
    await until(() => editPanel(s)!.querySelector('[data-section="comments"] .wb-edit-refusal') !== null, 'the band');
    await until(() => core.refreshReads === 1, 'the reload');
    assert.equal(editPanel(s)!.querySelector('[data-action="retry"]'), null);
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, 'Demorou');
    await tick(120);
    assert.equal(core.writes.length, 1);
  });

  test('issue 535 a network failure on a title save shows the band and reads the issue again; Tentar de novo is the person own click, never automatic', async () => {
    const core = new Core();
    core.scripted = [
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    const s = await open(core);
    const panel = await openEdit(s);
    const title = named(panel, 'Título da issue');
    typeInto(title, 'Título sem rede');
    key(title, 'Enter');
    await until(() => editPanel(s)!.querySelector('.wb-edit-refusal') !== null, 'the band');
    await until(() => core.refreshReads === 1, 'the reload');
    await tick(120);
    assert.equal(core.writes.length, 1, 'no automatic retry');
    assert.equal(named(editPanel(s), 'Título da issue').value, 'Título sem rede');
    press(need(editPanel(s), 'button[data-action="retry"]'), 'Tentar de novo');
    await until(() => core.writes.length === 2, 'the click sends it once more');
    await until(() => saved(s), 'saved');
  });

  test('issue 535 written-unread on a PATCH: GitHub applied it, so no band and no retry, only the reload', async () => {
    const core = new Core();
    core.scripted = [() => answer(502, { error: 'written-unread', reason: 'timeout' })];
    const s = await open(core);
    const panel = await openEdit(s);
    choose(need(panel, '[data-action="type"]'), 'Bug');
    await until(() => core.refreshReads === 1, 'the reload');
    await tick(60);
    assert.equal(editPanel(s)!.querySelectorAll('.wb-edit-refusal').length, 0);
    assert.equal(core.writes.length, 1);
  });

  test('issue 535 a reload that fails changes nothing and is not repeated', async () => {
    const core = new Core();
    core.scripted = [() => answer(502, { error: 'github-unavailable', reason: 'timeout' })];
    const original = core.fetch;
    core.fetch = async (input: URL | string, init: RequestInit = {}) => {
      if (String(input).includes('refresh=1')) {
        core.reads.push(new URL(String(input)).search);
        return answer(502, { error: 'github-unavailable', reason: 'timeout' });
      }
      return original(input, init);
    };
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Escreva um comentário (Markdown)…'), 'Texto');
    press(need(panel, 'button[data-action="comment"]'), 'Comentar');
    await until(() => core.refreshReads === 1, 'the reload');
    await tick(120);
    assert.equal(core.refreshReads, 1);
    assert.equal(named(editPanel(s), 'Escreva um comentário (Markdown)…').value, 'Texto');
  });
});

describe('issue 535 closing the panel ends the edit; another card does not inherit it', () => {
  test('issue 535 the x of the edit mode closes the panel and forgets the edit; opening the card again is the read panel', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    typeInto(named(panel, 'Título da issue'), 'Não gravado');
    press(need(panel, 'button[data-action="close"]'), 'Fechar');
    assert.equal(editPanel(s), null);
    assert.equal(readPanel(s), null);
    articleOf(s, 506).dispatchEvent({ type: 'click' });
    await until(() => readPanel(s) !== null && texto(readPanel(s)).includes('Abrir a issue pelo card'), 'the read panel');
    assert.equal(editPanel(s), null);
    assert.equal(core.writes.length, 0);
  });

  test('issue 535 opening another card while editing leaves the edit mode', async () => {
    const core = new Core();
    core.gh = freshIssue();
    const s = await open(core);
    await openEdit(s);
    articleOf(s, 507).dispatchEvent({ type: 'click' });
    await until(() => editPanel(s) === null, 'the edit is gone');
    await until(() => readPanel(s) !== null, 'the other panel');
    assert.equal(core.writes.length, 0);
  });
});

describe('issue 535 the page, as a person using it with a keyboard and a screen reader', () => {
  const nameOf = (n: ElementoFalso) => (n.getAttribute('aria-label') ?? texto(n)).trim();

  test('the edit mode is a labelled dialog; every button, field and select of the assembled panel has a name; ids are unique and every reference lands', async () => {
    const core = new Core();
    const s = await open(core);
    const panel = await openEdit(s);
    press(need(panel, 'button[data-action="add-step"]'), 'Acrescentar passo');
    press(named(editPanel(s), 'Editar o passo 1: Passo 520'), 'the pencil');
    const root = editPanel(s)!;
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Edição da issue #506');
    const controls = [...root.querySelectorAll('button'), ...root.querySelectorAll('input'), ...root.querySelectorAll('textarea'), ...root.querySelectorAll('select')];
    assert.ok(controls.length > 20);
    for (const c of controls) assert.notEqual(nameOf(c), '', `${c.tagName} ${c.getAttribute('data-action') ?? c.getAttribute('class')} has no name`);
    const ids = s.area.querySelectorAll('[id]').map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
    for (const n of root.querySelectorAll('[aria-controls]')) assert.ok(ids.includes(n.getAttribute('aria-controls')), 'aria-controls lands');
    for (const n of root.querySelectorAll('[aria-labelledby]')) assert.ok(ids.includes(n.getAttribute('aria-labelledby')), 'aria-labelledby lands');
    for (const sec of root.querySelectorAll('section')) assert.notEqual(sec.getAttribute('aria-label') ?? '', '', 'a section has a name');
    assert.deepEqual(
      root.querySelectorAll('section').map((x) => x.getAttribute('data-section')),
      ['description', 'details', 'plan', 'comments'],
    );
    for (const n of root.querySelectorAll('[tabindex]')) assert.ok(Number(n.getAttribute('tabindex')) <= 0, 'no positive tabindex');
    assert.equal(root.querySelectorAll('h1').length + root.querySelectorAll('h2').length, 0, 'the page keeps its own headings above the panel');
  });

  test('the tabs are a tablist with one selected tab and one tab stop, and the panel is its tabpanel', async () => {
    const core = new Core();
    const s = await open(core);
    const root = await openEdit(s);
    const tabs = root.querySelectorAll('[role="tab"]');
    assert.equal(tabs.length, 2);
    assert.equal(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
    assert.equal(tabs.filter((t) => t.getAttribute('tabindex') === '0').length, 1);
    const panelOfTabs = need(root, '[role="tabpanel"]');
    assert.ok(tabs.some((t) => t.getAttribute('id') === panelOfTabs.getAttribute('aria-labelledby')));
    key(need(root, '[role="tablist"]'), 'ArrowRight');
    assert.equal(editPanel(s)!.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true')!.textContent, 'Pré-visualizar');
  });

  test('a write in flight disables and marks busy only the control that sent it; the answer is announced as a status', async () => {
    const core = new Core();
    let release!: () => void;
    core.scripted = [() => new Promise<Response>((resolve) => (release = () => resolve(answer(200, { ...core.gh, comments: [], commentsTotal: 0, updatedAt: 'T2' }))))];
    const s = await open(core);
    const root = await openEdit(s);
    typeInto(named(root, 'Escreva um comentário (Markdown)…'), 'Aguardando');
    press(need(root, 'button[data-action="comment"]'), 'Comentar');
    await until(() => core.writes.length === 1, 'the POST');
    const busy = editPanel(s)!.querySelectorAll('[aria-busy="true"]');
    assert.equal(busy.length, 1);
    assert.equal(busy[0]!.getAttribute('data-action'), 'comment');
    assert.ok(busy[0]!.hasAttribute('disabled'));
    assert.equal(editPanel(s)!.querySelectorAll('[disabled]').length, 1);
    release();
    await until(() => saved(s), 'saved');
    assert.equal(need(editPanel(s), '.wb-edit-saved').getAttribute('role'), 'status');
  });

  test('the refusal is an alert, the conflict a status that takes the focus, and none of its three exits is focused or primary', async () => {
    const core = new Core();
    core.scripted = [() => answer(502, { error: 'github-refused', reason: 'no-permission' })];
    const s = await open(core);
    const root = await openEdit(s);
    typeInto(named(root, 'Descrição da issue (Markdown)'), 'a');
    press(need(root, 'button[data-action="save-body"]'), 'Salvar descrição');
    await until(() => editPanel(s)!.querySelector('.wb-edit-refusal') !== null, 'the band');
    assert.equal(need(editPanel(s), '.wb-edit-refusal').getAttribute('role'), 'alert');
    core.gh.body = 'outro';
    core.gh.updatedAt = 'T9';
    press(need(editPanel(s), 'button[data-action="retry"]'), 'Tentar de novo');
    await until(() => editPanel(s)!.querySelector('.wb-edit-conflict') !== null, 'the conflict');
    const view = need(editPanel(s), '.wb-edit-conflict');
    assert.equal(need(view, '.wb-edit-band').getAttribute('role'), 'status');
    assert.equal(documentoFalso.activeElement, view, 'the focus goes to the conflict region');
    for (const b of view.querySelectorAll('.wb-edit-exits button')) {
      assert.notEqual(documentoFalso.activeElement, b);
      assert.ok(!b.classList.contains('filled'), 'no exit is the default');
    }
  });

  test('the focus survives every redraw: a step edit, a write and its answer keep the person where they were', async () => {
    const core = new Core();
    const s = await open(core);
    const root = await openEdit(s);
    press(named(root, 'Editar o passo 2: Passo 521'), 'the pencil');
    const input = named(editPanel(s), 'Título do passo 2');
    typeInto(input, 'Passo 521 b');
    key(input, 'Enter');
    await until(() => core.writes.length === 1 && saved(s), 'saved');
    const stayed = documentoFalso.activeElement;
    assert.ok(stayed && editPanel(s)!.contains(stayed), 'the focus is still inside the panel after the answer');
    press(named(editPanel(s), 'Remover o passo 3: Passo 522'), 'Remover');
    await until(() => core.writes.length === 2 && editPanel(s)!.querySelector('.wb-edit-notice') !== null, 'removed');
    assert.ok(documentoFalso.activeElement && editPanel(s)!.contains(documentoFalso.activeElement), 'the focus did not fall to the page after the removal');
  });

  test('the read panel keeps its own Escape; the edit mode does not close on Escape in a field, which would lose the text', async () => {
    const core = new Core();
    const s = await open(core);
    const root = await openEdit(s);
    const title = named(root, 'Título da issue');
    typeInto(title, 'Digitando');
    key(title, 'Escape');
    assert.ok(editPanel(s), 'the edit mode is still open');
    assert.equal(named(editPanel(s), 'Título da issue').value, 'Digitando');
  });
});
