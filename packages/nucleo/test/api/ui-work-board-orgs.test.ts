/*
 * End-to-end skeleton of the work board over every granted organization (#598, layer 1 of #608).
 * Written against the approved wireframe 598-1 to 598-4 (docs/wireframes/index.html), approved by the design owner on
 * 2026-11-14. The screen is mounted in the fake DOM over a fake read of GET /api/work shaped as layer 2 will serve it.
 * The shape of `organizations` below is the wireframe's reading of the contract; layer 2 settles it and these scenarios
 * move with it. The 20 scenarios were `todo` until the contract layer (issue 610), which wired the screen to GET /api/work and made them pass.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { origin: 'http://127.0.0.1:4317', pathname: '/ui/work', search: '' };
const pushed: string[] = [];
const go = (url: string) => {
  const u = new URL(url, here.origin);
  here.pathname = u.pathname;
  here.search = u.search;
};
Object.assign(globalThis, {
  location: here,
  history: { state: null, pushState: (_s: unknown, _t: string, url: string) => (go(url), pushed.push(url)), replaceState: (_s: unknown, _t: string, url: string) => go(url) },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });

// @ts-expect-error: browser module, plain JavaScript
import { mount } from '../../ui/screens/work-board.js';

const NOW = Date.parse('2026-11-14T23:12:40Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

type Obj = Record<string, unknown>;
const project = (owner: string, number: number, title: string) => ({ owner, number, title });
const PLATFORM = project('acme-labs', 3, 'Plataforma');
const MOBILE = project('acme-labs', 4, 'Mobile');
const ROADMAP = project('northwind', 1, 'Roadmap');
const SUPPORT = project('northwind', 2, 'Suporte');
const EXPERIMENTS = project('mira-dev', 1, 'Experimentos');

function card(n: number, org: string, from: ReturnType<typeof project>, over: Obj = {}): Obj {
  return {
    key: `${org}/app#${n}`, repo: `${org}/app`, number: n, title: `Issue ${n}`, url: `https://github.com/${org}/app/issues/${n}`, level: 'item', type: 'story',
    typeName: 'User Story', state: 'open', column: 'planning', columnSince: ago(5 * 60 * MIN), parent: null, chain: [], projectStatus: { id: 'todo', name: 'Todo' },
    labels: [], milestone: null, plan: null, sessions: { count: 0, state: null, ids: [] }, pullRequest: null, blocked: null, queuePosition: null, doneAt: null, doneBy: null,
    children: null, origin: { organization: org, project: from }, ...over,
  };
}

const READ_AT = NOW - 40_000;
const STALE_AT = NOW - 31 * MIN;
const org = (login: string, projects: ReturnType<typeof project>[], over: Obj = {}) => ({ login, own: false, state: 'read', readAt: READ_AT, projects, ...over });
const ORGS = [org('acme-labs', [PLATFORM, MOBILE]), org('northwind', [ROADMAP, SUPPORT]), org('mira-dev', [EXPERIMENTS], { own: true })];
const CARDS = [card(509, 'acme-labs', PLATFORM), card(499, 'acme-labs', MOBILE), card(503, 'northwind', ROADMAP), card(505, 'northwind', SUPPORT, { column: 'running' }), card(511, 'mira-dev', EXPERIMENTS, { repo: 'mira-dev/other' })];

function board(over: Obj = {}, cards: Obj[] = CARDS) {
  const columns = ['planning', 'queued', 'running', 'review', 'blocked', 'done'].map((id) => ({ id, label: id, criterion: '', cards: cards.filter((c) => c.column === id) }));
  return {
    organizations: ORGS, project: null, filters: { level: 'item' }, levels: ['item'], columns, blockedReasons: [], doneWindowDays: 14, queue: { available: true },
    options: { orgs: ORGS.map((o) => ({ login: o.login, own: o.own, count: cards.filter((c) => (c.origin as { organization: string }).organization === o.login).length })), projects: ORGS.flatMap((o) => o.projects.map((p) => ({ ...p, count: 1 }))), initiatives: [], epics: [], types: [], labels: [], repos: [], statuses: [] },
    total: cards.length, matched: cards.length, countsWithoutFilter: {}, fetchedAt: READ_AT, stale: false, staleReason: null, retryAt: null, ...over,
  };
}

interface Screen { area: ElementoFalso; reads: string[]; text(): string; button(label: string): ElementoFalso; cards(): ElementoFalso[]; leave(): void }
const mounted: Screen[] = [];
afterEach(() => mounted.splice(0).forEach((s) => s.leave()));

async function open(answer: (route: string) => unknown, path = '/ui/work', hold = false): Promise<Screen> {
  go(path);
  pushed.length = 0;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const leave = new AbortController();
  const ctx = {
    params: {}, signal: leave.signal, read: async (route: string) => (reads.push(route), answer(route)), write: () => Promise.reject(new Error('the work board writes nothing')),
    onChange: () => {}, onRestart: () => {}, liveState: () => 'live', counter: () => {}, title: () => {}, navigate: () => {},
  };
  const mounting = Promise.resolve(mount(area, ctx));
  let cleanup: unknown;
  void mounting.then((c) => (cleanup = c), () => {});
  if (hold) await new Promise((r) => setTimeout(r, 0));
  else await mounting;
  await new Promise((r) => setTimeout(r, 0));
  const screen: Screen = {
    area, reads, text: () => texto(area), cards: () => area.querySelectorAll('article.wb-card'), leave: () => (leave.abort(), typeof cleanup === 'function' && cleanup()),
    button: (label) => {
      const hit = area.querySelectorAll('button').find((b) => texto(b) === label || b.getAttribute('aria-label') === label);
      assert.ok(hit, `button "${label}" is on screen`);
      return hit;
    },
  };
  mounted.push(screen);
  return screen;
}

const cardOf = (s: Screen, n: number) => s.cards().find((c) => texto(c).includes(`#${n}`));
function choose(area: ElementoFalso, param: string, value: string) {
  const select = area.querySelector(`select[data-param="${param}"]`);
  assert.ok(select, `the ${param} select is on screen`);
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

const warn = (login: string, state: string, over: Obj = {}) => org(login, [], { state, readAt: null, ...over });

describe('AC-1: the header counts organizations and Projects, and each card says where it comes from (issue 598)', () => {
  test('several origins: the header counts, naming the account as "(você)"', async () => {
    const s = await open(() => board());
    assert.match(s.text(), /3 organizações · 5 Projects/);
    assert.match(s.text(), /mira-dev \(você\)/);
  });

  test('one organization and one Project: the header names them as today and the new filters and origin line are gone', async () => {
    const one = [org('acme-labs', [PLATFORM])];
    const cards = CARDS.filter((c) => (c.origin as { organization: string }).organization === 'acme-labs' && (c.origin as { project: unknown }).project === PLATFORM);
    const s = await open(() => board({ organizations: one, options: { orgs: [], projects: [], initiatives: [], epics: [], types: [], labels: [], repos: [], statuses: [] } }, cards));
    assert.match(s.text(), /acme-labs · GitHub Project “Plataforma”/);
    assert.equal(s.area.querySelector('select[data-param="org"]'), null);
    assert.equal(s.area.querySelector('select[data-param="project"]'), null);
    assert.equal(s.area.querySelectorAll('.wb-origin').length, 0);
  });

  test('the header does not count an organization that has a warning, and marks "N com aviso"', async () => {
    const s = await open(() => board({ organizations: [...ORGS, warn('globex', 'restricted'), warn('initech', 'failed')] }));
    assert.match(s.text(), /3 organizações · 5 Projects/);
    assert.match(s.text(), /2 com aviso/);
  });

  test('every card has an origin line "organização · Project"; the repository stays only on the card of another repository', async () => {
    const s = await open(() => board());
    const origin = (n: number) => texto(cardOf(s, n)!.querySelector('.wb-origin'));
    assert.match(origin(509), /acme-labs\s*·\s*Plataforma/);
    assert.match(origin(503), /northwind\s*·\s*Roadmap/);
    assert.equal(cardOf(s, 509)!.querySelector('.wb-repo'), null);
    assert.ok(cardOf(s, 511)!.querySelector('.wb-repo'), 'the card of another repository keeps its repository');
  });
});

describe('AC-2: the Organização and Project filters narrow the board with the six existing ones (issue 598)', () => {
  test('both filters are there, "Todas" and "Todos" by default, the account is "mira-dev (você)"', async () => {
    const s = await open(() => board());
    const org = s.area.querySelector('select[data-param="org"]');
    const proj = s.area.querySelector('select[data-param="project"]');
    assert.ok(org && proj, 'the org and project selects are on screen');
    assert.match(texto(org), /Todas/);
    assert.match(texto(org), /mira-dev \(você\)/);
    assert.match(texto(proj), /Todos/);
  });

  test('an organization with a warning and no cards is not an option', async () => {
    const s = await open(() => board({ organizations: [...ORGS, warn('globex', 'restricted')] }));
    const org = s.area.querySelector('select[data-param="org"]');
    assert.ok(org, 'the org select is on screen');
    assert.doesNotMatch(texto(org), /globex/);
  });

  test('choosing an organization reads and keeps `org` in the URL', async () => {
    const s = await open(() => board());
    choose(s.area, 'org', 'acme-labs');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(s.reads.some((r) => new URL(r, here.origin).searchParams.get('org') === 'acme-labs'), 'GET /api/work carries org=acme-labs');
    assert.equal(new URL(here.pathname + here.search, here.origin).searchParams.get('org'), 'acme-labs');
  });

  test('choosing a Project keeps `project=owner/number` in the URL; with an organization, only its Projects are options', async () => {
    const s = await open(() => board(), '/ui/work?org=acme-labs');
    const proj = s.area.querySelector('select[data-param="project"]');
    assert.ok(proj, 'the project select is on screen');
    assert.doesNotMatch(texto(proj), /Roadmap/);
    choose(s.area, 'project', 'acme-labs/3');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(new URL(here.pathname + here.search, here.origin).searchParams.get('project'), 'acme-labs/3');
  });

  test('switching to an organization that does not own the chosen Project resets it to Todos and says why', async () => {
    const s = await open(() => board(), '/ui/work?org=acme-labs&project=acme-labs/3');
    choose(s.area, 'org', 'northwind');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(new URL(here.pathname + here.search, here.origin).searchParams.get('project'), null);
    assert.match(s.text(), /O Project “Plataforma” é de acme-labs, não de northwind: voltou para Todos\./);
  });

  test('the organization and Project params go into the read with the existing filter, and both chips show', async () => {
    const params = '?org=acme-labs&project=acme-labs/3&type=story';
    const answer = () => board({ project: { owner: 'acme-labs', number: 3, title: 'Plataforma' }, filters: { level: 'item', type: 'story', org: 'acme-labs', project: 'acme-labs/3' } });
    const s = await open(answer, `/ui/work${params}`);
    const read = s.reads.map((r) => new URL(r, here.origin).searchParams).find((p) => p.get('org') === 'acme-labs');
    assert.ok(read, 'GET /api/work carries org=acme-labs');
    assert.equal(read.get('project'), 'acme-labs/3');
    assert.equal(read.get('type'), 'story', 'the existing filter keeps applying with them');
    for (const param of ['org', 'project', 'type']) assert.ok(s.area.querySelector(`.wb-chip[data-param="${param}"]`), `the ${param} chip is on screen`);
  });
});

describe('AC-3: an organization that restricts the app or fails to read is a warning; the others stay (issue 598)', () => {
  test('restricts the app: yellow warning with Aprovar (dono) and Pedir acesso, the other cards stay', async () => {
    const s = await open(() => board({ organizations: [...ORGS, warn('globex', 'restricted')] }));
    assert.match(s.text(), /globex restringe apps OAuth/);
    s.button('Aprovar (dono)');
    s.button('Pedir acesso');
    assert.equal(s.cards().length, CARDS.length);
  });

  test('SSO required: the warning says so and offers Entrar pelo SSO', async () => {
    const s = await open(() => board({ organizations: [...ORGS, warn('umbrella-corp', 'saml')] }));
    assert.match(s.text(), /umbrella-corp exige login pelo SSO/);
    s.button('Entrar pelo SSO');
  });

  test('read failed with nothing stored: red warning with Tentar de novo, the others stay', async () => {
    const s = await open(() => board({ organizations: [...ORGS, warn('initech', 'failed')] }));
    assert.match(s.text(), /Não conseguimos ler os Projects de initech/);
    s.button('Tentar de novo');
    assert.equal(s.cards().length, CARDS.length);
  });

  test('a read before that fails now keeps its last cards dimmed, and the band says the read time', async () => {
    const stale = org('northwind', [ROADMAP, SUPPORT], { state: 'failed', readAt: STALE_AT });
    const s = await open(() => board({ organizations: [ORGS[0], stale, ORGS[2]] }));
    assert.equal(s.cards().length, CARDS.length, 'northwind keeps its cards');
    assert.ok(cardOf(s, 503)!.classList.contains('wb-org-stale'), 'a northwind card is dimmed');
    assert.ok(!cardOf(s, 509)!.classList.contains('wb-org-stale'), 'an acme-labs card is not');
    assert.match(s.text(), /Não conseguimos ler os Projects de northwind agora/);
    assert.ok(s.text().includes(`última leitura, às ${clock(STALE_AT)}`) || s.text().includes(`última leitura dela, às ${clock(STALE_AT)}`), 'the band says the read time');
    s.button('Tentar de novo');
  });

  test('more than three warnings: three bands and "Mais N organizações com aviso"', async () => {
    const five = ['globex', 'initech', 'umbrella-corp', 'hooli', 'pied-piper'].map((l, i) => warn(l, i === 2 ? 'saml' : i === 0 ? 'restricted' : 'failed'));
    const s = await open(() => board({ organizations: [...ORGS, ...five] }));
    assert.equal(s.area.querySelectorAll('.wb-warns > .wb-warn-band').length, 3);
    assert.match(s.text(), /Mais 2 organizações com aviso/);
  });
});

describe('AC-1 and AC-3: loading, empty, all failed and GitHub down (issue 598)', () => {
  test('loading waits for every organization: counters in "…" and the filters off', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = await open(async () => (await gate, board()), '/ui/work', true);
    assert.match(s.text(), /… organizações · … Projects/);
    assert.ok(s.area.querySelectorAll('select').every((sel) => sel.hasAttribute('disabled') || (sel as unknown as { disabled?: boolean }).disabled), 'every filter is off while loading');
    release();
    await new Promise((r) => setTimeout(r, 0));
  });

  test('no issue in any Project read: says what the board would show and leads to GitHub and to the connection', async () => {
    const s = await open(() => board({ total: 0, matched: 0 }, []));
    assert.match(s.text(), /Nenhuma issue nos Projects das suas organizações/);
    s.button('Conceder acesso a outra organização');
  });

  test('no Project at all: "Nenhum Project para mostrar", and "Trocar de Project" is not offered', async () => {
    const none = [org('acme-labs', [])];
    const s = await open(() => board({ organizations: none }, []));
    assert.match(s.text(), /Nenhum Project para mostrar/);
    assert.doesNotMatch(s.text(), /Trocar de Project/);
  });

  test('every organization with a warning: nothing to show, each warning says what to do, and Tentar agora reads again', async () => {
    const all = [warn('globex', 'restricted'), warn('initech', 'failed'), warn('umbrella-corp', 'saml')];
    const s = await open(() => board({ organizations: all }, []));
    assert.match(s.text(), /Não conseguimos ler nenhuma organização/);
    const before = s.reads.length;
    s.button('Tentar agora').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(s.reads.length > before, 'Tentar agora reads again');
  });

  test('GitHub down: one band (the 465-4 one), not one warning per organization', async () => {
    const down = ORGS.map((o) => ({ ...o, state: 'failed' }));
    const s = await open(() => board({ organizations: down, stale: true, staleReason: 'github-unavailable' }));
    assert.match(s.text(), /GitHub indisponível/);
    assert.match(s.text(), /3 organizações · 5 Projects/, 'the header still counts every organization');
    assert.equal(s.area.querySelectorAll('.wb-warns > .wb-warn-band').length, 0, 'no per-organization band');
  });
});

describe('AC-4: the assembled page over several organizations is accessible (page-level check, issue 610)', () => {
  const nameOf = (n: ElementoFalso) => (n.getAttribute('aria-label') ?? texto(n)).trim();
  const inOrder = (root: ElementoFalso): ElementoFalso[] => root.children.flatMap((c) => [c, ...inOrder(c)]);
  const FOCUSABLE = new Set(['A', 'BUTTON', 'SELECT']);
  const focusOrder = (s: Screen) => inOrder(s.area).filter((n) => FOCUSABLE.has(n.tagName) && !n.hasAttribute('disabled'));

  function checkPage(s: Screen) {
    const all = inOrder(s.area);
    // Landmarks and headings: the filters and the board are named regions, one h1 and no skipped level.
    assert.ok(s.area.querySelector('section[aria-label="Filtros"]'), 'the filters are a labelled section');
    assert.ok(s.area.querySelector('div[role="region"][aria-label]'), 'the board is a labelled region');
    const levels = all.filter((n) => /^H[1-6]$/.test(n.tagName)).map((n) => Number(n.tagName[1]));
    assert.equal(levels.filter((l) => l === 1).length, 1, 'one h1');
    assert.equal(levels[0], 1, 'the page starts with its h1');
    levels.forEach((l, i) => i && assert.ok(l <= levels[i - 1]! + 1, `heading level ${l} follows ${levels[i - 1]}`));
    for (const col of s.area.querySelectorAll('section.wb-col')) assert.ok(col.getAttribute('aria-labelledby'), 'a column is named by its heading');
    // Every select is labelled and every button and link is named.
    for (const select of s.area.querySelectorAll('select')) {
      const label = select.closest('label');
      assert.ok((label && texto(label.querySelector('span.wb-field-label')).trim()) || select.getAttribute('aria-label'), `select ${select.getAttribute('data-param')} has a label`);
    }
    for (const n of [...s.area.querySelectorAll('button'), ...s.area.querySelectorAll('a')]) assert.notEqual(nameOf(n), '', `${n.tagName} ${n.getAttribute('class')} has no name`);
    // Bands are announced: a warning band is a status, a failure one an alert.
    for (const band of s.area.querySelectorAll('div.wb-warn-band')) assert.ok(['status', 'alert'].includes(band.getAttribute('role') ?? ''), 'a warning band has a live role');
    // Focus order: the filters come before the cards, and no id repeats.
    const order = focusOrder(s);
    const firstSelect = order.findIndex((n) => n.tagName === 'SELECT');
    const firstCard = order.findIndex((n) => n.closest('article') !== null);
    assert.ok(firstSelect >= 0 && firstCard > firstSelect, 'the filters come before the board in the focus order');
    const ids = s.area.querySelectorAll('[id]').map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
  }

  test('populated over three organizations: landmarks, headings, labels, names and focus order', async () => {
    const s = await open(() => board());
    assert.equal(s.cards().length, CARDS.length);
    checkPage(s);
    assert.equal(s.area.querySelectorAll('select').length, 8, 'the org and project selects join the six');
  });

  test('with the Project reset note: the note is announced as a status', async () => {
    const s = await open(() => board(), '/ui/work?org=acme-labs&project=acme-labs/3');
    choose(s.area, 'org', 'northwind');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(s.area.querySelector('p.wb-reset-note')?.getAttribute('role'), 'status');
    checkPage(s);
  });

  test('five warnings and a stale organization: bands are announced and "Mais N" is a toggle with aria-expanded', async () => {
    const five = ['globex', 'initech', 'umbrella-corp', 'hooli', 'pied-piper'].map((l, i) => warn(l, i === 2 ? 'saml' : i === 0 ? 'restricted' : 'failed'));
    const stale = org('northwind', [ROADMAP, SUPPORT], { state: 'failed', readAt: STALE_AT });
    const s = await open(() => board({ organizations: [ORGS[0], stale, ORGS[2], ...five] }));
    checkPage(s);
    const bands = () => s.area.querySelectorAll('div.wb-warn-band');
    assert.equal(bands().length, 3);
    assert.ok(bands().some((b) => b.getAttribute('role') === 'alert') && bands().some((b) => b.getAttribute('role') === 'status'), 'both live roles are used');
    const more = s.area.querySelector('button.wb-warns-more')!;
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    more.dispatchEvent({ type: 'click' });
    assert.equal(bands().length, 6, 'the toggle opens the rest');
    assert.equal(s.area.querySelector('button.wb-warns-more')!.getAttribute('aria-expanded'), 'true');
    checkPage(s);
  });

  test('the empty and all-failed states keep the page named and ordered', async () => {
    const all = [warn('globex', 'restricted'), warn('initech', 'failed')];
    const s = await open(() => board({ organizations: all }, []));
    assert.equal(s.area.querySelector('section.wb-orgs-empty')?.getAttribute('role'), 'alert');
    for (const n of [...s.area.querySelectorAll('button'), ...s.area.querySelectorAll('a')]) assert.notEqual(nameOf(n), '', `${n.tagName} has no name`);
    const ids = s.area.querySelectorAll('[id]').map((n) => n.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
  });
});
