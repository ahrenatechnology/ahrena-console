// Issue 243, layer 2 (wireframes C45 to C49): the /ui side of the sessions of every machine. The pure
// part of ui/machine-filter.js, the feed's insertion by `createdAt`, and the screens mounted in the fake
// DOM against a stubbed core: the filter, the tag, the C48 notice and the remote Detail. Synthetic data.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { ElementoFalso, documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// ---------- The page around the screens ----------

const page = { pathname: '/ui', search: '', hash: '' };
const urls: string[] = [];
const setUrl = (url: string) => {
  const u = new URL(url, 'http://127.0.0.1');
  Object.assign(page, { pathname: u.pathname, search: u.search, hash: u.hash });
};
Object.assign(globalThis, {
  location: page,
  history: {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => (urls.push(url), setUrl(url)),
    pushState: (_s: unknown, _t: string, url: string) => setUrl(url),
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  getComputedStyle: () => ({ getPropertyValue: () => '', paddingBottom: '0' }),
});

// @ts-expect-error: browser modules, plain JavaScript
const mf = await import('../../ui/machine-filter.js');
// @ts-expect-error: idem
const feedState = await import('../../ui/screens/feed-state.js');
// @ts-expect-error: idem
const wall = await import('../../ui/screens/wall.js');
// @ts-expect-error: idem
const kanban = await import('../../ui/screens/kanban.js');
// @ts-expect-error: idem
const sessions = await import('../../ui/screens/sessions.js');
// @ts-expect-error: idem
const history = await import('../../ui/screens/history.js');
// @ts-expect-error: idem
const dashboard = await import('../../ui/screens/dashboard.js');
// @ts-expect-error: idem
const feed = await import('../../ui/screens/feed.js');
// @ts-expect-error: idem
const detail = await import('../../ui/screens/session-detail.js');

const all = (root: ElementoFalso, sel: string) => root.querySelectorAll(sel);
const one = (root: ElementoFalso, sel: string) => root.querySelector(sel);
const until = async (cond: () => boolean, what = 'the condition', ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- Synthetic machines and items ----------

const WS = { id: 'ws', label: 'Workstation' };
const READ_AT = '2026-10-22T22:41:00';
const machinesUp = [
  { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, lastReadAt: '2026-10-22T23:00:00Z' },
  { id: WS.id, label: WS.label, state: 'connected', reason: null, lastReadAt: '2026-10-22T23:00:00Z' },
];
const machinesDown = [machinesUp[0], { ...machinesUp[1], state: 'unreachable', reason: 'port-closed', lastReadAt: new Date(READ_AT).toISOString() }];
const onlyLocal = [machinesUp[0]];

/** A ctx with a stubbed core: `answer(route)` gives the JSON; every route asked is kept. */
function context(answer: (route: string) => unknown, params: Record<string, string> = {}) {
  const routes: string[] = [];
  const writes: string[] = [];
  const changes: ((c: unknown[]) => void)[] = [];
  const restarts: (() => void)[] = [];
  const leave = new AbortController();
  return {
    routes,
    writes,
    leave,
    change: (c: unknown[]) => changes.forEach((f) => f(c)),
    restart: () => restarts.forEach((f) => f()),
    ctx: {
      params,
      signal: leave.signal,
      read: async (route: string) => {
        routes.push(route);
        const a = answer(route);
        if (a instanceof Error) throw a;
        return structuredClone(a);
      },
      write: async (route: string) => (writes.push(route), {}),
      onChange: (f: (c: unknown[]) => void) => changes.push(f),
      onRestart: (f: () => void) => restarts.push(f),
      liveState: () => 'live',
      counter: () => {},
      title: () => {},
      navigate: (r: string) => setUrl(r),
    },
  };
}

beforeEach(() => {
  mf.resetMachineChoice();
  urls.length = 0;
  for (const l of documentoFalso.head.querySelectorAll('link')) l.remove();
});

// ---------- The pure part ----------

describe('machine-filter: the choice, the URL and the routes', () => {
  test('the choice comes from ?machine= (all, local or a remote id); a bad one is no choice', () => {
    assert.equal(mf.machineFromQuery('?machine=ws'), 'ws');
    assert.equal(mf.machineFromQuery('?machine=local&status=idle'), 'local');
    assert.equal(mf.machineFromQuery('?machine=all'), 'all');
    assert.equal(mf.machineFromQuery(''), null);
    assert.equal(mf.machineFromQuery('?machine=../x'), null);
    assert.equal(mf.machineFromQuery('?machine=WS'), null);
  });

  test('round trip: the /ui query keeps the other parameters and leaves Todas out', () => {
    assert.equal(mf.queryWithMachine('?status=idle&order=cost', 'ws'), '?status=idle&order=cost&machine=ws');
    assert.equal(mf.queryWithMachine('?status=idle&machine=ws', 'all'), '?status=idle');
    assert.equal(mf.queryWithMachine('', 'all'), '');
    assert.equal(mf.machineFromQuery(mf.queryWithMachine('?view=agents', 'local')), 'local');
    assert.equal(mf.withQuery('?focus=message&machine=ws', { focus: null }), '?machine=ws');
  });

  test('the list routes always carry machine, all by default, and the rest of the query stays as written', () => {
    assert.equal(mf.routeWithMachine('/api/wall', 'all'), '/api/wall?machine=all');
    assert.equal(mf.routeWithMachine('/api/wall', null), '/api/wall?machine=all');
    assert.equal(mf.routeWithMachine('/api/events?before=v%201', 'ws'), '/api/events?before=v%201&machine=ws');
    assert.equal(mf.routeWithMachine('/api/sessions?machine=local&page=2', 'ws'), '/api/sessions?machine=ws&page=2');
  });

  test('the last choice is remembered for the next screen; the URL wins over it', () => {
    assert.equal(mf.initialChoice(''), 'all');
    mf.rememberChoice('ws');
    assert.equal(mf.initialChoice(''), 'ws');
    assert.equal(mf.initialChoice('?machine=local'), 'local');
  });

  test('keys and links: machine + id, and a remote Detail with ?machine=', () => {
    assert.equal(mf.itemKey({ id: 's1' }), 'local:s1');
    assert.equal(mf.itemKey({ id: 's1', machine: WS }), 'ws:s1');
    assert.notEqual(mf.itemKey({ id: 's1' }), mf.itemKey({ id: 's1', machine: WS }));
    assert.equal(mf.sessionHref('s1'), '/ui/sessions/s1');
    assert.equal(mf.sessionHref('s1', 'local'), '/ui/sessions/s1');
    assert.equal(mf.sessionHref('s 1', 'ws'), '/ui/sessions/s%201?machine=ws');
    assert.equal(mf.itemHref({ id: 's1', machine: { id: 'local', label: 'Esta máquina' } }), '/ui/sessions/s1');
    assert.equal(mf.itemHref({ session: 's2', machine: WS }, 's2'), '/ui/sessions/s2?machine=ws');
  });

  test('the machines: checked, this machine first; the remotes that are down for each choice', () => {
    const list = mf.normalizeMachines([machinesDown[1], machinesDown[0], { id: 'Bad id' }, null]);
    assert.deepEqual(list.map((m: { id: string }) => m.id), ['local', 'ws']);
    assert.equal(list[0].label, 'Esta máquina');
    assert.deepEqual(mf.downFor(list, 'all').map((m: { id: string }) => m.id), ['ws']);
    assert.deepEqual(mf.downFor(list, 'ws').map((m: { id: string }) => m.id), ['ws']);
    assert.deepEqual(mf.downFor(list, 'local'), []);
    assert.deepEqual(mf.downFor(mf.normalizeMachines(machinesUp), 'all'), []);
  });

  test('C48: the notice text, with the hour and the age of the last read, and without it', () => {
    const at = Date.parse(new Date(READ_AT).toISOString());
    const t = mf.downText({ label: 'Workstation', lastReadAt: new Date(READ_AT).toISOString() }, at + 14 * 60_000);
    assert.equal(t.title, 'Workstation sem conexão desde 22:41 (há 14 min).');
    assert.equal(t.text, 'As sessões de lá voltam quando ela responder.');
    assert.equal(mf.downText({ label: 'Workstation', lastReadAt: null }).title, 'Workstation sem conexão.');
  });

  test('"· 3 na Workstation", the subtitles and the attention of the choice', () => {
    const machines = mf.normalizeMachines(machinesUp);
    assert.deepEqual(mf.remoteParts([{ id: 'local', total: 9 }, { id: 'ws', total: 3 }], machines, (b: { total: number }) => b.total), ['3 na Workstation']);
    assert.deepEqual(mf.remoteParts([{ id: 'ws', total: 0 }], machines, (b: { total: number }) => b.total), []);
    assert.equal(mf.whereText('all', machines), 'nas duas máquinas');
    assert.equal(mf.whereText('local', machines), 'nesta máquina');
    assert.equal(mf.whereText('ws', machines), 'na Workstation');
    assert.equal(mf.whereText('all', machines, { form: 'of' }), 'das duas máquinas');
    assert.equal(mf.whereText('local', machines, { form: 'of' }), 'desta máquina');
    assert.equal(mf.whereText('ws', machines, { form: 'of' }), 'da Workstation');
    assert.equal(mf.whereText('all', machines, { form: 'any' }), 'em uma das máquinas');
    assert.equal(mf.whereText('ws', machines, { form: 'any' }), 'na Workstation');
    const attention = { blocked: 2, idle: 0, items: [{ session: 'a', machine: null }, { session: 'b', machine: WS }] };
    assert.equal(mf.attentionForChoice(attention, 'all'), attention);
    assert.deepEqual(mf.attentionForChoice(attention, 'ws').items.map((i: { session: string }) => i.session), ['b']);
    assert.equal(mf.attentionForChoice(attention, 'local').blocked, undefined, 'the route counts cover every machine');
  });

  test('the machine changes and the 503 of a remote Detail', () => {
    assert.equal(mf.touchesRemotes([{ type: 'alert', key: 'ws:machine-unreachable' }]), true);
    assert.equal(mf.touchesRemotes([{ type: 'session', key: 's1' }]), false);
    assert.equal(mf.isMachineUnreachable({ status: 503, body: { error: 'machine-unreachable' } }), true);
    assert.equal(mf.isMachineUnreachable({ status: 503, body: { error: 'other' } }), false);
    assert.equal(mf.readAgeText(6_400), 'há 6 s');
  });
});

describe('machine-filter: the tag, the notice and the control', () => {
  test('the tag only on a remote item; the icon-only one says the machine in the tooltip', () => {
    assert.equal(mf.machineTag({ id: 's1' }), null);
    assert.equal(mf.machineTag({ id: 's1', machine: { id: 'local', label: 'Esta máquina' } }), null);
    const tag = mf.machineTag({ id: 's1', machine: WS });
    assert.equal(texto(tag), 'Workstation');
    assert.ok(tag.classList.contains('mf-tag'));
    const iconOnly = mf.machineTag({ id: 's1', machine: WS }, { iconOnly: true });
    assert.equal(texto(iconOnly), '');
    assert.equal(iconOnly.getAttribute('title'), 'Workstation');
    assert.equal(iconOnly.getAttribute('aria-label'), 'Workstation');
  });

  test('C48: the notice is the neutral band, never the red error band, with "Ver a Workstation" to its screen', () => {
    const n = mf.downNotice(mf.normalizeMachines(machinesDown)[1]);
    assert.ok(n.classList.contains('mf-notice'));
    assert.ok(!n.classList.contains('error-band'));
    assert.equal(n.getAttribute('role'), 'status');
    assert.match(texto(n), /^Workstation sem conexão desde \d\d:\d\d \(há .+\)\. As sessões de lá voltam quando ela responder\. Ver a Workstation$/);
    assert.equal(one(n, 'a')!.getAttribute('href'), '/ui/machines/ws');
  });

  test('the control: Todas, Esta máquina and one segment per remote, by its label; a remote that is down is grey', () => {
    const c = mf.machineControl(machinesDown, 'all', () => {});
    assert.equal(texto(one(c, '.mf-label')), 'Máquina');
    const buttons = all(c, 'button');
    assert.deepEqual(buttons.map((b) => texto(b)), ['Todas', 'Esta máquina', 'Workstation']);
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.ok(buttons[2]!.classList.contains('mf-off'));
    assert.ok(!buttons[1]!.classList.contains('mf-off'));
    assert.doesNotMatch(texto(c), /\bws\b/, 'no machine id on screen');
  });
});

// ---------- The feed's state: keys and createdAt ----------

const ev = (id: string, at: string, machine: { id: string; label: string } | null = null) => ({ id, createdAt: at, type: 'PreToolUse', status: 'active', session: { id: 's1', title: 'Sessão', project: 'p' }, ...(machine ? { machine } : {}) });

describe('feed-state: machine + id and the insertion by createdAt (issue 243)', () => {
  test('the same event id on two machines is two events; the same one twice is one', () => {
    const s = feedState.newState();
    feedState.load(s, { events: [ev('e1', '2026-10-22T23:00:05Z')], cursor: 'c', older: 'o' });
    const r = feedState.receiveNewer(s, { events: [ev('e1', '2026-10-22T23:00:06Z', WS), ev('e1', '2026-10-22T23:00:05Z')], cursor: 'c2' });
    assert.equal(r.entraram.length, 1);
    assert.deepEqual(s.events.map((e: { id: string }) => feedState.eventKey(e)), ['ws:e1', 'local:e1']);
  });

  test('a machine that comes back during live polling: its page lands by createdAt, not on top', () => {
    const s = feedState.newState();
    feedState.load(s, { events: [ev('l2', '2026-10-22T23:00:10Z'), ev('l1', '2026-10-22T23:00:00Z')], cursor: 'c', older: null });
    const r = feedState.receiveNewer(s, { events: [ev('w2', '2026-10-22T23:00:20Z', WS), ev('w1', '2026-10-22T23:00:05Z', WS)], cursor: 'c2' });
    assert.equal(r.noTopo, false);
    assert.deepEqual(s.events.map((e: { id: string }) => e.id), ['w2', 'l2', 'w1', 'l1']);
  });

  test('an older page of several machines is inserted by createdAt and deduplicated by machine + id', () => {
    const s = feedState.newState();
    feedState.load(s, { events: [ev('l3', '2026-10-22T23:00:30Z'), ev('w3', '2026-10-22T23:00:20Z', WS)], cursor: 'c', older: 'o' });
    const older = feedState.receiveOlder(s, { events: [ev('l2', '2026-10-22T23:00:25Z'), ev('w3', '2026-10-22T23:00:20Z', WS), ev('w2', '2026-10-22T23:00:01Z', WS)], older: null });
    assert.equal(older.atEnd, false, 'l2 is newer than the last row on screen');
    assert.deepEqual(older.entered.map((e: { id: string }) => feedState.eventKey(e)), ['local:l2', 'ws:w2'], 'the repeated w3 does not come in again');
    assert.deepEqual(s.events.map((e: { id: string }) => feedState.eventKey(e)), ['local:l3', 'local:l2', 'ws:w3', 'ws:w2']);
    const after = feedState.receiveOlder(s, { events: [ev('l1', '2026-10-22T23:00:00Z')], older: null });
    assert.equal(after.atEnd, true);
    assert.deepEqual(after.entered.map((e: { id: string }) => e.id), ['l1']);
  });

  test('the open row is the event key, so the same id on the other machine stays closed', () => {
    const s = feedState.newState();
    feedState.load(s, { events: [ev('e1', '2026-10-22T23:00:06Z', WS), ev('e1', '2026-10-22T23:00:05Z')], cursor: 'c', older: null });
    feedState.toggleOne(s, 'ws:e1');
    assert.equal(s.aberto, 'ws:e1');
    assert.equal(feedState.sessionRoute('s1', 'ws'), '/ui/sessions/s1?machine=ws');
  });
});

// ---------- The screens ----------

const wallCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Sessão ${id}`,
  project: 'projeto-exemplo',
  branch: 'feat/1-exemplo',
  status: 'active',
  state: 'active',
  since: '2026-10-22T22:00:00Z',
  activity: { type: 'tool', text: 'Rodar a bateria' },
  model: 'claude-opus-5-5',
  effort: 'high',
  agents: { active: 1, total: 1 },
  cost: { usd: 1, estimate: true },
  plan: { done: 1, total: 2, current: null },
  context: { pct: 10 },
  open: { target: 'desktop', command: null },
  machine: { id: 'local', label: 'Esta máquina' },
  ...extra,
});

describe('Mural ao vivo with every machine (C46, C48)', () => {
  test('with only this machine: no filter and no tag, as before; always read with machine=all', async () => {
    setUrl('/ui/wall');
    const f = context(() => ({ count: {}, cards: [wallCard('s1')], machines: onlyLocal }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    assert.deepEqual(f.routes, ['/api/wall?machine=all']);
    assert.equal(all(area, '.mf-filter').length, 0);
    assert.equal(all(area, '.mf-tag').length, 0);
    assert.equal(all(area, '.mf-notice').length, 0);
    f.leave.abort();
  });

  test('with a remote: the filter on its own row, the tag only on the remote card, the remote card opens the remote Detail with its open action off', async () => {
    setUrl('/ui/wall');
    const f = context(() => ({ count: {}, cards: [wallCard('s1'), wallCard('s1', { machine: WS, open: { target: 'remote', command: null } })], machines: machinesUp }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    assert.equal(all(area, '.mf-row .mf-filter').length, 1);
    const cards = all(area, '.wall-card');
    assert.deepEqual(cards.map((c) => c.getAttribute('data-key')), ['local:s1', 'ws:s1']);
    assert.equal(all(cards[0]!, '.mf-tag').length, 0);
    assert.equal(texto(one(cards[1]!, '.wall-prj')), 'projeto-exemplo · feat/1-exemplo Workstation', 'the tag shares the project line');
    assert.equal(one(cards[1]!, 'a.wall-link')!.getAttribute('href'), '/ui/sessions/s1?machine=ws');
    assert.equal(one(cards[0]!, 'a.wall-link')!.getAttribute('href'), '/ui/sessions/s1');
    const off = one(cards[1]!, '.open-action button')!;
    assert.equal(off.getAttribute('aria-disabled'), 'true');
    off.click();
    await tick();
    assert.deepEqual(f.writes, [], 'a remote card never POSTs to this core');
    f.leave.abort();
  });

  test('choosing a machine: the URL gets ?machine=, the next read asks for it, and the choice is remembered', async () => {
    setUrl('/ui/wall');
    const f = context(() => ({ count: {}, cards: [], machines: machinesUp }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    one(area, '.mf-seg button[data-machine="ws"]')!.click();
    await until(() => f.routes.includes('/api/wall?machine=ws'), 'the read of the chosen machine');
    assert.equal(page.search, '?machine=ws');
    assert.equal(mf.initialChoice(''), 'ws');
    one(area, '.mf-seg button[data-machine="all"]')!.click();
    await until(() => f.routes.at(-1) === '/api/wall?machine=all');
    assert.equal(page.search, '', 'Todas leaves the URL');
    f.leave.abort();
  });

  test('C48: a remote down gives the neutral notice and a grey segment, never the red band; chosen, the list is empty with the notice', async () => {
    setUrl('/ui/wall');
    const f = context((route) => (route === '/api/machines' ? machinesDown : route.includes('machine=ws') ? { count: {}, cards: [], machines: [machinesDown[1]] } : { count: {}, cards: [wallCard('s1')], machines: machinesDown }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    assert.equal(all(area, '.mf-notice').length, 1);
    assert.match(texto(one(area, '.mf-notice')), /^Workstation sem conexão desde/);
    assert.equal(all(area, '.error-band').length, 0);
    assert.ok(one(area, '.mf-seg button[data-machine="ws"]')!.classList.contains('mf-off'));
    assert.equal(all(area, '.wall-card').length, 1, 'this machine\'s list stays');

    one(area, '.mf-seg button[data-machine="ws"]')!.click();
    await until(() => f.routes.includes('/api/wall?machine=ws'));
    await tick();
    assert.equal(all(area, '.mf-notice').length, 1);
    assert.equal(all(area, '.wall-card').length, 0);
    assert.equal(all(area, '.state').length, 0, 'no empty card: the notice says why');
    assert.equal(all(area, '.mf-seg button').length, 3, 'the other segments stay');
    f.leave.abort();
  });

  test('opening on a remote choice reads /api/machines for the other segments', async () => {
    setUrl('/ui/wall?machine=ws');
    const f = context((route) => (route === '/api/machines' ? machinesUp : { count: {}, cards: [], machines: [machinesUp[1]] }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    await until(() => all(area, '.mf-seg button').length === 3, 'the three segments');
    assert.ok(f.routes.includes('/api/machines'));
    assert.equal(one(area, '.mf-seg button[aria-pressed="true"]')!.getAttribute('data-machine'), 'ws');
    f.leave.abort();
  });

  test('a choice the core no longer knows goes back to Todas', async () => {
    setUrl('/ui/wall?machine=gone');
    const unknown = Object.assign(new Error('machine: máquina desconhecida'), { status: 400, body: { error: 'machine: máquina desconhecida (gone)' } });
    const f = context((route) => (route.includes('machine=gone') ? unknown : route === '/api/machines' ? machinesUp : { count: {}, cards: [], machines: machinesUp }));
    const area = new ElementoFalso('main');
    await wall.mount(area, f.ctx);
    await until(() => f.routes.includes('/api/wall?machine=all'), 'the read with Todas');
    assert.equal(page.search, '');
    f.leave.abort();
  });
});

describe('Kanban with every machine (C46)', () => {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Sessão ${id}`, status: 'active', attention: null, lastActivity: '2026-10-22T22:00:00Z', running: true, durationMs: 60_000, agents: 1, model: 'Opus 5.5', costUsd: 1, cwd: '/simulacao/x', ...extra });
  const board = (items: unknown[]) => ({ view: 'sessions', columns: [{ id: 'active', label: 'Ativas', total: items.length, page: 1, hasMore: false, items }], machines: machinesUp });

  test('a remote card swaps the folder for the server icon, the machine in the tooltip; ids repeat across machines without colliding', async () => {
    setUrl('/ui/kanban');
    const f = context(() => board([card('s1'), card('s1', { machine: WS })]));
    const area = new ElementoFalso('main');
    await kanban.mount(area, f.ctx);
    const cards = all(area, '.kb-kc');
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((c) => c.getAttribute('data-key')), ['local:s1', 'ws:s1']);
    assert.equal(all(cards[0]!, '.mf-tag').length, 0);
    const tag = one(cards[1]!, '.kb-av .mf-tag')!;
    assert.equal(tag.getAttribute('title'), 'Workstation');
    assert.equal(texto(tag), '');
    assert.equal(cards[1]!.getAttribute('href'), '/ui/sessions/s1?machine=ws');
    assert.equal(all(area, '.mf-row .mf-filter').length, 1);
    assert.match(texto(area), /As sessões das duas máquinas por status, só leitura/);
    f.leave.abort();
  });

  test('the agents view: no tag on an agent card, but it opens the remote Detail; switching views keeps ?machine=', async () => {
    setUrl('/ui/kanban?machine=ws');
    const agent = { id: 'a1', sessionId: 's9', name: 'principal', main: true, status: 'working', attention: null, durationMs: 1000, running: true, machine: WS };
    const f = context((route) => (route === '/api/machines' ? machinesUp : { view: 'agents', columns: [{ id: 'working', label: 'Trabalhando', total: 1, page: 1, hasMore: false, items: [agent] }], machines: [machinesUp[1]] }));
    const area = new ElementoFalso('main');
    await kanban.mount(area, f.ctx);
    const switchTo = all(area, '.kb-seg button').find((b) => texto(b) === 'Agentes')!;
    switchTo.click();
    await until(() => all(area, '.kb-agent').length === 1, 'the agent card');
    assert.equal(page.search, '?view=agents&machine=ws');
    const a = one(area, '.kb-agent')!;
    assert.equal(all(a, '.mf-tag').length, 0);
    assert.equal(a.getAttribute('href'), '/ui/sessions/s9?machine=ws');
    assert.ok(f.routes.includes('/api/kanban?view=agents&machine=ws'));
    f.leave.abort();
  });
});

describe('Sessões with every machine (C45, C48)', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Sessão ${id}`, status: 'active', attention: null, lastActivity: '2026-10-22T22:00:00Z', running: true, durationMs: 60_000, agents: 1, costUsd: 1, cwd: '/simulacao/x', account: null, open: { target: 'desktop', command: null }, ...extra });
  const list = (items: unknown[], machines: unknown[], extra: Record<string, unknown> = {}) => ({ total: items.length, registered: items.length, page: 1, perPage: 10, pages: 1, directories: [], counts: { all: items.length, active: items.length }, items, machines, ...extra });

  async function mountSessions(answer: (route: string) => unknown) {
    const sheet = new ElementoFalso('link');
    sheet.setAttribute('data-screen', 'sessions');
    Object.assign(sheet, { loaded: Promise.resolve() });
    documentoFalso.head.append(sheet);
    const f = context((route) => (route.endsWith('/messaging') ? { available: false, reason: 'no_live_process' } : answer(route)));
    const area = new ElementoFalso('main');
    const cleanup = await sessions.mount(area, f.ctx);
    return { f, area, cleanup };
  }

  test('with only this machine: the status pills where they were, no Máquina, no Status label, no tag', async () => {
    setUrl('/ui/sessions');
    const { f, area, cleanup } = await mountSessions(() => list([row('s1', { machine: { id: 'local', label: 'Esta máquina' } })], onlyLocal));
    assert.match(f.routes[0]!, /^\/api\/sessions\?.*&machine=all$/);
    assert.equal(all(area, '.mf-filter').length, 0);
    assert.equal(all(area, '.sessions-filter-label').length, 0);
    assert.equal(all(area, '.mf-tag').length, 0);
    assert.equal(texto(one(area, '.sub')), '1 sessão registrada');
    cleanup();
    f.leave.abort();
  });

  test('with a remote: Máquina and Status share a row; the tag on the remote row only; its link and open action; "· 1 na Workstation"', async () => {
    setUrl('/ui/sessions?status=active');
    const { f, area, cleanup } = await mountSessions(() =>
      list([row('s3', { machine: { id: 'local', label: 'Esta máquina' } }), row('s3', { machine: WS, open: { target: 'remote', command: null } })], machinesUp, { registered: 3, byMachine: [{ id: 'local', registered: 2, total: 1 }, { id: 'ws', registered: 1, total: 1 }] }),
    );
    try {
      assert.match(f.routes[0]!, /status=active.*&machine=all$/);
      const machineRow = one(area, '.sessions-machine-row')!;
      assert.ok(one(machineRow, '.mf-filter'));
      assert.equal(texto(one(machineRow, '.sessions-filter-label')), 'Status');
      assert.ok(one(machineRow, '.seg'), 'the status pills moved into the row');
      assert.equal(texto(one(area, '.sub')), '3 sessões registradas · 1 na Workstation');
      const rows = all(area, 'tr.session-row');
      assert.deepEqual(rows.map((r) => r.getAttribute('data-key')), ['local:s3', 'ws:s3']);
      assert.equal(all(rows[0]!, '.mf-tag').length, 0);
      assert.equal(texto(one(rows[1]!, '.mf-tag')), 'Workstation');
      assert.equal(one(rows[1]!, '.nm a')!.getAttribute('href'), '/ui/sessions/s3?machine=ws');
      assert.equal(one(rows[1]!, '.sessions-open button')!.getAttribute('aria-disabled'), 'true');
      assert.equal(texto(one(rows[1]!, 'td.msg')), '', 'no "Mandar mensagem" for a remote session');
      await tick();
      assert.equal(f.routes.filter((r) => r.endsWith('/messaging')).length, 1, 'only the local row asks for its availability');

      one(area, '.mf-seg button[data-machine="local"]')!.click();
      // The pressed segment changes at once, before the read comes back.
      assert.equal(one(area, '.mf-seg button[aria-pressed="true"]')!.getAttribute('data-machine'), 'local');
      await until(() => f.routes.some((r) => r.endsWith('&machine=local')), 'the local read');
      assert.equal(page.search, '?status=active&machine=local', 'the other filters stay in the URL');
    } finally {
      cleanup();
      f.leave.abort();
    }
  });

  test('an empty list with Todas and a remote names both machines, not only this one', async () => {
    setUrl('/ui/sessions');
    const { f, area, cleanup } = await mountSessions(() => list([], machinesUp));
    try {
      assert.match(texto(area), /As sessões do Claude Code das duas máquinas aparecem aqui/);
      assert.doesNotMatch(texto(area), /desta máquina aparecem/);
      assert.equal(sessions.registeredText({ registered: 2 }, { choice: 'ws', machines: mf.normalizeMachines(machinesUp) }), '2 sessões registradas na Workstation');
      assert.equal(sessions.registeredText({ registered: 1 }, { choice: 'local', machines: mf.normalizeMachines(machinesUp) }), '1 sessão registrada nesta máquina');
    } finally {
      cleanup();
      f.leave.abort();
    }
  });

  test('C48: the notice above the filters, the pill counts of the chosen machine, and an empty list with the notice when the remote is chosen', async () => {
    setUrl('/ui/sessions?machine=ws');
    const { f, area, cleanup } = await mountSessions((route) => (route === '/api/machines' ? machinesDown : list([], [machinesDown[1]])));
    try {
      await until(() => all(area, '.mf-seg button').length === 3, 'the segments');
      assert.equal(all(area, '.mf-notice').length, 1);
      assert.equal(all(area, '.error-band').length, 0);
      assert.equal(all(area, '.sessions-body .state').length, 0, 'the empty list says nothing more than the notice');
      assert.equal(area.childNodes.indexOf(one(area, '.mf-notices')!), 1, 'the notice right under the header');
    } finally {
      cleanup();
      f.leave.abort();
    }
  });
});

describe('Histórico, Feed and Dashboard with every machine (C47)', () => {
  test('Histórico: the tag on the remote row, its link with ?machine=, keys by machine + id', async () => {
    setUrl('/ui/history');
    const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Sessão ${id}`, status: 'completed', project: 'p', model: 'Opus 5.5', durationMs: 1000, costUsd: 1, ...extra });
    const f = context(() => ({ days: [{ day: '2026-10-22', sessions: [s('s1'), s('s1', { machine: WS, previous: { id: 's0', title: 'Antes' } })] }], next: null, machines: machinesUp }));
    const area = new ElementoFalso('main');
    history.mount(area, f.ctx);
    await until(() => all(area, '.hist-row').length === 2, 'the rows');
    assert.equal(f.routes[0], '/api/history?days=7&machine=all');
    const [local, remote] = all(area, '.hist-row');
    assert.equal(all(local!, '.mf-tag').length, 0);
    assert.equal(texto(one(remote!, '.mf-tag')), 'Workstation');
    assert.equal(one(remote!, 'a.hist-target')!.getAttribute('href'), '/ui/sessions/s1?machine=ws');
    assert.equal(one(remote!, 'a.hist-previous')!.getAttribute('href'), '/ui/sessions/s0?machine=ws');
    assert.equal(all(area, '.hist-machines .mf-filter').length, 1);
    assert.deepEqual(history.appendDays([{ day: 'd', sessions: [s('s1')] }], [{ day: 'd', sessions: [s('s1', { machine: WS }), s('s1')] }])[0].sessions.length, 2);
    f.leave.abort();
  });

  test('Feed: the tag opens the path (Workstation › projeto › sessão › agente) and the row opens the remote Detail', async () => {
    setUrl('/ui/feed');
    const event = (id: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: '2026-10-22T23:00:00Z', type: 'PreToolUse', status: 'active', summary: 'Bash', tool: 'Bash', session: { id: 's1', title: 'Sessão s1', project: 'projeto' }, agent: { name: 'main', id: 'a1' }, ...extra });
    const f = context(() => ({ events: [event('e1', { machine: WS }), event('e1')], cursor: 'c', older: null, options: { types: [], tools: [], sessions: [] }, machines: machinesUp }));
    const area = new ElementoFalso('main');
    const cleanup = await feed.mount(area, f.ctx);
    try {
      const items = all(area, '.feed-item');
      assert.deepEqual(items.map((i) => i.getAttribute('data-key')), ['ws:e1', 'local:e1']);
      assert.equal(texto(one(items[0]!, '.feed-trail')), 'Workstation › projeto › Sessão s1 › principal');
      assert.equal(all(items[1]!, '.mf-tag').length, 0);
      assert.equal(one(items[0]!, 'a.feed-session')!.getAttribute('href'), '/ui/sessions/s1?machine=ws');
      assert.equal(one(items[1]!, 'a.feed-session')!.getAttribute('href'), '/ui/sessions/s1');
    } finally {
      cleanup();
      f.leave.abort();
    }
  });

  test('Dashboard: with Todas, the numbers say how many are the remote\'s; with one machine chosen, they do not', () => {
    const numbers = { sessions: { total: 15, active: 3, blocked: 5, idle: 0 }, agents: { active: 4, sessions: 4 }, subagents: { active: 0, sessions: 0 }, events: { today: 0, lastHour: 0, total: 0 }, cost: { usd: 1, days: 30, unpriced: [] } };
    const byMachine = [{ id: 'local', numbers: { sessions: { total: 12 }, agents: { active: 3 } } }, { id: 'ws', numbers: { sessions: { total: 3 }, agents: { active: 1 } } }];
    const c = dashboard.cards(numbers, { byMachine, machines: mf.normalizeMachines(machinesUp) });
    assert.equal(c[0].sub, '3 na Workstation · 5 precisam de você');
    assert.equal(c[1].sub, 'em 4 sessões · 1 na Workstation');
    assert.equal(dashboard.cards(numbers)[0].sub, '5 precisam de você');
  });

  test('Dashboard: the recent activity row of a remote session has only the icon, and opens the remote Detail', async () => {
    setUrl('/ui');
    const numbers = { sessions: { total: 1, active: 1, blocked: 0, idle: 0 }, agents: { active: 0, sessions: 0 }, subagents: { active: 0, sessions: 0 }, events: { today: 0, lastHour: 0, total: 0 }, cost: { usd: 0, days: 30, unpriced: [] } };
    const activity = [{ session: 's1', status: 'active', attention: null, text: 'Bash', project: 'p', at: '2026-10-22T23:00:00Z', machine: WS }];
    const f = context((route) => (route.startsWith('/api/dashboard') ? { numbers, agents: [], activity, machines: machinesUp, byMachine: [] } : { items: [] }));
    const area = new ElementoFalso('main');
    const cleanup = await dashboard.mount(area, f.ctx);
    try {
      assert.equal(f.routes[0], '/api/dashboard?machine=all');
      const r = one(area, 'a.row')!;
      assert.equal(r.getAttribute('href'), '/ui/sessions/s1?machine=ws');
      assert.equal(one(r, '.mf-tag')!.getAttribute('title'), 'Workstation');
      assert.equal(texto(one(r, '.mf-tag')), '');
      assert.equal(all(area, '.mf-row .mf-filter').length, 1);
    } finally {
      cleanup();
      f.leave.abort();
    }
  });
});

// ---------- One clock per screen ----------

describe('the filter adds no second clock to a screen that has its own', () => {
  /** Mounts with `setInterval` watched: the delays of every interval the mount starts. */
  async function intervalsOf(mount: () => Promise<unknown>) {
    const real = globalThis.setInterval;
    const delays: number[] = [];
    globalThis.setInterval = ((f: () => void, ms: number) => (delays.push(ms), real(f, ms))) as typeof setInterval;
    try {
      await mount();
    } finally {
      globalThis.setInterval = real;
    }
    return delays;
  }
  const numbers = { sessions: { total: 1, active: 1, blocked: 0, idle: 0 }, agents: { active: 0, sessions: 0 }, subagents: { active: 0, sessions: 0 }, events: { today: 0, lastHour: 0, total: 0 }, cost: { usd: 0, days: 30, unpriced: [] } };

  test('Dashboard: one 30 s re-read (its own), and one re-read for a machine change, not two', async () => {
    setUrl('/ui');
    const f = context((route) => (route.startsWith('/api/dashboard') ? { numbers, agents: [], activity: [], machines: machinesUp, byMachine: [] } : { items: [] }));
    const area = new ElementoFalso('main');
    let cleanup: (() => void) | undefined;
    const delays = await intervalsOf(async () => (cleanup = (await dashboard.mount(area, f.ctx)) as () => void));
    try {
      assert.deepEqual(delays.filter((d) => d === mf.REMOTE_REREAD_MS), [30_000], 'only the Dashboard\'s own background re-read');
      const before = f.routes.filter((r) => r.startsWith('/api/dashboard')).length;
      f.change([{ type: 'alert', key: 'ws:machine-unreachable' }]);
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(f.routes.filter((r) => r.startsWith('/api/dashboard')).length, before + 1);
    } finally {
      cleanup?.();
      f.leave.abort();
    }
  });

  test('Feed: no 30 s timer of the filter beside the feed\'s own clock', async () => {
    setUrl('/ui/feed');
    const f = context(() => ({ events: [], cursor: 'c', older: null, options: { types: [], tools: [], sessions: [] }, machines: machinesUp }));
    const area = new ElementoFalso('main');
    let cleanup: (() => void) | undefined;
    const delays = await intervalsOf(async () => (cleanup = (await feed.mount(area, f.ctx)) as () => void));
    try {
      assert.equal(delays.filter((d) => d === mf.REMOTE_REREAD_MS).length, 0);
      assert.equal(all(area, '.mf-filter').length, 1);
    } finally {
      cleanup?.();
      f.leave.abort();
    }
  });

  test('Mural uses one discovery clock even while a remote is known', async () => {
    setUrl('/ui/wall');
    const f = context(() => ({ count: {}, cards: [], machines: machinesUp }));
    const delays = await intervalsOf(() => wall.mount(new ElementoFalso('main'), f.ctx));
    f.leave.abort();
    assert.deepEqual(delays.filter((d) => d === mf.REMOTE_REREAD_MS), [30_000]);
  });
});

// ---------- C49: the Detail of a remote session ----------

describe('the Detail of a remote session (C49)', () => {
  const head = {
    session: { id: 's1', title: 'Migração do esquema', status: 'active', attention: null, startedAt: '2026-10-22T22:41:00Z', since: '2026-10-22T22:41:00Z', model: 'claude-opus-5-5', cwd: '/simulacao/motor-de-regras', banner: null },
    counts: { agents: 1, events: 10 },
    cost: { usd: 2.1 },
    branch: 'feat/58-pedidos',
    open: { target: 'remote', command: null },
    local: null,
    opensSession: false,
    machine: WS,
  };
  const conversation = { agent: 'main', agents: [{ id: 'main', name: 'Agente principal' }], total: 0, messages: [] };
  const decisions = {
    session: 's1',
    total: 1,
    items: [{ id: 'd1', label: 'D1', title: 'Usar fila', state: 'current', origin: 'session', decidedAt: '2026-10-22T22:50:00Z', sessionId: 's1', conversation: '/ui/sessions/s1', rejected: [], promotedTo: null }],
    injection: { enabled: false, scope: 'session', decisions: 1, tokens: 10, text: '' },
    mcp: { call: 'decisions()', tool: 'decisions', response: 'x', exists: true },
  };
  const down = Object.assign(new Error('machine-unreachable'), { name: 'ReadError', status: 503, body: { error: 'machine-unreachable', machine: { id: 'ws', label: 'Workstation', state: 'unreachable', lastReadAt: '2026-10-22T22:41:00Z' } } });

  function answer(route: string, failing: { on: boolean }) {
    if (failing.on) return down;
    const path = route.split('?')[0];
    if (path === '/api/sessions/s1') return head;
    if (path === '/api/sessions/s1/conversation') return conversation;
    if (path === '/api/sessions/s1/decisions') return decisions;
    return new Error(`unexpected ${route}`);
  }

  test('every read goes with ?machine=; the chip, the source line, the open action off and the compose box off without asking this core', async () => {
    setUrl('/ui/sessions/s1?machine=ws#conversation');
    const failing = { on: false };
    const f = context((r) => answer(r, failing), { id: 's1' });
    const area = new ElementoFalso('main');
    const stop = await detail.mount(area, f.ctx);
    try {
      await until(() => !!one(area, '.sm-compose'), 'the compose box');
      assert.deepEqual(f.routes, ['/api/sessions/s1?machine=ws', '/api/sessions/s1/conversation?machine=ws']);
      assert.match(texto(one(area, '.sd-pills')), /Workstation$/, 'the machine chip');
      assert.match(texto(one(area, '.sd-source')), /^Lida do núcleo da Workstation, pelo túnel · há \d+ s$/);
      const open = one(area, '.sd-open button')!;
      assert.equal(open.getAttribute('aria-disabled'), 'true');
      assert.match(texto(one(area, '.sd-open')), /roda em Workstation/);
      const box = one(area, '.sm-compose')!;
      assert.ok(box.classList.contains('sm-off'));
      assert.match(texto(box), /A sessão roda em outra máquina\./);
      assert.ok(!f.routes.some((r) => r.includes('/messaging')), 'no availability is read for a remote session');

      // The decisions: read with ?machine=, Promover a registro off, and nothing written here.
      one(area, '.sd-tab[data-tab="decisions"]')!.click();
      await until(() => !!one(area, '.dec-card'), 'the decisions');
      assert.ok(f.routes.includes('/api/sessions/s1/decisions?scope=session&machine=ws'));
      const promote = all(area, '.dec-card button').find((b) => texto(b) === 'Promover a registro')!;
      assert.equal(promote.getAttribute('disabled'), '');
      promote.click();
      assert.equal(all(documentoFalso.head, '.dec-dlg').length + all(area, '.dec-dlg').length, 0);
      assert.equal(one(area, '.dec-card a.dec-link')!.getAttribute('href'), '/ui/sessions/s1?machine=ws');
      assert.match(texto(area), /Desligado nesta sessão: ela roda em outra máquina/);
      assert.equal(page.search, '?machine=ws', 'switching tabs keeps the machine in the URL');
      assert.deepEqual(f.writes, []);

      // The remote stops answering: the last read stays, under the neutral notice.
      failing.on = true;
      one(area, '.sd-refresh')!.click();
      await until(() => !!one(area, '.mf-notice'), 'the notice');
      assert.equal(texto(one(area, 'h1')), 'Migração do esquema');
      assert.ok(one(area, '.dec-card'), 'the tab keeps what it showed');
      assert.equal(all(area, '.error-band').length, 0);
      assert.match(texto(one(area, '.mf-notice')), /^Workstation sem conexão desde/);

      // It comes back: the notice goes.
      failing.on = false;
      one(area, '.sd-refresh')!.click();
      await until(() => one(area, '.sd-machine-notice')!.hidden === true, 'the notice to go');
    } finally {
      f.leave.abort();
      stop?.();
    }
  });

  test('a 503 before anything was read: the notice is the state', async () => {
    setUrl('/ui/sessions/s1?machine=ws');
    const f = context(() => down, { id: 's1' });
    const area = new ElementoFalso('main');
    const stop = await detail.mount(area, f.ctx);
    try {
      assert.equal(all(area, '.mf-notice').length, 1);
      assert.equal(all(area, '.state').length, 0);
      assert.equal(one(area, '.mf-notice a')!.getAttribute('href'), '/ui/machines/ws');
      // A retry (the 30 s one, or the core reconnecting) keeps the notice while it reads.
      f.restart();
      assert.equal(all(area, '.mf-notice').length, 1);
      assert.equal(all(area, '.loading').length, 0);
      await tick();
      assert.equal(all(area, '.mf-notice').length, 1);
    } finally {
      f.leave.abort();
      stop?.();
    }
  });

  test('remoteDetailContext: only the routes under the session get ?machine=, writes are refused, a 503 on a route that answered keeps it quiet', async () => {
    const routes: string[] = [];
    let fail = false;
    const ctx = detail.remoteDetailContext({ read: async (r: string) => (routes.push(r), fail ? Promise.reject(down) : {}), write: async () => ({}) }, '/api/sessions/s1', 'ws');
    await ctx.read('/api/sessions/s1/events?limit=50');
    await ctx.read('/api/overview');
    assert.deepEqual(routes, ['/api/sessions/s1/events?limit=50&machine=ws', '/api/overview']);
    await assert.rejects(ctx.write('/api/decisions/d1/promote', {}), /outra máquina/);
    fail = true;
    await assert.rejects(ctx.read('/api/sessions/s1/events?limit=100'), (e: Error) => e.name === 'AbortError');
    await assert.rejects(ctx.read('/api/sessions/s1/workflow'), /Workstation sem conexão/);
  });

  test('a local session keeps its URLs and reads without machine', async () => {
    setUrl('/ui/sessions/s1#conversation');
    const f = context((r) => (r.includes('/messaging') ? { available: false, reason: 'no_live_process' } : answer(r, { on: false })), { id: 's1' });
    const area = new ElementoFalso('main');
    const stop = await detail.mount(area, f.ctx);
    try {
      await until(() => f.routes.includes('/api/sessions/s1/conversation'), 'the conversation');
      assert.ok(!f.routes.some((r) => r.includes('machine=')));
      assert.equal(all(area, '.sd-source').length, 0);
    } finally {
      f.leave.abort();
      stop?.();
    }
  });
});
