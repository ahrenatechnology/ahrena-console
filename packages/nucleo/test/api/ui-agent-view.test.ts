// Red end-to-end skeleton of the agent view (#521, parent #518); data from #529.
// The components layer (#538) turned the Agents tab row and loop node tests green; the rest stay `todo` for the state (#539) and contract (#540) layers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const SID = 'c3f09b52-4e10';
const BASE = `/api/sessions/${SID}`;
const ORIGIN = 'http://127.0.0.1:8787';
const ATHENA = 'agent-athena';
const IRIS = 'agent-iris:abc1'; // an agent id has ":" in it: the route carries it encoded (#521)
const TODO = (what: string) => ({ todo: `#521 ${what}` });

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
const step = (i: number, extra = {}) => ({ kind: 'tool', name: 'Read', summary: `arquivo ${i}`, state: 'ok', startedAt: iso(30 - i), endedAt: iso(29 - i), toolUseId: `tu-${i}`, ...extra });
const view = (extra = {}) => ({
  id: ATHENA, agentType: 'athena', description: 'planeja a issue', brief: 'Planeje a issue 521.', briefTruncated: false, spawnedByToolUseId: 'tu-main', state: 'completed',
  startedAt: iso(30), endedAt: iso(10), costUsd: 0.41, costNote: null,
  steps: [step(1), { kind: 'agent', name: 'Agent', summary: 'iris', state: 'ok', startedAt: iso(28), endedAt: iso(20), toolUseId: 'tu-iris', child: { id: IRIS, agentType: 'iris', description: 'camadas do front', state: 'completed' } }, step(3)],
  result: 'Camadas ordenadas.', resultTruncated: false, ...extra,
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
  // The module does not exist yet: the import fails inside the body, so the scenario is red, not the whole file. (#521)
  const mod = await import('../../ui/screens/agent-view.js' as string);
  const c = ctxFor(served, { id: SID, agentId: ATHENA }, calls);
  const area = new ElementoFalso('main');
  await mod.mount(area, c.ctx);
  await settle();
  return { area, ...c };
}

async function mountAgentsTab(extraServed: Served = {}) {
  // @ts-expect-error: browser module, plain JavaScript
  const detail = await import('../../ui/screens/session-detail.js');
  const served: Served = {
    [BASE]: { session: { id: `${SID}-0`, title: 'S', status: 'active', attention: null, model: 'm', startedAt: iso(30), since: iso(1), cwd: null, banner: null, identity: null }, endedAt: null, cost: null, branch: null, machine: null, open: null, counts: { agents: 4, events: 9 } },
    [`${BASE}/messaging`]: { available: false, reason: null, processes: 0 },
    [`${BASE}/transcription`]: {},
    [`${BASE}/agents`]: AGENTS_LIST,
    ...extraServed,
  };
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

  test('Back returns focus to the row the person came from', TODO('Q9 back restores focus'), async () => {
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
  test('/ui/sessions/<id>/agents/<agentId> is the agent view screen, with the agent id decoded', TODO('Q1 own route'), () => {
    const found = registry.findScreen(`/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    assert.equal(found?.screen.file, '/ui/screens/agent-view.js');
    assert.deepEqual(found.params, { id: SID, agentId: IRIS });
    assert.equal(found.screen.highlights, 'sessions');
  });
});

describe('AC-2: the populated agent view (issue 521)', () => {
  test('shows the type and description, the brief, the state, the duration and the final result', TODO('AC-2 populated'), async () => {
    const { area, calls } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    assert.ok(calls.includes(`${BASE}/agents/${ATHENA}`), 'one read of the agent');
    assert.equal(texto(area.querySelector('.av-kind')), 'athena');
    assert.equal(texto(area.querySelector('.av-description')), 'planeja a issue');
    assert.match(texto(area.querySelector('.av-brief')), /Planeje a issue 521\./);
    assert.match(texto(area.querySelector('.av-state')), /Concluída/);
    assert.match(texto(area.querySelector('.av-duration')), /20 min/);
    assert.match(texto(area.querySelector('.av-result')), /Camadas ordenadas\./);
  });

  test('lists the steps in order, with the child agent nested in the call that spawned it', TODO('AC-2 steps and nesting'), async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    const steps = area.querySelectorAll('.av-step');
    assert.deepEqual(steps.map((s) => s.getAttribute('data-depth')), ['0', '0', '0']);
    const child = steps[1]!;
    assert.match(texto(child), /iris/);
    assert.match(texto(child), /Abrir a vista/);
    assert.ok(child.querySelector(`a[href="/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}"]`));
  });

  test('a tool step opens its detail inline', TODO('Q10 inline tool detail'), async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view() });
    const first = area.querySelectorAll('.av-step')[0]!;
    assert.equal(first.querySelector('.av-detail'), null);
    first.querySelector('button')!.click();
    assert.ok(first.querySelector('.av-detail'), 'the detail is inside the step, no navigation');
  });

  test('the own cost comes first, and "—" shows when no cost was measured', TODO('Q6 cost'), async () => {
    const measured = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ costUsd: 0.41 }) });
    assert.match(texto(measured.area.querySelector('.av-cost')), /^US\$ 0,41/);
    const unmeasured = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ costUsd: null, costNote: 'sem uso medido' }) });
    assert.match(texto(unmeasured.area.querySelector('.av-cost')), /^—/);
    assert.match(texto(unmeasured.area.querySelector('.av-cost')), /sem uso medido/);
  });
});

describe('folds and elision (issue 521)', () => {
  test('the brief and the result fold at 6 lines and open on request', TODO('Q5 fold at 6 lines'), async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ brief: lines(10), result: lines(10) }) });
    for (const sel of ['.av-brief', '.av-result']) {
      const box = area.querySelector(sel)!;
      assert.equal(box.getAttribute('data-folded'), 'true', `${sel} folded`);
      assert.ok(!texto(box).includes('linha 7'), `${sel} shows only 6 lines`);
      box.querySelector('.av-fold')!.click();
      assert.ok(texto(box).includes('linha 10'), `${sel} opened`);
    }
  });

  test('a brief of 6 lines or fewer has no fold', TODO('Q5 no fold up to 6 lines'), async () => {
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ brief: lines(6) }) });
    assert.equal(area.querySelector('.av-brief')!.querySelector('.av-fold'), null);
  });

  test('above 12 steps the first 5 and the last 3 stay visible, the middle is elided', TODO('Q5 elision'), async () => {
    const steps = Array.from({ length: 14 }, (_, i) => step(i + 1));
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ steps }) });
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => texto(s).match(/arquivo (\d+)/)![1]), ['1', '2', '3', '4', '5', '12', '13', '14']);
    const gap = area.querySelector('.av-elided')!;
    assert.match(texto(gap), /6 passos/);
    gap.querySelector('button')!.click();
    assert.equal(area.querySelectorAll('.av-step').length, 14);
  });

  test('12 steps are all shown', TODO('Q5 elision threshold'), async () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(i + 1));
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: view({ steps }) });
    assert.equal(area.querySelectorAll('.av-step').length, 12);
    assert.equal(area.querySelector('.av-elided'), null);
  });

  test('nested children keep their depth in the sequence once opened inline', TODO('Q4 inline children'), async () => {
    const served = { [`${BASE}/agents/${ATHENA}`]: view(), [`${BASE}/agents/${encodeURIComponent(IRIS)}`]: view({ id: IRIS, agentType: 'iris', steps: [step(1)] }) };
    const { area } = await mountAgentView(served);
    area.querySelectorAll('.av-step')[1]!.querySelector('button')!.click();
    await settle();
    assert.deepEqual(area.querySelectorAll('.av-step').map((s) => s.getAttribute('data-depth')), ['0', '0', '1', '0']);
  });
});

describe('the states of the view: loading, error, empty (issue 521)', () => {
  test('while the read has not come back it shows the loading state', TODO('loading state'), async () => {
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

  test('a failed read shows the error, and "Tentar de novo" retries only the read', TODO('Q7 error retries the read'), async () => {
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

  test('a failed agent shows its last error and the sequence it reached', TODO('Q7 failed agent'), async () => {
    const failing = view({ state: 'error', result: null, failure: { at: iso(11), text: 'gh pr diff saiu com 1' }, steps: [step(1), step(2, { state: 'error' })] });
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: failing });
    assert.match(texto(area.querySelector('.av-state')), /Com erro/);
    assert.match(texto(area.querySelector('.av-result')), /gh pr diff saiu com 1/);
    assert.equal(area.querySelectorAll('.av-step').length, 2);
  });

  test('an agent with no recorded data shows the empty state, not blank fields', TODO('empty state'), async () => {
    const bare = view({ brief: null, steps: [], result: null, costUsd: null, costNote: 'sem uso medido', agentType: null, description: null });
    const { area } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: bare });
    assert.ok(area.querySelector('.state'), 'empty state');
    assert.match(texto(area), /Sem brief|Sem dados/);
    assert.equal(area.querySelectorAll('.av-step').length, 0);
  });
});

describe('a running agent (issue 521)', () => {
  test('new steps raise "N passos novos" and the view does not scroll by itself', TODO('Q8 no auto-scroll'), async () => {
    let current = view({ state: 'running', endedAt: null, result: null, steps: [step(1), step(2)] });
    const { area, change } = await mountAgentView({ [`${BASE}/agents/${ATHENA}`]: () => current });
    assert.match(texto(area.querySelector('.av-state')), /Ativa|Rodando/);
    let scrolled = 0;
    area.scrollIntoView = () => void scrolled++;
    for (const s of area.querySelectorAll('.av-step')) s.scrollIntoView = () => void scrolled++;
    current = view({ state: 'running', endedAt: null, result: null, steps: [step(1), step(2), step(3), step(4)] });
    change();
    await settle();
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
