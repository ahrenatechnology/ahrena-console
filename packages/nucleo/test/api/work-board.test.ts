import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #465 #466 GET /api/work, the work board, through the HTTP route: the core's real server, the use case,
 * the ADR-0001 cache and the SQLite column history; GitHub (the Project source) and the sessions are fakes.
 * Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type ApiOptions, type LocalApi } from '../../src/api/index.ts';
import { selectedProjectBoard, WORK_BOARD_ROUTE } from '../../src/api/work-board.ts';
import { GithubCache, MemoryCacheStore, NoDataError, RateLimitedError } from '../../src/github/cache.ts';
import { GithubGatewayError, GithubScopeError } from '../../src/github/github-source.ts';
import { GithubProject, ProjectPermissionError, type ProjectBoardValue, type ProjectCard, type ProjectRef, type ProjectSource } from '../../src/github/project.ts';
import { WORK_LEVELS, type LinkedPullRequest } from '../../src/github/work.ts';
import { EMPTY_WORK_QUEUE, WORK_BLOCKED_REASONS, WORK_BOARD_COLUMNS, type WorkQueue, type WorkSessionLink, type WorkSessions } from '../../src/github/work-board.ts';
import { SqliteWorkColumnHistory } from '../../src/github/work-board-history.ts';
import { WorkBoardService } from '../../src/github/work-board-service.ts';
import { clock, k, REPO } from '../github/helpers.ts';

const PROJECT: Required<ProjectRef> = { owner: 'ahrenatechnology', number: 3, field: 'Status' };
const LANES = [
  { id: 'opt-todo', name: 'Todo', color: 'GREEN' },
  { id: 'opt-progress', name: 'In Progress', color: 'YELLOW' },
  { id: 'opt-done', name: 'Done', color: 'PURPLE' },
];

function issue(n: number, over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    itemId: `PVTI_${n}`,
    kind: 'Issue',
    key: k(n),
    repo: REPO,
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    state: 'OPEN',
    updatedAt: '2026-10-18T10:00:00Z',
    type: 'Task',
    parent: null,
    statusId: 'opt-todo',
    milestone: null,
    subIssues: null,
    pullRequest: null,
    labels: [],
    closedAt: null,
    ...over,
  };
}

const pr = (over: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  number: 900,
  url: `https://github.com/${REPO}/pull/900`,
  state: 'OPEN',
  isDraft: false,
  review: 'REVIEW_REQUIRED',
  ci: 'SUCCESS',
  mergedAt: null,
  changesRequested: 0,
  ...over,
});

/** #465 the Project on GitHub: `items` is what the next read answers; `fail` makes the read fail. */
class FakeProjectSource implements ProjectSource {
  items: ProjectCard[] = [];
  fail: Error | null = null;
  reads = 0;
  async board(): Promise<ProjectBoardValue> {
    this.reads++;
    if (this.fail) throw this.fail;
    return { projectId: 'PVT_1', fieldId: 'PVTSSF_1', field: 'Status', title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3', options: LANES, items: this.items };
  }
  async move(): Promise<never> {
    throw new Error('the work board never moves a card');
  }
}

class FakeSessions implements WorkSessions {
  list: WorkSessionLink[] = [];
  async links(): Promise<WorkSessionLink[]> {
    return this.list;
  }
}

class FakeQueue implements WorkQueue {
  readonly available = true;
  map = new Map<string, number>();
  async positions(): Promise<ReadonlyMap<string, number>> {
    return this.map;
  }
}

const session = (id: string, n: number, state: WorkSessionLink['state']): WorkSessionLink => ({ sessionId: id, key: k(n), state, since: '2026-10-18T11:00:00Z' });

interface Board {
  api: LocalApi;
  storage: SqliteStorage;
  now: ReturnType<typeof clock>;
  source: FakeProjectSource;
  sessions: FakeSessions;
  queue: FakeQueue;
  /** #495 what the use case sent to the core log. */
  logs: string[];
  /** #465 turns the chosen Project off (no-project) or back on. */
  choose(project: boolean): void;
  close(): Promise<void>;
}

async function boot({ extra = {}, withWork = true, fromStore = false }: { extra?: Partial<ApiOptions>; withWork?: boolean; fromStore?: boolean } = {}): Promise<Board> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const now = clock();
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const source = new FakeProjectSource();
  const kanban = new GithubProject({ source, cache, project: PROJECT, now });
  let chosen = true;
  const sessions = new FakeSessions();
  const queue = new FakeQueue();
  const logs: string[] = [];
  const service = new WorkBoardService({
    project: selectedProjectBoard({ kanban: () => (chosen ? kanban : null) }),
    sessions,
    queue,
    history: new SqliteWorkColumnHistory(storage.db),
    now,
    log: (m) => logs.push(m),
  });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    ...(withWork ? { work: { service, fromStore } } : {}),
    ...extra,
  });
  return {
    api,
    storage,
    now,
    source,
    sessions,
    queue,
    logs,
    choose: (project) => void (chosen = project),
    async close() {
      await api.close();
      await storage.close();
    },
  };
}

async function get(b: Board, query = '', headers: Record<string, string> = {}) {
  const r = await fetch(`${b.api.url}${WORK_BOARD_ROUTE}${query}`, { headers });
  return { status: r.status, json: (await r.json()) as any };
}

/** Re-reads GitHub: past the 30 s floor of a forced refresh (ADR-0001). */
async function refresh(b: Board, query = '') {
  b.now.add(31_000);
  return get(b, `?refresh=1${query ? `&${query}` : ''}`);
}

const cardsOf = (view: any): any[] => view.columns.flatMap((c: any) => c.cards);
const cardOf = (view: any, n: number) => {
  const hit = cardsOf(view).find((c) => c.number === n);
  assert.ok(hit, `card #${n} is on the board`);
  return hit;
};
const columnOf = (view: any, n: number): string => cardOf(view, n).column;

async function withBoard(fn: (b: Board) => Promise<void>, options?: Parameters<typeof boot>[0]) {
  const b = await boot(options);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

describe('#465/AC-2 GET /api/work: each column comes from the real signals', () => {
  test('#465/AC-2 Given #500 open with no session nor PR, When the board is read, Then #500 is in planning, then walks running → review → done', () =>
    withBoard(async (b) => {
      b.source.items = [issue(500)];
      let r = await get(b);
      assert.equal(r.status, 200);
      assert.equal(columnOf(r.json, 500), 'planning');

      b.sessions.list = [session('s1', 500, 'working')];
      assert.equal(columnOf((await get(b)).json, 500), 'running', 'a working session linked to #500 runs it');

      b.sessions.list = [session('s1', 500, 'idle')];
      b.source.items = [issue(500, { pullRequest: pr() })];
      assert.equal(columnOf((await refresh(b)).json, 500), 'review', 'the PR closing #500 awaits review');

      b.source.items = [issue(500, { pullRequest: pr({ state: 'MERGED', review: 'APPROVED', mergedAt: '2026-10-18T12:00:10Z' }) })];
      r = await refresh(b);
      const done = cardOf(r.json, 500);
      assert.deepEqual([done.column, done.doneBy, done.doneAt], ['done', 'merged', '2026-10-18T12:00:10Z']);
    }));

  test('#465/AC-2 Given an item with an execution plan and no session, Then it stays in planning with the "plano · N passos" badge data', () =>
    withBoard(async (b) => {
      b.source.items = [issue(501, { subIssues: { total: 4, completed: 1 } })];
      const c = cardOf((await get(b)).json, 501);
      assert.deepEqual([c.column, c.plan], ['planning', { steps: 4 }]);
    }));

  test('#465/AC-2 Given an issue in the execution queue, Then it is in queued with its position', () =>
    withBoard(async (b) => {
      b.source.items = [issue(502)];
      b.queue.map.set(k(502), 2);
      const r = await get(b);
      const c = cardOf(r.json, 502);
      assert.deepEqual([c.column, c.queuePosition], ['queued', 2]);
      assert.deepEqual(r.json.queue, { available: true });
    }));

  test('#465/AC-2 Given two sessions linked to #503, Then the card is in the most advanced column and counts 2 sessions', () =>
    withBoard(async (b) => {
      b.source.items = [issue(503)];
      b.sessions.list = [session('s1', 503, 'idle'), session('s2', 503, 'working')];
      const c = cardOf((await get(b)).json, 503);
      assert.equal(c.column, 'running');
      assert.equal(c.sessions.count, 2);
      assert.deepEqual([...c.sessions.ids].sort(), ['s1', 's2']);
    }));

  test('#465/AC-2 Given a closed issue, Then it is done by closed', () =>
    withBoard(async (b) => {
      b.source.items = [issue(504, { state: 'CLOSED', closedAt: '2026-10-17T12:00:00Z', statusId: 'opt-done' })];
      const c = cardOf((await get(b)).json, 504);
      assert.deepEqual([c.column, c.doneBy, c.state], ['done', 'closed', 'closed']);
    }));

  test('#465/AC-2 the six columns always come, in lifecycle order, with their pt-BR labels as data', () =>
    withBoard(async (b) => {
      const r = await get(b);
      assert.deepEqual(
        r.json.columns.map((c: any) => [c.id, c.label, c.count]),
        [
          ['planning', 'Planejamento', 0],
          ['queued', 'Na fila', 0],
          ['running', 'Em execução', 0],
          ['review', 'Em review', 0],
          ['blocked', 'Bloqueado', 0],
          ['done', 'Concluído', 0],
        ],
      );
    }));
});

describe('#465/AC-3 GET /api/work: a blocked card says why', () => {
  test('#465/AC-3 Given a linked session needs the person, Then the card is blocked with "Precisa de você"', () =>
    withBoard(async (b) => {
      b.source.items = [issue(510)];
      b.sessions.list = [session('s1', 510, 'working'), session('s2', 510, 'needs-you')];
      const c = cardOf((await get(b)).json, 510);
      assert.deepEqual([c.column, c.blocked], ['blocked', { reason: 'needs-you', label: 'Precisa de você' }]);
    }));

  test('#465/AC-3 Given changes requested after 3 review rounds, Then the card is blocked with review-rounds', () =>
    withBoard(async (b) => {
      b.source.items = [issue(511, { pullRequest: pr({ review: 'CHANGES_REQUESTED', changesRequested: 3 }) })];
      const c = cardOf((await get(b)).json, 511);
      assert.deepEqual([c.column, c.blocked], ['blocked', { reason: 'review-rounds', label: 'Mudança pedida depois de 3 rodadas' }]);
      assert.deepEqual([c.pullRequest.review, c.pullRequest.changesRequested], ['changes-requested', 3]);
    }));

  test('#465/AC-3 Given the open PR\'s CI failed, Then the card is blocked with ci-failed', () =>
    withBoard(async (b) => {
      b.source.items = [issue(512, { pullRequest: pr({ ci: 'FAILURE' }) })];
      const r = await get(b);
      const c = cardOf(r.json, 512);
      assert.deepEqual([c.column, c.blocked], ['blocked', { reason: 'ci-failed', label: 'CI falhou' }]);
      assert.deepEqual(r.json.blockedReasons.map((x: any) => x.id), ['needs-you', 'review-rounds', 'ci-failed']);
    }));
});

describe('#465/AC-4 GET /api/work with GitHub down (ADR-0001)', () => {
  test('#465/AC-4 Given the board was read once, When GitHub does not answer, Then 200 with the last data, stale and the reason', () =>
    withBoard(async (b) => {
      b.source.items = [issue(520, { title: 'last data' })];
      const first = await get(b);
      assert.deepEqual([first.status, first.json.stale, first.json.staleReason], [200, false, null]);
      b.source.fail = new Error('GitHub fora do ar');
      b.source.items = [];
      const r = await refresh(b);
      assert.equal(r.status, 200);
      assert.equal(r.json.stale, true);
      assert.equal(r.json.staleReason, 'github-error');
      assert.equal(cardOf(r.json, 520).title, 'last data');
      assert.equal(r.json.fetchedAt, first.json.fetchedAt, 'fetchedAt stays the last good read (ms)');
      assert.equal(typeof r.json.fetchedAt, 'number');
    }));

  test('#465/AC-4 Given nothing was ever read, When GitHub fails, Then 502 github-unavailable with the reason', () =>
    withBoard(async (b) => {
      b.source.fail = new Error('GitHub fora do ar');
      const r = await get(b);
      assert.equal(r.status, 502);
      assert.equal(r.json.error, 'github-unavailable');
      assert.equal(r.json.reason, 'github-error');
    }));

  test('#465/AC-4 ?refresh=1 re-reads GitHub; without it the cache answers inside its TTL', () =>
    withBoard(async (b) => {
      b.source.items = [issue(521)];
      await get(b);
      await get(b);
      assert.equal(b.source.reads, 1, 'the second read comes from the cache');
      await refresh(b);
      assert.equal(b.source.reads, 2, 'the refresh re-read GitHub');
    }));

  test('#465/AC-4 ADR-0015 with the background sync, the stored board answers without calling GitHub', () =>
    withBoard(
      async (b) => {
        b.source.items = [issue(522)];
        await get(b);
        b.source.fail = new Error('não deveria chamar');
        b.now.add(10 * 60_000);
        const r = await get(b);
        assert.equal(r.status, 200);
        assert.equal(b.source.reads, 1, 'answered from the store');
        assert.equal(columnOf(r.json, 522), 'planning');
      },
      { fromStore: true },
    ));
});

describe('#495/AC-1 GET /api/work with GitHub down: a stable English reason code, never the raw message', () => {
  const FAILURES: [string, () => Error, string][] = [
    ['a network failure', () => new TypeError('fetch failed'), 'network'],
    ['the rate limit', () => new RateLimitedError('GitHub limitou', 60_000), 'rate-limited'],
    ['a missing token scope', () => new GithubScopeError('token sem escopo project'), 'no-scope'],
    ['a Project permission failure', () => new ProjectPermissionError('detail'), 'no-scope'],
    ['any other error', () => new Error('GitHub fora do ar'), 'github-error'],
    ['a gateway error', () => new GithubGatewayError('bad gateway', 502), 'github-error'],
  ];

  for (const [name, make, code] of FAILURES) {
    test(`#495/AC-1 Given the board was read once, When GitHub fails with ${name}, Then 200 stale with staleReason "${code}" and no raw message`, () =>
      withBoard(async (b) => {
        b.source.items = [issue(540, { title: 'last data' })];
        await get(b);
        const error = make();
        b.source.fail = error;
        const r = await refresh(b);
        assert.equal(r.status, 200);
        assert.deepEqual([r.json.stale, r.json.staleReason], [true, code]);
        assert.equal(cardOf(r.json, 540).title, 'last data');
        assert.ok(!JSON.stringify(r.json).includes(error.message), 'the raw message is not in the body');
        assert.ok(b.logs.some((l) => l.includes(error.message)), 'the raw message went to the core log');
      }));

    test(`#495/AC-1 Given nothing was ever read, When GitHub fails with ${name}, Then 502 github-unavailable with reason "${code}"`, () =>
      withBoard(async (b) => {
        const error = make();
        b.source.fail = error;
        const r = await get(b);
        assert.equal(r.status, 502);
        assert.deepEqual(r.json, { error: 'github-unavailable', reason: code });
        assert.ok(b.logs.some((l) => l.includes(error.message)), 'the raw message went to the core log');
      }));
  }

  test('#495/AC-1 Given the cache is paused by the rate limit, When the board is read again, Then stale with "rate-limited"', () =>
    withBoard(async (b) => {
      b.source.items = [issue(541)];
      await get(b);
      b.source.fail = new RateLimitedError('GitHub limitou', 600_000);
      await refresh(b);
      b.source.fail = null;
      const r = await refresh(b);
      assert.deepEqual([r.status, r.json.stale, r.json.staleReason], [200, true, 'rate-limited']);
    }));

  test('#495/AC-1 Given the identity changed under the read, Then 502 with "github-error"', () =>
    withBoard(async (b) => {
      b.source.fail = new NoDataError('sem dados: a conexão com o GitHub mudou');
      const r = await get(b);
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'github-error' }]);
    }));

  test('#495/AC-1 Given the background sync, When the stored board is too old, Then stale carries the code of the last failure, else "sync-pending"', () =>
    withBoard(
      async (b) => {
        b.source.items = [issue(542)];
        await get(b);
        b.now.add(10 * 60_000);
        const noFailure = await get(b);
        assert.deepEqual([noFailure.json.stale, noFailure.json.staleReason], [true, 'sync-pending'], 'no failure recorded');
        b.source.fail = new TypeError('fetch failed');
        await refresh(b, '');
        b.now.add(10 * 60_000);
        const r = await get(b);
        assert.deepEqual([r.status, r.json.stale, r.json.staleReason], [200, true, 'network']);
        assert.ok(!JSON.stringify(r.json).includes('fetch failed'));
      },
      { fromStore: true },
    ));
});

/** #465/AC-5 every key of a JSON value, recursively, with the object keys above it (array indices skipped); values are not looked at. */
function keysOf(value: unknown, path: readonly string[] = [], out: { key: string; path: readonly string[] }[] = []): { key: string; path: readonly string[] }[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, path, out);
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      out.push({ key, path });
      keysOf(v, [...path, key], out);
    }
  }
  return out;
}

/** #465/AC-5 the map keys under a card's `children` are column and reason ids (kebab-case data), not camelCase identifiers. */
const COLUMN_IDS: readonly string[] = WORK_BOARD_COLUMNS.map((c) => c.id);
const REASON_IDS: readonly string[] = WORK_BLOCKED_REASONS.map((r) => r.id);
const under = (path: readonly string[], ...tail: string[]) => path.length >= tail.length && tail.every((t, i) => path[path.length - tail.length + i] === t);

/** #465/AC-5 checks every key of a response: map keys against their id lists, every other key against ENGLISH_KEY. */
function assertEnglishKeys(json: unknown) {
  for (const { key, path } of keysOf(json)) {
    if (under(path, 'children', 'byColumn')) assert.ok(COLUMN_IDS.includes(key), `children.byColumn key "${key}" is a column id`);
    else if (under(path, 'children', 'blocked')) assert.ok(REASON_IDS.includes(key), `children.blocked key "${key}" is a blocked reason id`);
    else assert.match(key, ENGLISH_KEY, `key "${key}" is an English identifier`);
    assert.doesNotMatch(key, PORTUGUESE_WORDS, `key "${key}" is not Portuguese`);
  }
}

/** #465/AC-5 an English identifier: ASCII letters and digits in camelCase, nothing accented. */
const ENGLISH_KEY = /^[a-z][a-zA-Z0-9]*$/;
/** #465/AC-5 keys that read as Portuguese even in ASCII. */
const PORTUGUESE_WORDS = /(coluna|quadro|cartao|sessao|sessoes|motivo|filtro|nivel|pai|filhos|rotulo|tipo|fila|passos|bloque|concluid|titulo|projeto|estado)/i;

describe('#465/AC-5 GET /api/work: English internals, pt-BR on screen (decision 0009)', () => {
  test('#465/AC-5 Given a full board, Then every JSON key in the response is English', () =>
    withBoard(async (b) => {
      b.source.items = [
        issue(1, { type: 'Initiative', labels: ['roadmap'] }),
        issue(6, { type: 'Epic', parent: k(1), milestone: 'M1' }),
        issue(530, { type: 'Bug', parent: k(6), labels: ['UI'], subIssues: { total: 2, completed: 0 }, pullRequest: pr({ ci: 'FAILURE' }) }),
        issue(531, { type: 'Story', parent: k(6), statusId: null }),
      ];
      b.sessions.list = [session('s1', 531, 'working')];
      const r = await get(b);
      assert.equal(r.status, 200);
      assertEnglishKeys(r.json);

      // #465 at level epic the parent card carries `children`, so its map keys are walked too.
      const epics = await get(b, '?level=epic');
      assert.equal(epics.status, 200);
      const epic = cardOf(epics.json, 6);
      assert.deepEqual(epic.children.blocked, { 'ci-failed': 1 }, 'the blocked child #530 shows in the epic\'s children');
      assert.ok(Object.keys(epic.children.byColumn).length > 0, 'the epic\'s children are counted by column');
      assertEnglishKeys(epics.json);

      for (const key of ['project', 'filters', 'levels', 'columns', 'blockedReasons', 'doneWindowDays', 'queue', 'options', 'total', 'matched', 'fetchedAt', 'stale', 'staleReason']) {
        assert.ok(key in r.json, `top-level key ${key}`);
      }
    }));

  test('#465/AC-5 the query parameters level, initiative, epic, type, label, repo and status are accepted and echoed', () =>
    withBoard(async (b) => {
      b.source.items = [issue(1, { type: 'Initiative' }), issue(6, { type: 'Epic', parent: k(1) }), issue(540, { type: 'Bug', parent: k(6), labels: ['UI'], statusId: 'opt-progress' })];
      const r = await get(b, '?level=item&initiative=1&epic=6&type=bug&label=ui&repo=ahrena-console&status=in-progress');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.filters, { level: 'item', initiative: 1, epic: 6, type: 'bug', label: 'ui', repo: 'ahrena-console', status: 'in-progress' });
      assert.deepEqual(cardsOf(r.json).map((c) => c.number), [540]);
    }));

  for (const [query, param] of [
    ['?level=nivel', 'level'],
    ['?initiative=um', 'initiative'],
    ['?epic=-6', 'epic'],
    ['?type=historia', 'type'],
  ] as const) {
    test(`#465/AC-5 an invalid ${param} gives 400 bad-filter naming the param (${query})`, () =>
      withBoard(async (b) => {
        const r = await get(b, query);
        assert.deepEqual([r.status, r.json], [400, { error: 'bad-filter', param }]);
        assert.equal(b.source.reads, 0, 'GitHub is not read for a bad filter');
      }));
  }
});

describe('#466/AC-2 GET /api/work: the four levels', () => {
  test('#466/AC-2 Given a hierarchy, When ?level= changes, Then the columns show the nodes of that level', () =>
    withBoard(async (b) => {
      b.source.items = [
        issue(1, { type: 'Initiative' }),
        issue(6, { type: 'Epic', parent: k(1) }),
        issue(550, { type: 'Story', parent: k(6) }),
        issue(551, { type: 'Plan', parent: k(550) }),
      ];
      const levels = (await get(b)).json.levels;
      assert.deepEqual(levels, [...WORK_LEVELS]);
      const shown: Record<string, number[]> = {};
      for (const level of WORK_LEVELS) {
        const r = await get(b, `?level=${level}`);
        assert.equal(r.status, 200, level);
        assert.equal(r.json.filters.level, level);
        shown[level] = cardsOf(r.json).map((c) => c.number);
      }
      assert.deepEqual(shown, { initiative: [1], epic: [6], item: [550], plan: [551] });
    }));

  test('#466/AC-2 without ?level the board shows items', () =>
    withBoard(async (b) => {
      b.source.items = [issue(6, { type: 'Epic' }), issue(552, { parent: k(6) })];
      const r = await get(b);
      assert.equal(r.json.filters.level, 'item');
      assert.deepEqual(cardsOf(r.json).map((c) => c.number), [552]);
    }));
});

describe('#466/AC-3 GET /api/work: filters combine by AND and live in the URL in English', () => {
  test('#466/AC-3 Given initiative #1, epic #6 and type bug, Then only the bugs descending from #6 show, and the counts say how many matched', () =>
    withBoard(async (b) => {
      b.source.items = [
        issue(1, { type: 'Initiative' }),
        issue(2, { type: 'Initiative' }),
        issue(6, { type: 'Epic', parent: k(1) }),
        issue(7, { type: 'Epic', parent: k(1) }),
        issue(8, { type: 'Epic', parent: k(2) }),
        issue(560, { type: 'Bug', parent: k(6) }),
        issue(561, { type: 'Story', parent: k(6) }),
        issue(562, { type: 'Bug', parent: k(7) }),
        issue(563, { type: 'Bug', parent: k(8) }),
      ];
      const r = await get(b, '?initiative=1&epic=6&type=bug');
      assert.deepEqual(cardsOf(r.json).map((c) => c.number), [560]);
      assert.deepEqual([r.json.total, r.json.matched], [4, 1]);
      assert.deepEqual(r.json.options.types.map((t: any) => [t.id, t.count]), [['story', 1], ['bug', 1]], 'the type counts inside epic #6');
      const epic = r.json.options.epics.find((e: any) => e.number === 6);
      assert.deepEqual(epic, { key: k(6), repo: REPO, number: 6, title: 'issue 6', count: 1 });
    }));

  test('#466/AC-3 Given a label no issue has, Then every column is empty and matched is 0', () =>
    withBoard(async (b) => {
      b.source.items = [issue(570, { labels: ['UI'] })];
      const r = await get(b, '?label=nenhuma');
      assert.equal(r.status, 200);
      assert.ok(r.json.columns.every((c: any) => c.cards.length === 0 && c.count === 0));
      assert.deepEqual([r.json.total, r.json.matched], [1, 0]);
    }));

  test('#466/AC-3 repo and Project status filter by AND', () =>
    withBoard(async (b) => {
      b.source.items = [
        issue(580, { statusId: 'opt-progress' }),
        issue(581, { statusId: 'opt-todo' }),
        issue(582, { statusId: 'opt-progress', repo: 'ahrenatechnology/outro', key: 'ahrenatechnology/outro#582' }),
      ];
      const r = await get(b, `?repo=${encodeURIComponent(REPO)}&status=in-progress`);
      assert.deepEqual(cardsOf(r.json).map((c) => c.number), [580]);
      assert.deepEqual(cardOf(r.json, 580).projectStatus, { id: 'in-progress', name: 'In Progress' });
    }));
});

describe('#466/AC-4 GET /api/work: the item shows its chain of parents', () => {
  test('#466/AC-4 Given #590 under epic #6 under initiative #1, Then its chain is #1 › #6 and its parent is #6', () =>
    withBoard(async (b) => {
      b.source.items = [issue(1, { type: 'Initiative', title: 'Iniciativa' }), issue(6, { type: 'Epic', parent: k(1), title: 'Épico' }), issue(590, { parent: k(6) })];
      const c = cardOf((await get(b, '?epic=6')).json, 590);
      assert.deepEqual(c.chain, [
        { key: k(1), number: 1, title: 'Iniciativa', level: 'initiative' },
        { key: k(6), number: 6, title: 'Épico', level: 'epic' },
      ]);
      assert.deepEqual(c.parent, { key: k(6), number: 6 });
    }));
});

describe('GET /api/work errors', () => {
  test('no Project chosen: 503 no-project', () =>
    withBoard(async (b) => {
      b.choose(false);
      const r = await get(b);
      assert.deepEqual([r.status, r.json.error], [503, 'no-project']);
    }));

  test('--no-github: the route is not wired and answers 503 off', () =>
    withBoard(
      async (b) => {
        const r = await get(b);
        assert.deepEqual([r.status, r.json.error], [503, 'off']);
      },
      { withWork: false },
    ));

  test('#241 GitHub not connected: 409 github-not-connected before any read', () =>
    withBoard(
      async (b) => {
        const r = await get(b);
        assert.deepEqual([r.status, r.json], [409, { error: 'github-not-connected' }]);
        assert.equal(b.source.reads, 0);
      },
      { extra: { githubConnected: async () => false } },
    ));

  test('only GET: another method is 405', () =>
    withBoard(async (b) => {
      const r = await fetch(`${b.api.url}${WORK_BOARD_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([r.status, await r.json()], [405, { error: 'method-not-allowed' }]);
      assert.equal(b.source.reads, 0);
    }));

  test('another site\'s page never reads the board (it spends GitHub quota): 403', () =>
    withBoard(async (b) => {
      b.source.items = [issue(600)];
      const r = await get(b, '', { 'sec-fetch-site': 'cross-site' });
      assert.equal(r.status, 403);
      assert.equal(b.source.reads, 0);
    }));

  test('#465 another site\'s page with GitHub not connected: 403, refused before the 409 github-not-connected gate', () =>
    withBoard(
      async (b) => {
        const r = await get(b, '', { 'sec-fetch-site': 'cross-site' });
        assert.equal(r.status, 403, 'the cross-site refusal comes before the GitHub connection gate');
        assert.notEqual(r.json.error, 'github-not-connected');
        assert.equal(b.source.reads, 0);
      },
      { extra: { githubConnected: async () => false } },
    ));
});

describe('#501/AC-1 GET /api/work: counts without each active filter', () => {
  const OTHER = 'ahrenatechnology/outro';
  const elsewhere = (n: number, over: Partial<ProjectCard> = {}) => issue(n, { repo: OTHER, key: `${OTHER}#${n}`, ...over });
  const items = () => [
    issue(700),
    issue(701),
    issue(702, { state: 'CLOSED', closedAt: '2026-10-17T12:00:00Z', statusId: 'opt-done' }),
    issue(703, { state: 'CLOSED', closedAt: '2026-09-01T12:00:00Z', statusId: 'opt-done' }),
    elsewhere(710, { type: 'Bug' }),
    elsewhere(711, { type: 'Bug', state: 'CLOSED', closedAt: '2026-08-01T12:00:00Z', statusId: 'opt-done' }),
  ];

  test('#501/AC-1 Given type=bug and repo=x and no card matching both, Then each count is what the other filter alone shows, trimmed by the done window', () =>
    withBoard(async (b) => {
      b.source.items = items();
      const r = await get(b, `?type=bug&repo=${encodeURIComponent(REPO)}`);
      assert.equal(r.json.matched, 0);
      assert.deepEqual(r.json.countsWithoutFilter, { type: 3, repo: 1 });
    }));

  test('#501/AC-2 Given no filter, Then countsWithoutFilter is present and empty', () =>
    withBoard(async (b) => {
      b.source.items = items();
      const r = await get(b);
      assert.deepEqual(r.json.countsWithoutFilter, {});
    }));
});
