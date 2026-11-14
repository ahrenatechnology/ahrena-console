// The state of the agent view (#539, layer 3 of 521): the read state machine, the retry, the steps that
// accumulate while the agent runs, the folds and children opened in line, and the focus on Back. The read is a
// fake one that answers in the shape of the agent-view contract (#529); nothing here reads the core.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
const state = await import('../../ui/screens/agent-view-state.js');
// @ts-expect-error: browser module, plain JavaScript
const screen = await import('../../ui/screens/agent-view.js');

const SID = 'c3f09b52-4e10';
const ATHENA = 'a1b2';
const IRIS = 'c3d4:iris'; // an agent id may carry a ":" (the route carries it encoded) (#529)
const ROUTE = `/api/sessions/${SID}/agents/${ATHENA}`;
const IRIS_ROUTE = `/api/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`;
const AGENTS_HREF = `/ui/sessions/${SID}#agents`;
const at = (sec: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + sec * 1000).toISOString();

const step = (i: number, extra = {}) => ({ id: `toolu_${i}`, kind: 'tool', name: 'Read', summary: `file ${i}`, state: 'ok', start: at(i), end: at(i + 1), childAgentId: null, ...extra });
const agent = (extra: Record<string, unknown> = {}) => ({
  agentId: ATHENA, agentType: 'athena', description: 'plans the issue', brief: 'Plan issue 521.', briefTruncated: false, spawnedByToolUseId: 'toolu_T1',
  steps: [step(1), { id: 'toolu_A', kind: 'agent', name: 'Agent', summary: 'iris', state: 'ok', start: at(5), end: at(60), childAgentId: IRIS }],
  result: 'Layers ordered.', resultTruncated: false, costUsd: 0.41, costNote: null, totalCostUsd: 0.5, state: 'completed', start: at(0), end: at(120), ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const readError = (status: number, code: string | null = null) => Object.assign(new Error(`core answered ${status}`), { name: 'ReadError', status, body: code ? { error: 'x', code } : null });

describe('the read route', () => {
  test('carries the session id and the agent id encoded, the ":" of an id included', () => {
    assert.equal(state.agentReadRoute(SID, ATHENA), ROUTE);
    assert.equal(state.agentReadRoute(SID, IRIS), IRIS_ROUTE);
    assert.equal(IRIS_ROUTE.includes(':'), false);
  });
});

describe('what a failed read means', () => {
  test('a 404 is an agent the core does not know; any other failure is an error to retry', () => {
    assert.equal(state.failureKind(readError(404, 'agent_not_found')), 'missing');
    assert.equal(state.failureKind(readError(404, 'session_not_found')), 'missing');
    assert.equal(state.failureKind(readError(503)), 'error');
    assert.equal(state.failureKind(readError(0)), 'error');
    assert.equal(state.failureKind(new Error('boom')), 'error');
  });

  test('a running agent is one that works or waits', () => {
    assert.deepEqual(['working', 'waiting', 'completed', 'error'].map((s) => state.isRunning({ state: s })), [true, true, false, false]);
  });
});

describe('the read state machine', () => {
  test('starts loading, then is ready with the data the read answered', async () => {
    const reader = state.createAgentReader({ read: async () => agent() });
    assert.equal(reader.snapshot().phase, 'loading');
    await reader.load();
    assert.equal(reader.snapshot().phase, 'ready');
    assert.equal(reader.snapshot().data.agentId, ATHENA);
  });

  test('a failed read is `error` with the message, and a 404 is `missing`', async () => {
    const down = state.createAgentReader({ read: async () => { throw readError(503); } });
    await down.load();
    assert.equal(down.snapshot().phase, 'error');
    assert.match(down.snapshot().message, /core answered 503/);
    const gone = state.createAgentReader({ read: async () => { throw readError(404, 'agent_not_found'); } });
    await gone.load();
    assert.equal(gone.snapshot().phase, 'missing');
  });

  test('load again after an error goes back through loading and reads once more', async () => {
    let fail = true;
    const seen: string[] = [];
    const reader = state.createAgentReader({ read: async () => { if (fail) throw readError(503); return agent(); } });
    reader.subscribe((s: { phase: string }) => seen.push(s.phase));
    await reader.load();
    fail = false;
    await reader.load();
    assert.deepEqual(seen, ['loading', 'error', 'loading', 'ready']);
  });

  test('a quiet refresh keeps the data on screen: it does not go back to loading, and a failure keeps it', async () => {
    let answer: () => unknown = () => agent();
    const seen: string[] = [];
    const reader = state.createAgentReader({ read: async () => answer() });
    await reader.load();
    reader.subscribe((s: { phase: string }) => seen.push(s.phase));
    answer = () => agent({ state: 'completed', end: at(130) });
    await reader.refresh();
    assert.equal(reader.snapshot().data.end, at(130));
    answer = () => { throw readError(503); };
    await reader.refresh();
    assert.equal(reader.snapshot().phase, 'ready', 'the failed refresh does not throw the view away');
    assert.equal(reader.snapshot().data.end, at(130));
    assert.deepEqual(seen, ['ready']);
  });

  test('a refresh that finds the agent gone is `missing`', async () => {
    let gone = false;
    const reader = state.createAgentReader({ read: async () => { if (gone) throw readError(404, 'agent_not_found'); return agent(); } });
    await reader.load();
    gone = true;
    await reader.refresh();
    assert.equal(reader.snapshot().phase, 'missing');
  });

  test('refresh calls that overlap read once more after the one in flight, not once each', async () => {
    let reads = 0;
    let release: () => void = () => {};
    const reader = state.createAgentReader({ read: async () => { reads++; if (reads === 2) await new Promise<void>((r) => (release = r)); return agent(); } });
    await reader.load();
    const first = reader.refresh();
    await settle();
    const rest = [reader.refresh(), reader.refresh(), reader.refresh()];
    release();
    await Promise.all([first, ...rest]);
    assert.equal(reads, 3, 'the load, the refresh in flight, and one more for all the calls that came while it ran');
  });

  test('the answer of an older read never overwrites a newer one', async () => {
    const waits: Array<(v: unknown) => void> = [];
    const reader = state.createAgentReader({ read: () => new Promise((r) => waits.push(r)) });
    const older = reader.load();
    const newer = reader.load();
    waits[1]!(agent({ result: 'new' }));
    await newer;
    waits[0]!(agent({ result: 'old' }));
    await older;
    assert.equal(reader.snapshot().data.result, 'new');
  });
});

function ctxFor(read: (route: string) => unknown, params: Record<string, string> = { id: SID, agentId: ATHENA }) {
  const leave = new AbortController();
  const changes: Array<() => void> = [];
  const restarts: Array<() => void> = [];
  const navigated: Array<[string, unknown]> = [];
  const calls: string[] = [];
  const ctx = {
    params, signal: leave.signal, write: async () => { throw new Error('the view only reads'); },
    read: async (route: string) => { calls.push(route); return read(route); },
    navigate: (route: string, st?: unknown) => void navigated.push([route, st]),
    counter: () => {}, title: () => {}, onChange: (f: () => void) => void changes.push(f), onRestart: (f: () => void) => void restarts.push(f), liveState: () => 'live',
  };
  return { ctx, leave, calls, navigated, change: () => changes.forEach((f) => f()), restart: () => restarts.forEach((f) => f()) };
}
async function mountView(read: (route: string) => unknown, params?: Record<string, string>) {
  const c = ctxFor(read, params);
  const area = new ElementoFalso('main');
  const cleanup = await screen.mount(area, c.ctx);
  await settle();
  return { area, cleanup, ...c };
}

describe('the screen follows the read', () => {
  test('shows the loading state until the read answers, then the agent', async () => {
    let release: (v: unknown) => void = () => {};
    const c = ctxFor(() => new Promise((r) => (release = r)));
    const area = new ElementoFalso('main');
    const mounted = screen.mount(area, c.ctx);
    await settle();
    assert.ok(area.querySelector('.state.loading'));
    assert.deepEqual(c.calls, [ROUTE]);
    release(agent());
    await mounted;
    assert.equal(area.querySelector('.state.loading'), null);
    assert.match(texto(area.querySelector('.av-brief')), /Plan issue 521\./);
  });

  test('reads the agent of the address, with its id encoded', async () => {
    const { calls } = await mountView(() => agent({ agentId: IRIS }), { id: SID, agentId: IRIS });
    assert.deepEqual(calls, [IRIS_ROUTE]);
  });

  test('a failed read shows the error with the crumb, and the retry repeats only the read', async () => {
    let fail = true;
    const { area, calls, navigated } = await mountView(() => { if (fail) throw readError(503); return agent(); });
    assert.ok(area.querySelector('.av-error [role="alert"]'));
    assert.ok(area.querySelector('.av-crumb'), 'the way out stays');
    const retry = () => area.querySelectorAll('button').find((b) => texto(b) === 'Tentar de novo')!;
    fail = false;
    retry().click();
    assert.ok(area.querySelector('.state.loading'), 'back to loading while it reads');
    await settle();
    assert.deepEqual(calls, [ROUTE, ROUTE]);
    assert.deepEqual(navigated, []);
    assert.match(texto(area.querySelector('.av-brief')), /Plan issue 521\./);
  });

  test('a retry that fails again stays on the error', async () => {
    const { area, calls } = await mountView(() => { throw readError(503); });
    area.querySelectorAll('button').find((b) => texto(b) === 'Tentar de novo')!.click();
    await settle();
    assert.equal(calls.length, 2);
    assert.ok(area.querySelector('.av-error'));
  });

  test('an agent the core does not know shows the missing state with the way back', async () => {
    const { area } = await mountView(() => { throw readError(404, 'agent_not_found'); });
    assert.ok(area.querySelector('.av-missing'));
    assert.equal(area.querySelector('.av-error'), null);
    assert.equal(area.querySelector('.av-back')!.getAttribute('href'), AGENTS_HREF);
  });

  test('an agent with no recorded data shows the empty state', async () => {
    const { area } = await mountView(() => agent({ brief: null, steps: [], result: null, costUsd: null, costNote: 'no_usage', totalCostUsd: null }));
    assert.ok(area.querySelector('.av-nodata'));
  });
});

describe('a running agent', () => {
  const running = (steps: unknown[]) => agent({ state: 'working', end: null, result: null, steps });
  const noScroll = async (run: () => Promise<void>) => {
    let scrolled = 0;
    const proto = ElementoFalso.prototype;
    const [intoView, scrollTo] = [proto.scrollIntoView, proto.scrollTo];
    proto.scrollIntoView = () => void scrolled++;
    proto.scrollTo = () => void scrolled++;
    try {
      await run();
    } finally {
      Object.assign(proto, { scrollIntoView: intoView, scrollTo });
    }
    return scrolled;
  };

  test('new steps wait behind "N passos novos", grow with the next change, and show on request', async () => {
    let current = running([step(1), step(2)]);
    const { area, change } = await mountView(() => current);
    assert.equal(area.querySelector('.av-new-steps')!.hidden, true);
    const scrolled = await noScroll(async () => {
      current = running([step(1), step(2), step(3)]);
      change();
      await settle();
      assert.match(texto(area.querySelector('.av-new-steps')), /^1 passo novo$/);
      current = running([step(1), step(2), step(3), step(4), step(5)]);
      change();
      await settle();
    });
    assert.match(texto(area.querySelector('.av-new-steps')), /^3 passos novos$/);
    assert.equal(area.querySelector('.av-new-steps')!.hidden, false);
    assert.equal(area.querySelectorAll('.av-step').length, 2);
    assert.equal(scrolled, 0);
    area.querySelector('.av-new-steps')!.click();
    assert.equal(area.querySelectorAll('.av-step').length, 5);
    assert.equal(area.querySelector('.av-new-steps')!.hidden, true);
  });

  test('the header follows the agent while the steps wait: it ends, and the result comes', async () => {
    let current = running([step(1)]);
    const { area, change } = await mountView(() => current);
    assert.match(texto(area.querySelector('.av-state')), /Ativa/);
    current = agent({ steps: [step(1), step(2)] });
    change();
    await settle();
    assert.match(texto(area.querySelector('.av-state')), /Concluída/);
    assert.match(texto(area.querySelector('.av-result')), /Layers ordered\./);
    assert.equal(area.querySelectorAll('.av-step').length, 1);
  });

  test('what the person opened stays open when the view follows the agent', async () => {
    let current = running([step(1), step(2)]);
    const { area, change } = await mountView(() => current);
    area.querySelectorAll('.av-step')[0]!.querySelector('button')!.click();
    current = running([step(1), step(2), step(3)]);
    change();
    await settle();
    assert.ok(area.querySelectorAll('.av-step')[0]!.querySelector('.av-detail'));
  });

  test('a change reads again only while the agent runs', async () => {
    let current = running([step(1)]);
    const { calls, change } = await mountView(() => current);
    change();
    await settle();
    assert.equal(calls.length, 2);
    current = agent();
    change();
    await settle();
    assert.equal(calls.length, 3, 'the read that found it finished');
    change();
    change();
    await settle();
    assert.equal(calls.length, 3, 'a finished agent is not read again');
  });

  test('a restart of the live stream reads again, a failed read keeps what is on screen', async () => {
    let fail = false;
    const { area, calls, restart } = await mountView(() => { if (fail) throw readError(503); return agent(); });
    fail = true;
    restart();
    await settle();
    assert.equal(calls.length, 2);
    assert.match(texto(area.querySelector('.av-brief')), /Plan issue 521\./);
    assert.equal(area.querySelector('.av-error'), null);
  });

  test('leaving the screen stops the reads and the drawing', async () => {
    let current = running([step(1)]);
    const { area, cleanup, change, leave, calls } = await mountView(() => current);
    assert.equal(typeof cleanup, 'function');
    leave.abort();
    cleanup();
    current = running([step(1), step(2)]);
    change();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(area.querySelector('.av-new-steps')!.hidden, true);
  });
});

describe('open and close in line', () => {
  test('a folded brief opens and folds again, and its button keeps the focus', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const { area } = await mountView(() => agent({ brief: long }));
    area.querySelector('.av-brief .av-fold')!.click();
    assert.ok(texto(area.querySelector('.av-brief')).includes('line 10'));
    assert.equal(documentoFalso.activeElement?.getAttribute('data-key'), 'fold:brief');
    area.querySelector('.av-brief .av-fold')!.click();
    assert.ok(!texto(area.querySelector('.av-brief')).includes('line 10'));
  });

  test('a child opens in its call: one read of its own route, once, nested one level down', async () => {
    const { area, calls } = await mountView((route) => (route === IRIS_ROUTE ? agent({ agentId: IRIS, agentType: 'iris', steps: [step(7)] }) : agent()));
    const toggle = () => area.querySelector('.av-child .av-toggle')!;
    assert.equal(area.querySelector('.av-child .av-seq'), null);
    toggle().click();
    assert.match(texto(area.querySelector('.av-child')), /Lendo o agente/);
    await settle();
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => s.getAttribute('data-depth')), ['0', '0', '1']);
    toggle().click();
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => s.getAttribute('data-depth')), ['0', '0'], 'closed');
    toggle().click();
    await settle();
    assert.equal(area.querySelectorAll('.av-step').length, 3, 'opened again');
    assert.deepEqual(calls.filter((r) => r === IRIS_ROUTE), [IRIS_ROUTE], 'read once');
  });

  test('a child that could not be read is read again the next time it opens', async () => {
    let fail = true;
    const { area, calls } = await mountView((route) => {
      if (route !== IRIS_ROUTE) return agent();
      if (fail) throw readError(503);
      return agent({ agentId: IRIS, steps: [step(7)] });
    });
    area.querySelector('.av-child .av-toggle')!.click();
    await settle();
    area.querySelector('.av-child .av-toggle')!.click();
    fail = false;
    area.querySelector('.av-child .av-toggle')!.click();
    await settle();
    assert.equal(calls.filter((r) => r === IRIS_ROUTE).length, 2);
    assert.equal(area.querySelectorAll('.av-step').length, 3);
  });

  test('#539 AC-5: a child whose read fails shows its error in its slot, and "Tentar de novo" repeats only that read', async () => {
    let fail = true;
    const { area, calls } = await mountView((route) => {
      if (route !== IRIS_ROUTE) return agent();
      if (fail) throw readError(503);
      return agent({ agentId: IRIS, steps: [step(7)] });
    });
    area.querySelector('.av-child .av-toggle')!.click();
    await settle();
    assert.match(texto(area.querySelector('.av-child')), /Não deu para ler o agente/);
    assert.doesNotMatch(texto(area.querySelector('.av-child')), /Lendo o agente/);
    const parentReads = calls.filter((r) => r !== IRIS_ROUTE).length;
    fail = false;
    area.querySelector('.av-child .av-child-retry')!.click();
    await settle();
    assert.equal(calls.filter((r) => r === IRIS_ROUTE).length, 2, 'the child is read once more');
    assert.equal(calls.filter((r) => r !== IRIS_ROUTE).length, parentReads, 'the parent read is not repeated');
    assert.equal(area.querySelectorAll('.av-step').length, 3, 'the steps of the child appear');
    assert.equal(area.querySelector('.av-child-retry'), null);
  });

  test('#539 AC-5: a retry that fails again shows the error again', async () => {
    const { area, calls } = await mountView((route) => {
      if (route === IRIS_ROUTE) throw readError(503);
      return agent();
    });
    area.querySelector('.av-child .av-toggle')!.click();
    await settle();
    area.querySelector('.av-child .av-child-retry')!.click();
    await settle();
    assert.equal(calls.filter((r) => r === IRIS_ROUTE).length, 2);
    assert.match(texto(area.querySelector('.av-child')), /Não deu para ler o agente/);
  });

  test('#539 AC-5: a retry that succeeds leaves the child read once: close and reopen make 2 reads in total', async () => {
    let fail = true;
    const { area, calls } = await mountView((route) => {
      if (route !== IRIS_ROUTE) return agent();
      if (fail) throw readError(503);
      return agent({ agentId: IRIS, steps: [step(7)] });
    });
    const toggle = () => area.querySelector('.av-child .av-toggle')!;
    toggle().click();
    await settle();
    fail = false;
    area.querySelector('.av-child .av-child-retry')!.click();
    await settle();
    toggle().click();
    toggle().click();
    await settle();
    assert.equal(area.querySelectorAll('.av-step').length, 3, 'the steps of the child show');
    assert.equal(calls.filter((r) => r === IRIS_ROUTE).length, 2, 'the failed read and the retry, no more');
  });

  test('#539 AC-5: reopening the child during an in-flight retry starts no second read', async () => {
    let fail = true;
    let release: (v: unknown) => void = () => {};
    const { area, calls } = await mountView((route) => {
      if (route !== IRIS_ROUTE) return agent();
      if (fail) throw readError(503);
      return new Promise((r) => (release = r));
    });
    const toggle = () => area.querySelector('.av-child .av-toggle')!;
    toggle().click();
    await settle();
    fail = false;
    area.querySelector('.av-child .av-child-retry')!.click();
    await settle();
    toggle().click();
    toggle().click();
    await settle();
    assert.equal(calls.filter((r) => r === IRIS_ROUTE).length, 2, 'the retry is the only read in flight');
    release(agent({ agentId: IRIS, steps: [step(7)] }));
    await settle();
    assert.equal(area.querySelectorAll('.av-step').length, 3);
  });
});

describe('Back returns to the Agents tab with the focus on the agent', () => {
  const click = (target: ElementoFalso, extra: Record<string, unknown> = {}) => target.dispatchEvent({ type: 'click', button: 0, ...extra });

  test('the Agents link of the crumb navigates with the agent to focus, without a reload', async () => {
    const { area, navigated } = await mountView(() => agent());
    const link = area.querySelectorAll('.av-crumb a').find((a) => a.getAttribute('href') === AGENTS_HREF)!;
    assert.ok(click(link) === false, 'the browser does not follow the link itself');
    assert.deepEqual(navigated, [[AGENTS_HREF, { focusAgent: ATHENA }]]);
  });

  test('the Back link of the missing and the error states do the same', async () => {
    const { area, navigated } = await mountView(() => { throw readError(404, 'agent_not_found'); });
    click(area.querySelector('.av-back')!);
    assert.deepEqual(navigated, [[AGENTS_HREF, { focusAgent: ATHENA }]]);
  });

  test('leaving the screen releases its click listener: the next agent on the same area gets its own Back (#539)', async () => {
    const area = new ElementoFalso('main');
    const first = ctxFor(() => agent(), { id: SID, agentId: ATHENA });
    const cleanFirst = await screen.mount(area, first.ctx);
    first.leave.abort();
    cleanFirst();
    area.replaceChildren();
    const second = ctxFor(() => agent({ agentId: IRIS }), { id: SID, agentId: IRIS });
    await screen.mount(area, second.ctx);
    const link = area.querySelectorAll('.av-crumb a').find((a) => a.getAttribute('href') === AGENTS_HREF)!;
    click(link);
    assert.deepEqual(first.navigated, [], 'the left screen no longer answers');
    assert.deepEqual(second.navigated, [[AGENTS_HREF, { focusAgent: IRIS }]]);
  });

  test('leaving during the first read releases the click listener though the shell never calls the cleanup (#539)', async () => {
    const area = new ElementoFalso('main');
    let answer: (v: unknown) => void = () => {};
    const first = ctxFor(() => new Promise((r) => (answer = r)));
    const mounting = screen.mount(area, first.ctx);
    await settle();
    first.leave.abort(); // (#539) the shell registers the cleanup only after mount resolves: on an aborted signal it never fires
    answer(agent());
    await mounting;
    await settle();
    const link = area.querySelectorAll('.av-crumb a').find((a) => a.getAttribute('href') === AGENTS_HREF);
    if (link) click(link);
    assert.deepEqual(first.navigated, [], 'the screen that was left no longer answers a click');
  });

  test('a screen mounted on an already aborted signal adds no listener and draws nothing (#539)', async () => {
    const area = new ElementoFalso('main');
    const c = ctxFor(() => agent());
    c.leave.abort();
    await screen.mount(area, c.ctx);
    await settle();
    assert.equal(area.querySelector('.av-crumb'), null);
    assert.equal(area.ouvintes.get('click')?.size ?? 0, 0);
  });

  test('a click with a modifier, or a link to somewhere else, is left to the browser', async () => {
    const { area, navigated } = await mountView(() => agent());
    const agents = area.querySelectorAll('.av-crumb a').find((a) => a.getAttribute('href') === AGENTS_HREF)!;
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) assert.ok(click(agents, mod));
    const session = area.querySelectorAll('.av-crumb a').find((a) => a.getAttribute('href') === `/ui/sessions/${SID}`)!;
    assert.ok(click(session));
    assert.deepEqual(navigated, []);
  });
});

describe('the Agents tab gives the focus back to the row', () => {
  const rows = () => [
    { id: 'main', type: 'main', name: 'principal', agentType: null, description: null, parent: null, task: 't', model: 'm', status: 'completed', start: at(0), end: at(60), costUsd: 1, turns: 3 },
    { id: `${SID}:${ATHENA}`, type: 'subagent', name: 'athena', agentType: 'athena', description: 'd', parent: 'main', task: 't', model: 'm', status: 'completed', start: at(0), end: at(60), costUsd: 1, turns: null },
    { id: `${SID}:${IRIS}`, type: 'subagent', name: 'iris', agentType: 'iris', description: 'd', parent: `${SID}:${ATHENA}`, task: 't', model: 'm', status: 'completed', start: at(0), end: at(60), costUsd: 1, turns: null },
  ];
  async function mountTab(focusAgent: string | null) {
    const saved: unknown[] = [];
    Object.assign(globalThis, {
      location: { pathname: `/ui/sessions/${SID}`, search: '', hash: '#agents', origin: 'http://127.0.0.1:8787', href: `http://127.0.0.1:8787/ui/sessions/${SID}#agents` },
      history: { state: focusAgent ? { focusAgent } : null, replaceState: (s: unknown) => void saved.push(s), pushState: () => {}, back: () => {} },
    });
    // @ts-expect-error: browser module, plain JavaScript
    const detail = await import('../../ui/screens/session-detail.js');
    const served: Record<string, unknown> = {
      [`/api/sessions/${SID}`]: { session: { id: `${SID}-0`, title: 'S', status: 'active', attention: null, model: 'm', startedAt: at(0), since: at(1), cwd: null, banner: null, identity: null }, endedAt: null, cost: null, branch: null, machine: null, open: null, counts: { agents: 3, events: 9 } },
      [`/api/sessions/${SID}/messaging`]: { available: false, reason: null, processes: 0 },
      [`/api/sessions/${SID}/transcription`]: {},
      [`/api/sessions/${SID}/agents`]: { numbers: { events: 9, perMinute: 1, tools: 4, uniqueTools: 2, subagents: 2, compactions: 0, errors: 0, durationMin: 30, running: false }, tools: [], tasks: null, tokens: null, agents: rows() },
    };
    const c = ctxFor((route) => served[route], { id: SID });
    const area = new ElementoFalso('main');
    documentoFalso.activeElement = null;
    await detail.mount(area, c.ctx);
    await settle();
    c.leave.abort();
    return { area, saved };
  }

  test('the row the person came from has the focus', async () => {
    const { area } = await mountTab(IRIS);
    const row = area.querySelectorAll('a.sd-node').find((r) => r.getAttribute('data-agent') === IRIS)!;
    assert.equal(documentoFalso.activeElement, row);
  });

  test('with nothing to return to, or an agent that is not listed, nothing takes the focus', async () => {
    assert.equal((await mountTab(null), documentoFalso.activeElement), null);
    assert.equal((await mountTab('ghost'), documentoFalso.activeElement), null);
  });

  test('opening a row marks its history entry, so the browser Back button finds the row too', async () => {
    const { area, saved } = await mountTab(null);
    const row = area.querySelectorAll('a.sd-node').find((r) => r.getAttribute('data-agent') === ATHENA)!;
    row.dispatchEvent({ type: 'click', button: 0 });
    assert.deepEqual(saved, [{ focusAgent: ATHENA }]);
  });
});
