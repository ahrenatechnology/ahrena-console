import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #512 the work routes when GitHub accepts a request and never answers: `GET /api/work` and
 * `GET /api/work/issue` answer as with GitHub down (the stored value as stale, or 502 `github-unavailable`),
 * with the reason code `network` (#495). The core's real server, the use cases, the ADR-0001 cache and the
 * real GraphQL adapters; GitHub is a `fetch` that answers until it is told to hang, and then gives up
 * only when the deadline its request carries aborts it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { selectedProjectBoard, WORK_BOARD_ROUTE } from '../../src/api/work-board.ts';
import { WORK_ISSUE_ROUTE } from '../../src/api/work-issue.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { createGithubProject } from '../../src/github/project.ts';
import { SqliteWorkColumnHistory } from '../../src/github/work-board-history.ts';
import { WorkBoardService } from '../../src/github/work-board-service.ts';
import { WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, REPO, type Recorded } from '../github/helpers.ts';

const TIMEOUT_MS = 50;
/** #512 a request that outlives this was not bounded: the test fails instead of waiting for the runner. */
const GUARD_MS = 5_000;
const PROJECT = { owner: 'ahrenatechnology', number: 3 };
const recordedBoard: Recorded[] = JSON.parse(readFileSync(new URL('../github/fixtures/project.json', import.meta.url), 'utf8'));

const issueOf = (n: number) => ({
  number: n,
  title: `issue ${n}`,
  url: `https://github.com/${REPO}/issues/${n}`,
  state: 'OPEN',
  repository: { nameWithOwner: REPO },
  issueType: { name: 'Task' },
  updatedAt: '2026-11-10T10:00:00Z',
  body: 'the body',
  labels: { nodes: [] },
  milestone: null,
  comments: { totalCount: 0, nodes: [] },
  parent: null,
  subIssues: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
});

type Mode = 'ok' | 'hang';

/** #512 GitHub as a switch: `ok` answers what the route reads, `hang` accepts the request and never answers. */
function github(answer: (operation: string) => Response) {
  const state = { mode: 'ok' as Mode, calls: 0, aborted: 0 };
  const fake = (async (_url: unknown, init?: RequestInit) => {
    state.calls++;
    const { query } = JSON.parse(String(init?.body));
    if (state.mode === 'ok') return answer(/(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '?');
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const abort = () => {
        state.aborted++;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }) as unknown as typeof globalThis.fetch;
  return { state, fetch: fake };
}

const projectAnswer = (operation: string) => {
  const hit = recordedBoard.find((r) => r.operation === operation);
  if (!hit) throw new Error(`no recorded answer for ${operation}`);
  return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
};
const issueAnswer = () => new Response(JSON.stringify({ data: { repository: { issue: issueOf(512) } } }), { status: 200 });

interface Boot {
  api: LocalApi;
  now: ReturnType<typeof clock>;
  gh: ReturnType<typeof github>;
  logs: string[];
  close(): Promise<void>;
}

async function boot(kind: 'board' | 'issue-with-hanging-project'): Promise<Boot> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const now = clock();
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const logs: string[] = [];
  const gh = github(kind === 'board' ? projectAnswer : issueAnswer);
  let routes: Parameters<typeof startLocalApi>[0]['work'] | undefined;
  let workIssue: Parameters<typeof startLocalApi>[0]['workIssue'] | undefined;
  if (kind === 'board') {
    const kanban = createGithubProject({ project: PROJECT, cache, token: 'test-token', fetch: gh.fetch, now, timeoutMs: TIMEOUT_MS });
    const service = new WorkBoardService({
      project: selectedProjectBoard({ kanban: () => kanban }),
      sessions: { links: async () => [] },
      queue: { available: true, positions: async () => new Map() },
      history: new SqliteWorkColumnHistory(storage.db),
      now,
      log: (m) => logs.push(m),
    });
    routes = { service, fromStore: false };
  } else {
    // #512 the issue's own read answers; the Project it asks for the card's status hangs.
    const hangingProject = github(projectAnswer);
    hangingProject.state.mode = 'hang';
    const kanban = createGithubProject({ project: PROJECT, cache: new GithubCache({ store: new MemoryCacheStore(), now }), token: 'test-token', fetch: hangingProject.fetch, now, timeoutMs: TIMEOUT_MS });
    const service = new WorkIssueService({
      source: new GithubGraphqlSource({ token: 'test-token', fetch: gh.fetch, timeoutMs: TIMEOUT_MS }),
      cache,
      project: kanban,
      log: (m) => logs.push(m),
    });
    workIssue = { service };
  }
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    ...(routes ? { work: routes } : {}),
    ...(workIssue ? { workIssue } : {}),
  });
  return { api, now, gh, logs, async close() { await api.close(); await storage.close(); } };
}

/** #512 the body the work routes answer with, as far as these tests read it. */
interface RouteBody {
  error?: string;
  reason?: string;
  stale?: boolean;
  staleReason?: string | null;
  number?: number;
  projectStatus?: unknown;
  columns?: { cards: unknown[] }[];
}

async function get(b: Boot, route: string, query = '') {
  const started = Date.now();
  const r = await fetch(`${b.api.url}${route}${query}`, { signal: AbortSignal.timeout(GUARD_MS) });
  return { status: r.status, json: (await r.json()) as RouteBody, tookMs: Date.now() - started };
}

async function withApi(kind: Parameters<typeof boot>[0], fn: (b: Boot) => Promise<void>) {
  const b = await boot(kind);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

describe('#512/AC-2 GET /api/work when GitHub accepts the request and never answers', () => {
  test('#512/AC-2 Given nothing is stored, When the board is read and GitHub never answers, Then 502 github-unavailable with reason network, within the timeout', () =>
    withApi('board', async (b) => {
      b.gh.state.mode = 'hang';
      const r = await get(b, WORK_BOARD_ROUTE);
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }]);
      assert.equal(b.gh.state.aborted, 1, 'the request was aborted by its deadline');
      assert.ok(r.tookMs < GUARD_MS);
    }));

  test('#512/AC-2 Given the board was read once, When it is refreshed and GitHub never answers, Then 200 with the stored board, stale, staleReason network', () =>
    withApi('board', async (b) => {
      const first = await get(b, WORK_BOARD_ROUTE);
      assert.deepEqual([first.status, first.json.stale, first.json.staleReason], [200, false, null]);
      const cards = first.json.columns.flatMap(c => c.cards).length;
      assert.ok(cards > 0, 'the stored board has cards');
      b.gh.state.mode = 'hang';
      b.now.add(31_000);
      const r = await get(b, WORK_BOARD_ROUTE, '?refresh=1');
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.stale, r.json.staleReason], [true, 'network']);
      assert.equal(r.json.columns.flatMap(c => c.cards).length, cards, 'the last board is still there');
      assert.equal(b.gh.state.aborted, 1);
    }));

  test('#512/AC-2 Given the stored board expired, When it is read and GitHub never answers, Then 200 stale with staleReason network and no raw text', () =>
    withApi('board', async (b) => {
      await get(b, WORK_BOARD_ROUTE);
      b.gh.state.mode = 'hang';
      b.now.add(3 * 60_000);
      const r = await get(b, WORK_BOARD_ROUTE);
      assert.deepEqual([r.status, r.json.stale, r.json.staleReason], [200, true, 'network']);
      assert.doesNotMatch(JSON.stringify(r.json), /TimeoutError|aborted due to timeout/i);
    }));
});

describe('#512/AC-2 GET /api/work/issue when GitHub accepts the request and never answers', () => {
  const QUERY = `?repo=${REPO}&number=512`;

  test('#512/AC-2 Given nothing is stored, When the issue is read and GitHub never answers, Then 502 github-unavailable with reason network, within the timeout', () =>
    withApi('issue-with-hanging-project', async (b) => {
      b.gh.state.mode = 'hang';
      const r = await get(b, WORK_ISSUE_ROUTE, QUERY);
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }]);
      assert.equal(b.gh.state.aborted, 1);
    }));

  test('#512/AC-2 Given the issue was read once, When it is refreshed and GitHub never answers, Then 200 with the stored issue, stale, staleReason network', () =>
    withApi('issue-with-hanging-project', async (b) => {
      const first = await get(b, WORK_ISSUE_ROUTE, QUERY);
      assert.deepEqual([first.status, first.json.stale, first.json.number], [200, false, 512]);
      b.gh.state.mode = 'hang';
      b.now.add(31_000);
      const r = await get(b, WORK_ISSUE_ROUTE, `${QUERY}&refresh=1`);
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.stale, r.json.staleReason, r.json.number], [true, 'network', 512]);
    }));

  test('#512/AC-2 Given the issue answers and the Project read never does, When the issue is read, Then 200 within the timeout with no Project status', () =>
    withApi('issue-with-hanging-project', async (b) => {
      const r = await get(b, WORK_ISSUE_ROUTE, QUERY);
      assert.equal(r.status, 200);
      assert.equal(r.json.number, 512);
      assert.equal(r.json.projectStatus, null);
      assert.ok(r.tookMs < GUARD_MS, 'the Project read did not hang the route');
      assert.ok(b.logs.some((m) => /project status unavailable/.test(m)), 'the failed Project read went to the core log');
    }));
});
