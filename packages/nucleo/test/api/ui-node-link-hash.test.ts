// A Workflow loop node's open icon lands on the Conversa tab with that subagent selected (issue 520, parent 518).
// The shell's internal-link step used to drop the `#conversation` hash, so the session opened on its default tab.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso } from './fake-dom.ts';

instalarDomFalso();

const SID = 'c3f09b52-4e10';
const BASE = `/api/sessions/${SID}`;
const ORIGIN = 'http://127.0.0.1:8787';
const NODE_HREF = `/ui/sessions/${SID}?agent=sub-x#conversation`;

const page = { pathname: `/ui/sessions/${SID}`, search: '', hash: '#workflow', origin: ORIGIN, href: `${ORIGIN}/ui/sessions/${SID}#workflow` };
Object.assign(globalThis, { location: page, history: { replaceState: () => {}, pushState: () => {} } });

// @ts-expect-error: browser module, plain JavaScript
const link = await import('../../ui/internal-link.js');
// @ts-expect-error: browser module, plain JavaScript
const detail = await import('../../ui/screens/session-detail.js');

describe('internalRoute(href, base): the in-app route of a /ui link (issue 520)', () => {
  test('#520 AC-2: the node link keeps the query and the #conversation hash', () => {
    assert.equal(link.internalRoute(NODE_HREF, `${ORIGIN}/ui/sessions/${SID}#workflow`), NODE_HREF);
  });

  test('#520 AC-2: a link to another origin or outside /ui is not an in-app route', () => {
    assert.equal(link.internalRoute('https://example.com/ui/x', `${ORIGIN}/ui`), null);
    assert.equal(link.internalRoute('/api/health', `${ORIGIN}/ui`), null);
  });

  test('#520 AC-2: the same path and query with another hash is a different route', () => {
    const current = `/ui/sessions/${SID}?agent=sub-x#workflow`;
    assert.notEqual(link.internalRoute(NODE_HREF, `${ORIGIN}${current}`), current);
  });
});

describe('the node link to the selected agent in Conversa (issue 520)', () => {
  test('#520 AC-2: the route from the node link lands on Conversa with the agent selected and requested', async () => {
    const route = link.internalRoute(NODE_HREF, page.href);
    const u = new URL(route, ORIGIN);
    Object.assign(page, { pathname: u.pathname, search: u.search, hash: u.hash });

    const requests: string[] = [];
    const leave = new AbortController();
    const read = async (r: string) => {
      requests.push(r);
      if (r === BASE) return { session: { id: `${SID}-0`, title: 'S', status: 'active', attention: null, model: 'm', startedAt: new Date().toISOString(), since: new Date().toISOString(), cwd: null, banner: null, identity: null }, endedAt: null, cost: null, branch: null, machine: null, open: null, counts: { agents: 2, events: 2 } };
      if (r.startsWith(`${BASE}/conversation`)) {
        // The server answers with the agent it was asked for, so the selection follows the request.
        const asked = new URL(r, ORIGIN).searchParams.get('agent') ?? 'main';
        return { agents: [{ id: 'main', name: 'principal' }, { id: 'sub-x', name: 'sub X' }], agent: asked, total: 0, messages: [], cursor: 'k0' };
      }
      if (r.includes('/messaging')) return { available: false, reason: null, processes: 0 };
      if (r.includes('/transcription')) return {};
      if (r.endsWith('/agents')) return { numbers: { events: 0, perMinute: 0, tools: 0, uniqueTools: 0, subagents: 0, compactions: 0, errors: 0, durationMin: 0, running: false }, tools: [], tasks: null, tokens: null, agents: [] };
      throw Object.assign(new Error(`not served: ${r}`), { name: 'ReadError' });
    };
    const ctx = { params: { id: SID }, signal: leave.signal, read, write: async () => ({}), navigate: () => {}, counter: () => {}, title: () => {}, onChange: () => {}, onRestart: () => {}, liveState: () => 'live' };
    const area = new ElementoFalso('main');
    await detail.mount(area, ctx);
    await new Promise((r) => setTimeout(r, 0));
    leave.abort();

    const on = area.querySelectorAll('.sd-tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    assert.deepEqual(on.map((t) => t.getAttribute('data-tab')), ['conversation']);
    assert.ok(requests.includes(`${BASE}/conversation?agent=sub-x`), `conversation requested with agent=sub-x, got ${requests.join(' | ')}`);
    const chosen = area.querySelector('.sd-select')!.querySelectorAll('option').filter((o) => o.getAttribute('selected') !== null);
    assert.deepEqual(chosen.map((o) => o.getAttribute('value')), ['sub-x']);
  });
});
