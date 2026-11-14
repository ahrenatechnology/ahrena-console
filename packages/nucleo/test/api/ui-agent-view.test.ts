// End-to-end skeleton of the agent view (#521, parent #518); data from #529.
// The components layer (#538) turned the Agents tab row and loop node tests green; the state layer (#539) turned every scenario that
// mounts the screen over a fake read in the shape of #529 green; the contract layer (#540) registers the route, reads the core's
// own route and turns the last scenario and the page-level accessibility check green: no `todo` is left.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const SID = 'c3f09b52-4e10';
const BASE = `/api/sessions/${SID}`;
const ORIGIN = 'http://127.0.0.1:8787';
const ATHENA = 'agent-athena';
const IRIS = 'agent-iris:abc1'; // an agent id has ":" in it: the route carries it encoded (#521)

const page = { pathname: `/ui/sessions/${SID}`, search: '', hash: '#agents', origin: ORIGIN, href: `${ORIGIN}/ui/sessions/${SID}#agents` };
Object.assign(globalThis, { location: page, history: { state: null, replaceState: () => {}, pushState: () => {}, back: () => {} } });

const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const agentRow = (id: string, type: string, parent: string | null, extra = {}) => ({
  id, type: id === 'main' ? 'main' : 'subagent', name: type, agentType: type, description: `descrição de ${type}`, parent,
  task: 'resumo', model: 'm', status: 'completed', start: iso(30), end: iso(10), costUsd: 0.41, turns: null, ...extra,
});
const AGENTS_LIST = {
  numbers: { events: 9, perMinute: 1, tools: 4, uniqueTools: 2, subagents: 3, compactions: 0, errors: 0, durationMin: 30, running: false },
  tools: [], tasks: null, tokens: null,
  agents: [agentRow('main', 'principal', null), agentRow(ATHENA, 'athena', 'main'), agentRow(IRIS, 'iris', ATHENA), agentRow('agent-erodos', 'erodos', IRIS)],
};

const lines = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n');
// The shape of #529 (docs/contracts/agent-view.md): `agentId`, `start`/`end`, steps with `id`/`start`/`end`/`childAgentId`.
const step = (i: number, extra = {}) => ({ id: `toolu_${i}`, kind: 'tool', name: 'Read', summary: `arquivo ${i}`, state: 'ok', start: iso(30 - i), end: iso(29 - i), childAgentId: null, ...extra });
const view = (extra = {}) => ({
  agentId: ATHENA, agentType: 'athena', description: 'planeja a issue', brief: 'Planeje a issue 521.', briefTruncated: false, spawnedByToolUseId: 'toolu_main',
  steps: [step(1), { id: 'toolu_iris', kind: 'agent', name: 'Agent', summary: 'iris', state: 'ok', start: iso(28), end: iso(20), childAgentId: IRIS }, step(3)],
  result: 'Camadas ordenadas.', resultTruncated: false, costUsd: 0.41, costNote: null, totalCostUsd: 0.41, state: 'completed', start: iso(30), end: iso(10), ...extra,
});

interface Served { [route: string]: unknown }
function ctxFor(served: Served, params: Record<string, string> = { id: SID }, calls: string[] = []) {
  const leave = new AbortController();
  const listeners: Array<() => void> = [];
  const navigated: string[] = [];
  const read = async (r: string) => {
    calls.push(r);
    const v = served[r];
    if (v instanceof Error) throw v;
    if (typeof v === 'function') return (v as () => unknown)();
    if (v === undefined) throw Object.assign(new Error(`not served: ${r}`), { name: 'ReadError' });
    return v;
  };
  const ctx = { params, signal: leave.signal, read, write: async () => ({}), navigate: (r: string) => void navigated.push(r), counter: () => {}, title: () => {}, onChange: (f: () => void) => void listeners.push(f), onRestart: () => {}, liveState: () => 'live' };
  return { ctx, leave, navigated, change: () => listeners.forEach((f) => f()), calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

// @ts-expect-error: browser module, plain JavaScript
const registry = await import('../../ui/screens.js');

async function mountAgentView(served: Served, calls: string[] = []) {
  // The import sits in the body so a missing module turns the scenario red, not the whole file. (#521)
  const mod = await import('../../ui/screens/agent-view.js' as string);
  const c = ctxFor(served, { id: SID, agentId: ATHENA }, calls);
  const area = new ElementoFalso('main');
  await mod.mount(area, c.ctx);
  await settle();
  return { area, ...c };
}

async function mountAgentsTab(extraServed: Served = {}, machine: string | null = null) {
  // @ts-expect-error: browser module, plain JavaScript
  const detail = await import('../../ui/screens/session-detail.js');
  const served: Served = {
    [BASE]: { session: { id: `${SID}-0`, title: 'S', status: 'active', attention: null, model: 'm', startedAt: iso(30), since: iso(1), cwd: null, banner: null, identity: null }, endedAt: null, cost: null, branch: null, machine: null, open: null, counts: { agents: 4, events: 9 } },
    [`${BASE}/messaging`]: { available: false, reason: null, processes: 0 },
    [`${BASE}/transcription`]: {},
    [`${BASE}/agents`]: AGENTS_LIST,
    ...extraServed,
  };
  // A remote session reads every route of its own with `machine=<id>` (#540).
  if (machine) for (const k of Object.keys(served)) (served[`${k}?machine=${machine}`] = served[k]), delete served[k];
  const c = ctxFor(served);
  const area = new ElementoFalso('main');
  await detail.mount(area, c.ctx);
  await settle();
  c.leave.abort();
  return { area, ...c };
}

describe('AC-1: the Agents tab rows lead to the agent view (issue 521)', () => {
  test('a subagent row is a real link to /ui/sessions/<id>/agents/<agentId>', async () => {
    const { area } = await mountAgentsTab();
    const rows = area.querySelectorAll('.sd-node').filter((r) => r.getAttribute('data-agent') !== 'main');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.tagName === 'A' && r.hasAttribute('href')), 'every subagent row is an <a href>');
    assert.equal(rows.find((r) => texto(r).includes('iris'))!.getAttribute('href'), `/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
  });

  test('the link is reachable by keyboard and has a name that says where it goes', async () => {
    const { area } = await mountAgentsTab();
    const link = area.querySelectorAll('a.sd-node')[0]!;
    assert.notEqual(link.getAttribute('tabindex'), '-1');
    assert.match(link.getAttribute('aria-label') ?? '', /Abrir a vista de/);
    link.focus();
    assert.equal(documentoFalso.activeElement, link);
  });

  test('the main agent row is not a link, and the rows are indented by parent', async () => {
    const { area } = await mountAgentsTab();
    const rows = area.querySelectorAll('.sd-node');
    const main = rows.find((r) => r.getAttribute('data-agent') === 'main')!;
    assert.notEqual(main.tagName, 'A');
    assert.equal(main.hasAttribute('href'), false);
    const depth = (id: string) => Number(rows.find((r) => r.getAttribute('data-agent') === id)!.getAttribute('data-depth'));
    assert.deepEqual([depth('main'), depth(ATHENA), depth(IRIS), depth('agent-erodos')], [0, 1, 2, 3]);
  });

  test('Back returns focus to the row the person came from', async () => {
    Object.assign(history, { state: { focusAgent: IRIS } });
    try {
      const { area } = await mountAgentsTab();
      const row = area.querySelectorAll('a.sd-node').find((r) => r.getAttribute('href')!.endsWith(encodeURIComponent(IRIS)))!;
      assert.equal(documentoFalso.activeElement, row);
    } finally {
      Object.assign(history, { state: null });
    }
  });
});

describe('the route of the agent view (issue 521)', () => {
  test('/ui/sessions/<id>/agents/<agentId> is the agent view screen, with the agent id decoded', () => {
    const found = registry.findScreen(`/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    assert.equal(found?.screen.file, '/ui/screens/agent-view.js');
    assert.deepEqual(found.params, { id: SID, agentId: IRIS });
    assert.equal(found.screen.highlights, 'sessions');
  });

  test('the session route and the shape of a bad agent id stay as they were (#540)', () => {
    assert.equal(registry.findScreen(`/ui/sessions/${SID}`)?.screen.file, '/ui/screens/session-detail.js');
    assert.equal(registry.findScreen(`/ui/sessions/${SID}/agents`), null);
    assert.equal(registry.findScreen(`/ui/sessions/${SID}/agents/a%2Fb`), null, 'an encoded slash is no agent id');
    assert.equal(registry.findScreen(`/ui/sessions/${SID}/agents/%E0%A4%A`), null, 'an id that does not decode is no route');
  });
});

describe('AC-1 (#540): the view reads the core route of the contract', () => {
  const body = (status: number, json: unknown) => ({ ok: status < 400, status, headers: new Headers(), json: async () => json });
  async function mountOverHttp(respond: (url: URL) => ReturnType<typeof body>) {
    // @ts-expect-error: browser module, plain JavaScript
    const { httpReader } = await import('../../ui/api.js');
    const urls: string[] = [];
    const fetch = async (url: URL) => (urls.push(url.pathname + url.search), respond(url));
    const reader = httpReader({ base: ORIGIN, fetch });
    const mod = await import('../../ui/screens/agent-view.js' as string);
    const found = registry.findScreen(`/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    const c = ctxFor({}, found.params);
    const area = new ElementoFalso('main');
    await mod.mount(area, { ...c.ctx, read: (r: string) => reader(r, { signal: c.ctx.signal }) });
    await settle();
    return { area, urls };
  }

  test('GET /api/sessions/<id>/agents/<agentId>, the id encoded, and the answer is drawn', async () => {
    const { area, urls } = await mountOverHttp(() => body(200, view({ agentId: IRIS, agentType: 'iris', description: 'frontend', brief: 'Escreva a camada.' })));
    assert.deepEqual(urls, [`${BASE}/agents/${encodeURIComponent(IRIS)}`]);
    assert.equal(texto(area.querySelector('.av-kind')), 'iris');
    assert.match(texto(area.querySelector('.av-brief')), /Escreva a camada\./);
  });

  test('404 agent_not_found shows the missing state, and any other failure the error with a retry', async () => {
    const missing = await mountOverHttp(() => body(404, { error: 'Agente desconhecido', code: 'agent_not_found' }));
    assert.ok(missing.area.querySelector('.av-missing'), 'missing state');
    const down = await mountOverHttp(() => body(500, { error: 'falhou' }));
    assert.ok(down.area.querySelector('[role="alert"]'), 'error state');
    assert.ok(down.area.querySelectorAll('button').some((b) => texto(b) === 'Tentar de novo'));
  });
});

describe('AC-2 (#540): the Agents tab rows use agentType, description and parent of the core list', () => {
  const rowsOf = (area: ElementoFalso) => area.querySelectorAll('.sd-node');
  const listWith = (agents: unknown[]) => ({ ...AGENTS_LIST, agents });

  test('a row is named by its agentType and describes what it was asked, not the stored name', async () => {
    const list = listWith([
      agentRow('main', 'principal', null),
      agentRow(`${SID}:a1`, 'x', 'main', { name: 'Plan the cut of issue 521', agentType: 'ahrena-engineering-development:athena', description: 'planeja a issue' }),
    ]);
    const { area } = await mountAgentsTab({ [`${BASE}/agents`]: list });
    const row = rowsOf(area).find((r) => r.getAttribute('data-agent') === 'a1')!;
    assert.equal(texto(row.querySelector('b')), 'Athena');
    assert.match(texto(row.querySelector('small')), /ahrena-engineering-development:athena/);
    assert.match(texto(row.querySelector('small')), /planeja a issue/);
    assert.equal(row.getAttribute('aria-label'), 'Abrir a vista de Athena');
    assert.equal(row.getAttribute('href'), `/ui/sessions/${SID}/agents/a1`);
  });

  test('with no agentType the row falls back to the description, then to the stored name', async () => {
    const list = listWith([
      agentRow('main', 'principal', null),
      agentRow(`${SID}:b1`, 'x', 'main', { name: 'stored name', agentType: null, description: 'what it was asked' }),
      agentRow(`${SID}:b2`, 'x', 'main', { name: 'stored name', agentType: null, description: null }),
    ]);
    const { area } = await mountAgentsTab({ [`${BASE}/agents`]: list });
    const title = (id: string) => texto(rowsOf(area).find((r) => r.getAttribute('data-agent') === id)!.querySelector('b'));
    assert.equal(title('b1'), 'what it was asked');
    assert.equal(title('b2'), 'stored name');
    // the title already says the description: the subtitle does not repeat it (#540)
    const subtitle = (id: string) => texto(rowsOf(area).find((r) => r.getAttribute('data-agent') === id)!.querySelector('small'));
    assert.equal(subtitle('b1').split('what it was asked').length - 1, 0, 'the description is not repeated in the subtitle');
  });

  test('the rows are indented by parent, and the main row keeps its name', async () => {
    const list = listWith([
      agentRow('main', 'principal', null),
      agentRow(`${SID}:p`, 'athena', 'main'),
      agentRow(`${SID}:q`, 'iris', `${SID}:p`),
    ]);
    const { area } = await mountAgentsTab({ [`${BASE}/agents`]: list });
    const depth = (id: string) => rowsOf(area).find((r) => r.getAttribute('data-agent') === id)!.getAttribute('data-depth');
    assert.deepEqual([depth('main'), depth('p'), depth('q')], ['0', '1', '2']);
    assert.equal(texto(rowsOf(area)[0]!.querySelector('b')), 'principal');
  });
});

describe('AC-1 (#540): a remote session keeps its machine through the agent view', () => {
  const MACHINE = 'workstation';
  const withSearch = async (search: string, run: () => Promise<void>) => {
    const before = page.search;
    page.search = search;
    try {
      await run();
    } finally {
      page.search = before;
    }
  };
  const tabHref = `/ui/sessions/${SID}?machine=${MACHINE}#agents`;

  test('a remote row carries ?machine= on its href, and a local one does not', async () => {
    await withSearch(`?machine=${MACHINE}`, async () => {
      const { area } = await mountAgentsTab({}, MACHINE);
      const hrefs = area.querySelectorAll('a.sd-node').map((r) => r.getAttribute('href'));
      assert.equal(hrefs.length, 3);
      assert.ok(hrefs.every((h) => h!.endsWith(`?machine=${MACHINE}`)), `every row keeps the machine: ${hrefs.join(', ')}`);
    });
    const local = await mountAgentsTab();
    assert.ok(local.area.querySelectorAll('a.sd-node').every((r) => !r.getAttribute('href')!.includes('machine')));
  });

  test('the view reads the agent and a child opened in line with ?machine=', async () => {
    await withSearch(`?machine=${MACHINE}`, async () => {
      const iris = `${BASE}/agents/${encodeURIComponent(IRIS)}?machine=${MACHINE}`;
      const { area, calls } = await mountAgentView({ [`${BASE}/agents/${ATHENA}?machine=${MACHINE}`]: view(), [iris]: view({ agentId: IRIS, agentType: 'iris', steps: [step(1)] }) });
      assert.deepEqual(calls, [`${BASE}/agents/${ATHENA}?machine=${MACHINE}`]);
      area.querySelectorAll('.av-step')[1]!.querySelector('button')!.click();
      await settle();
      assert.ok(calls.includes(iris), 'the child is read from the same machine');
      const open = area.querySelector('a.av-open-view')!;
      assert.equal(open.getAttribute('href'), `/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}?machine=${MACHINE}`);
    });
  });

  test('Back and the crumb keep the machine, and a local view reads without it', async () => {
    await withSearch(`?machine=${MACHINE}`, async () => {
      const mod = await import('../../ui/screens/agent-view.js' as string);
      const c = ctxFor({ [`${BASE}/agents/${ATHENA}?machine=${MACHINE}`]: view() }, { id: SID, agentId: ATHENA });
      const area = new ElementoFalso('main');
      const shell: Array<[string, unknown]> = [];
      await mod.mount(area, { ...c.ctx, navigate: (r: string, state: unknown) => void shell.push([r, state]) });
      await settle();
      assert.ok(area.querySelector(`a.av-crumb-link[href="/ui/sessions/${SID}?machine=${MACHINE}"]`), 'the Session crumb keeps ?machine=');
      area.querySelector(`a.av-crumb-link[href="${tabHref}"]`)!.dispatchEvent({ type: 'click', button: 0 } as never);
      assert.deepEqual(shell, [[tabHref, { focusAgent: ATHENA }]]);
    });
    const calls: string[] = [];
    await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() }, calls);
    assert.deepEqual(calls, [`${BASE}/agents/${ATHENA}`]);
  });
});

describe('AC-4 and AC-5 (#540): the assembled page', () => {
  type Node = ElementoFalso;
  /** The elements the keyboard reaches, in document order: a link with an href and an enabled button, never tabindex -1. (#540) */
  const tabOrder = (root: Node): Node[] => {
    const out: Node[] = [];
    const walk = (n: Node) => {
      for (const c of n.children) {
        const reachable = (c.tagName === 'A' && c.hasAttribute('href')) || (c.tagName === 'BUTTON' && !c.hasAttribute('disabled'));
        if (reachable && c.getAttribute('tabindex') !== '-1') out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  };
  const nameOf = (n: Node) => (n.getAttribute('aria-label') ?? texto(n)).trim();

  test('the Agents tab: each subagent row is reachable by keyboard in the drawn order, with a name', async () => {
    const { area } = await mountAgentsTab();
    const order = tabOrder(area).filter((n) => n.classList.contains('sd-node'));
    assert.deepEqual(order.map((n) => n.getAttribute('data-agent')), [ATHENA, IRIS, 'agent-erodos']);
    for (const n of tabOrder(area)) assert.notEqual(nameOf(n), '', 'every reachable control has a name');
    assert.ok(tabOrder(area).every((n) => Number(n.getAttribute('tabindex') ?? 0) <= 0), 'no positive tabindex');
  });

  test('the agent view: Back comes before the steps, every control has a name and the landmarks are there', async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    const order = tabOrder(area);
    const back = order.findIndex((n) => n.getAttribute('href') === `/ui/sessions/${SID}#agents`);
    const firstStep = order.findIndex((n) => area.querySelectorAll('.av-step').some((s) => s.contains(n)));
    assert.ok(back >= 0 && firstStep > back, 'Back (the Agents crumb) is reached before the first step');
    for (const n of order) assert.notEqual(nameOf(n), '', 'every reachable control has a name');
    const nav = area.querySelector('nav')!;
    assert.ok(nav.getAttribute('aria-label'), 'the crumb is a named navigation landmark');
    assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(area.querySelectorAll('h2').length, 1, 'one heading for the agent');
    assert.ok(area.querySelectorAll('button').filter((b) => b.hasAttribute('aria-expanded')).length > 0, 'the toggles say whether they are open');
  });

  test('the whole path: row link, route, the view, Back with focus on the same row', async () => {
    // 1. the Agents tab; the person activates the Iris row, which marks it for Back (#540)
    let tab = await mountAgentsTab();
    const link = tab.area.querySelectorAll('a.sd-node').find((r) => texto(r).includes('iris'))!;
    link.dispatchEvent({ type: 'click', button: 0, preventDefault: () => {} } as never);
    // 2. the route of the link opens that agent's view, the id decoded (#540)
    const found = registry.findScreen(link.getAttribute('href')!.replace(/#.*$/, ''));
    assert.deepEqual(found.params, { id: SID, agentId: IRIS });
    const mod = await import('../../ui/screens/agent-view.js' as string);
    const c = ctxFor({ [`${BASE}/agents/${encodeURIComponent(IRIS)}`]: view({ agentId: IRIS, agentType: 'iris' }) }, found.params);
    const area = new ElementoFalso('main');
    const shell: Array<[string, unknown]> = [];
    await mod.mount(area, { ...c.ctx, navigate: (r: string, state: unknown) => void shell.push([r, state]) });
    await settle();
    // 3. Back asks the shell to go to the Agents tab, carrying the agent (#540)
    area.querySelector(`a.av-crumb-link[href="/ui/sessions/${SID}#agents"]`)!.dispatchEvent({ type: 'click', button: 0 } as never);
    assert.deepEqual(shell, [[`/ui/sessions/${SID}#agents`, { focusAgent: IRIS }]]);
    // 4. the tab, remounted with that state, puts the focus on the row (#540)
    Object.assign(history, { state: shell[0]![1] });
    try {
      tab = await mountAgentsTab();
      const row = tab.area.querySelectorAll('a.sd-node').find((r) => texto(r).includes('iris'))!;
      assert.equal(documentoFalso.activeElement, row);
    } finally {
      Object.assign(history, { state: null });
    }
  });
});

describe('AC-2: the populated agent view (issue 521)', () => {
  test('shows the type and description, the brief, the state, the duration and the final result', async () => {
    const { area, calls } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    assert.ok(calls.includes(`${BASE}/agents/${ATHENA}`), 'one read of the agent');
    assert.equal(texto(area.querySelector('.av-kind')), 'athena');
    assert.equal(texto(area.querySelector('.av-description')), 'planeja a issue');
    assert.match(texto(area.querySelector('.av-brief')), /Planeje a issue 521\./);
    assert.match(texto(area.querySelector('.av-state')), /Concluída/);
    assert.match(texto(area.querySelector('.av-duration')), /20 min/);
    assert.match(texto(area.querySelector('.av-result')), /Camadas ordenadas\./);
  });

  test('lists the steps in order, with the child agent nested in the call that spawned it', async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    const steps = area.querySelectorAll('.av-step');
    assert.deepEqual(steps.map((s) => s.getAttribute('data-depth')), ['0', '0', '0']);
    const child = steps[1]!;
    assert.match(texto(child), /iris/);
    assert.match(texto(child), /Abrir a vista/);
    assert.ok(child.querySelector(`a[href="/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}"]`));
  });

  test('a tool step opens its detail inline', async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    assert.equal(area.querySelectorAll('.av-step')[0]!.querySelector('.av-detail'), null);
    area.querySelectorAll('.av-step')[0]!.querySelector('button')!.click();
    assert.ok(area.querySelectorAll('.av-step')[0]!.querySelector('.av-detail'), 'the detail is inside the step, no navigation');
  });

  test('the own cost comes first, and "—" shows when no cost was measured', async () => {
    const measured = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ costUsd: 0.41 }) });
    assert.match(texto(measured.area.querySelector('.av-cost')), /^Custo ~US\$ 0,41/);
    const unmeasured = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ costUsd: null, costNote: 'no_usage', totalCostUsd: null }) });
    assert.match(texto(unmeasured.area.querySelector('.av-cost')), /^Custo —/);
    assert.match(texto(unmeasured.area.querySelector('.av-cost')), /sem custo medido/);
    assert.doesNotMatch(texto(unmeasured.area.querySelector('.av-cost')), /US\$/);
  });
});

describe('folds and elision (issue 521)', () => {
  test('the brief and the result fold at 6 lines and open on request', async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ brief: lines(10), result: lines(10) }) });
    for (const sel of ['.av-brief', '.av-result']) {
      assert.equal(area.querySelector(sel)!.getAttribute('data-folded'), 'true', `${sel} folded`);
      assert.ok(!texto(area.querySelector(sel)).includes('linha 7'), `${sel} shows only 6 lines`);
      area.querySelector(sel)!.querySelector('.av-fold')!.click();
      assert.ok(texto(area.querySelector(sel)).includes('linha 10'), `${sel} opened`);
    }
  });

  test('a brief of 6 lines or fewer has no fold', async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ brief: lines(6) }) });
    assert.equal(area.querySelector('.av-brief')!.querySelector('.av-fold'), null);
  });

  test('above 12 steps the first 5 and the last 3 stay visible, the middle is elided', async () => {
    const steps = Array.from({ length: 14 }, (_, i) => step(i + 1));
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ steps }) });
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => texto(s).match(/arquivo (\d+)/)![1]), ['1', '2', '3', '4', '5', '12', '13', '14']);
    assert.match(texto(area.querySelector('.av-elided')), /6 passos/);
    area.querySelector('.av-elided')!.querySelector('button')!.click();
    assert.equal(area.querySelectorAll('.av-step').length, 14);
  });

  test('12 steps are all shown', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(i + 1));
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ steps }) });
    assert.equal(area.querySelectorAll('.av-step').length, 12);
    assert.equal(area.querySelector('.av-elided'), null);
  });

  test('nested children keep their depth in the sequence once opened inline', async () => {
    const served = { [`${BASE}/agents/${ATHENA}`]: view(), [`${BASE}/agents/${encodeURIComponent(IRIS)}`]: view({ id: IRIS, agentType: 'iris', steps: [step(1)] }) };
    const { area } = await mountAgentView(served);
    area.querySelectorAll('.av-step')[1]!.querySelector('button')!.click();
    await settle();
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => s.getAttribute('data-depth')), ['0', '0', '1', '0']);
  });
});

describe('the states of the view: loading, error, empty (issue 521)', () => {
  test('while the read has not come back it shows the loading state', async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    const mod = await import('../../ui/screens/agent-view.js' as string);
    const c = ctxFor({ [`${BASE}/agents/${ATHENA}`]: () => pending }, { id: SID, agentId: ATHENA });
    const area = new ElementoFalso('main');
    const mounted = mod.mount(area, c.ctx);
    await settle();
    assert.ok(area.querySelector('.state.loading'), 'loading state');
    assert.equal(area.querySelector('.av-brief'), null, 'no invented brief while loading');
    release(view());
    await mounted;
  });

  test('a failed read shows the error, and "Tentar de novo" retries only the read', async () => {
    let fail = true;
    const calls: string[] = [];
    const served = { [`${BASE}/agents/${ATHENA}`]: () => { if (fail) throw Object.assign(new Error('down'), { name: 'ReadError' }); return view(); } };
    const { area, navigated } = await mountAgentView(served, calls);
    assert.ok(area.querySelector('[role="alert"]'), 'error state');
    const retry = area.querySelectorAll('button').find((b) => texto(b) === 'Tentar de novo')!;
    fail = false;
    retry.click();
    await settle();
    assert.equal(calls.filter((r) => r === `${BASE}/agents/${ATHENA}`).length, 2, 'the same read, once more');
    assert.deepEqual(calls.filter((r) => r !== `${BASE}/agents/${ATHENA}`), [], 'nothing else is read or written');
    assert.deepEqual(navigated, []);
    assert.match(texto(area.querySelector('.av-brief')), /Planeje/);
  });

  test('a failed agent shows its last error, taken from its last step in error, and the sequence it reached', async () => {
    const failing = view({ state: 'error', result: null, steps: [step(1), step(2, { state: 'error', name: 'Bash', summary: 'gh pr diff' })] });
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: failing });
    assert.match(texto(area.querySelector('.av-state')), /Com erro/);
    assert.match(texto(area.querySelector('.av-failed')), /Bash gh pr diff/);
    assert.match(texto(area.querySelector('.av-result')), /Falhou antes de devolver um resultado/);
    assert.equal(area.querySelectorAll('.av-step').length, 2);
  });

  test('an agent with no recorded data shows the empty state, not blank fields', async () => {
    const bare = view({ brief: null, steps: [], result: null, costUsd: null, costNote: 'no_usage', totalCostUsd: null, agentType: null, description: null });
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: bare });
    assert.ok(area.querySelector('.state'), 'empty state');
    assert.match(texto(area), /Sem brief|Sem dados/);
    assert.equal(area.querySelectorAll('.av-step').length, 0);
  });
});

describe('a running agent (issue 521)', () => {
  test('new steps raise "N passos novos" and the view does not scroll by itself', async () => {
    let current = view({ state: 'working', end: null, result: null, steps: [step(1), step(2)] });
    const { area, change } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: () => current });
    assert.match(texto(area.querySelector('.av-state')), /Ativa|Rodando/);
    let scrolled = 0;
    const proto = ElementoFalso.prototype;
    const [intoView, scrollTo] = [proto.scrollIntoView, proto.scrollTo];
    proto.scrollIntoView = () => void scrolled++;
    proto.scrollTo = () => void scrolled++;
    try {
      current = view({ state: 'working', end: null, result: null, steps: [step(1), step(2), step(3), step(4)] });
      change();
      await settle();
    } finally {
      Object.assign(proto, { scrollIntoView: intoView, scrollTo });
    }
    assert.match(texto(area.querySelector('.av-new-steps')), /2 passos novos/);
    assert.equal(area.querySelectorAll('.av-step').length, 2, 'the list stays as the person left it');
    assert.equal(scrolled, 0, 'no auto-scroll');
    area.querySelector('.av-new-steps')!.click();
    assert.equal(area.querySelectorAll('.av-step').length, 4);
  });
});

describe('the loop node of the Workflow tab (issue 521)', () => {
  test('the node name links to the agent view and the icon keeps the Conversa link', async () => {
    // @ts-expect-error: browser module, plain JavaScript
    const loop = await import('../../ui/screens/workflow-loop.js');
    const group = { id: 'pr-524', kind: 'pr', number: 524, issue: null, otherRefs: [], state: 'approved', rounds: 1, changeRequests: 0, steps: [{ agentId: IRIS, role: 'dev', agentType: 'ahrena-engineering-frontend:iris', task: 't', state: 'completed', startedAt: iso(20), endedAt: iso(10), verdict: null, findings: null }] };
    const area = new ElementoFalso('div');
    area.append(loop.loopPanel({ sessionId: SID, loop: { groups: [group], totals: { prs: 1, rounds: 1, changeRequests: 0, subagents: 1 } } }, null));
    const name = area.querySelector('a.wfl-name')!;
    assert.equal(name.getAttribute('href'), `/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    assert.equal(area.querySelector('a.wfl-open')!.getAttribute('href'), `/ui/sessions/${SID}?agent=${encodeURIComponent(IRIS)}#conversation`);
  });
});
