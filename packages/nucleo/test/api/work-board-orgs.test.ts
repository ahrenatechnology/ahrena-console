import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #598 #609 GET /api/work over every granted organization, through the HTTP route: the core's real server, the use case, the
 * per-Project ADR-0001 cache, the Projects reader and the SQLite column history; GitHub (the Projects list and each Project's
 * board), the connection's organizations and the sessions are fakes. Each scenario names the acceptance criterion it covers.
 * The contract block pins the shape the screen of layer 3 reads: it is written out here, not taken from what the handler returns.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { WORK_BOARD_ROUTE } from '../../src/api/work-board.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubGatewayError } from '../../src/github/github-source.ts';
import type { GithubOrg } from '../../src/github/connection/connection.ts';
import { GithubProject, type ProjectBoardValue, type ProjectCard, type ProjectRef, type ProjectSource } from '../../src/github/project.ts';
import { ProjectOptions, type ProjectOption, type ProjectOptionsRead, type ProjectOptionsReader, type ProjectOwner } from '../../src/github/project-options.ts';
import { InstallationRepositoryTrust } from '../../src/github/trusted-owners.ts';
import { EMPTY_WORK_QUEUE, type WorkSessionLink, type WorkSessions } from '../../src/github/work-board.ts';
import { SqliteWorkColumnHistory } from '../../src/github/work-board-history.ts';
import { WorkBoardProjects } from '../../src/github/work-board-projects.ts';
import { WorkBoardService } from '../../src/github/work-board-service.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { clock } from '../github/helpers.ts';

const ACCOUNT = 'mira-dev';
const raw = (owner: string, number: number, title: string, over: Partial<ProjectOption> = {}): ProjectOption => ({
  owner,
  ownerType: owner === ACCOUNT ? 'user' : 'organization',
  number,
  title,
  url: `https://github.com/orgs/${owner}/projects/${number}`,
  items: 3,
  hasStatusField: true,
  closed: false,
  ...over,
});

const lanes = (prefix: string) => [
  { id: `${prefix}-todo`, name: 'Todo', color: 'GREEN' },
  { id: `${prefix}-done`, name: 'Done', color: 'PURPLE' },
];

function issue(owner: string, n: number, over: Partial<ProjectCard> = {}, prefix = owner): ProjectCard {
  return {
    itemId: `PVTI_${owner}_${n}`,
    kind: 'Issue',
    key: `${owner}/app#${n}`,
    repo: `${owner}/app`,
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/${owner}/app/issues/${n}`,
    state: 'OPEN',
    updatedAt: '2026-10-18T10:00:00Z',
    type: 'Task',
    parent: null,
    statusId: `${prefix}-todo`,
    milestone: null,
    subIssues: null,
    pullRequest: null,
    labels: [],
    closedAt: null,
    ...over,
  };
}

/** #609 One Project on GitHub: `items` is what the next read answers; `fail` makes the read fail. */
class FakeProject implements ProjectSource {
  items: ProjectCard[] = [];
  fail: Error | null = null;
  private readonly title: string;
  private readonly prefix: string;
  constructor(title: string, prefix: string) {
    this.title = title;
    this.prefix = prefix;
  }
  async board(ref: ProjectRef): Promise<ProjectBoardValue> {
    if (this.fail) throw this.fail;
    return { projectId: `PVT_${ref.owner}_${ref.number}`, fieldId: 'PVTSSF_1', field: 'Status', title: this.title, url: `https://github.com/orgs/${ref.owner}/projects/${ref.number}`, options: lanes(this.prefix), items: this.items };
  }
  async move(): Promise<never> {
    throw new Error('the work board never moves a card');
  }
}

class FakeOptions implements ProjectOptionsReader {
  read: ProjectOptionsRead = { projects: [], owners: [] };
  async list(): Promise<ProjectOptionsRead> {
    return this.read;
  }
}

class NoSessions implements WorkSessions {
  async links(): Promise<WorkSessionLink[]> {
    return [];
  }
}

const owner = (login: string, over: Partial<ProjectOwner> = {}): ProjectOwner => ({ login, ownerType: login === ACCOUNT ? 'user' : 'organization', projects: null, blocked: null, ...over });
const GITHUB_MESSAGE = 'Although you appear to have the correct authorization credentials, the `Umbrella` organization has enabled OAuth App access restrictions';

interface Rig {
  api: Awaited<ReturnType<typeof startLocalApi>>;
  storage: SqliteStorage;
  now: ReturnType<typeof clock>;
  projects: Map<string, FakeProject>;
  options: FakeOptions;
  orgs: { list: GithubOrg[] };
  settings: MemoryInstallationSettings;
  reader: WorkBoardProjects;
  logs: string[];
  close(): Promise<void>;
}

/** #609 The default world: acme-labs (3, 4), northwind (1) granted, and the account mira-dev (1). */
async function boot(): Promise<Rig> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const now = clock();
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const projects = new Map<string, FakeProject>([
    ['acme-labs/3', new FakeProject('Platform', 'acme3')],
    ['acme-labs/4', new FakeProject('Mobile', 'acme4')],
    ['northwind/1', new FakeProject('Roadmap', 'nw1')],
    [`${ACCOUNT}/1`, new FakeProject('Experiments', 'mira1')],
  ]);
  projects.get('acme-labs/3')!.items = [issue('acme-labs', 509, { type: 'Bug' }, 'acme3'), issue('acme-labs', 510, {}, 'acme3')];
  projects.get('acme-labs/4')!.items = [issue('acme-labs', 499, {}, 'acme4')];
  projects.get('northwind/1')!.items = [issue('northwind', 503, { type: 'Bug' }, 'nw1')];
  projects.get(`${ACCOUNT}/1`)!.items = [issue(ACCOUNT, 511, {}, 'mira1')];
  const options = new FakeOptions();
  options.read = {
    projects: [raw('acme-labs', 3, 'Platform'), raw('acme-labs', 4, 'Mobile'), raw('northwind', 1, 'Roadmap'), raw(ACCOUNT, 1, 'Experiments')],
    owners: [owner('acme-labs'), owner('northwind'), owner(ACCOUNT)],
  };
  const orgs = { list: [{ login: 'acme-labs', access: 'granted' }, { login: 'northwind', access: 'granted' }] as GithubOrg[] };
  const logs: string[] = [];
  const reader = new WorkBoardProjects({
    options: new ProjectOptions({ source: options, cache, queue: new GithubCallQueue() }),
    orgs: async () => orgs.list,
    project: (ref) => new GithubProject({ source: projects.get(`${ref.owner}/${ref.number}`)!, cache, project: ref, now }),
    now,
    log: (m) => logs.push(m),
  });
  const settings = new MemoryInstallationSettings();
  const service = new WorkBoardService({
    trust: new InstallationRepositoryTrust(settings, () => null, () => reader.readOwners()),
    project: { board: async () => assert.fail('the single Project is not read when the Projects reader is there') },
    projects: reader,
    sessions: new NoSessions(),
    queue: EMPTY_WORK_QUEUE,
    history: new SqliteWorkColumnHistory(storage.db),
    now,
    log: (m) => logs.push(m),
  });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder, hooks: { storage }, port: 0, log: () => {}, work: { service } });
  return {
    api,
    storage,
    now,
    projects,
    options,
    orgs,
    settings,
    reader,
    logs,
    async close() {
      await api.close();
      await storage.close();
    },
  };
}

async function get(r: Rig, query = '') {
  const res = await fetch(`${r.api.url}${WORK_BOARD_ROUTE}${query}`);
  return { status: res.status, json: (await res.json()) as any };
}

async function withRig(fn: (r: Rig) => Promise<void>) {
  const r = await boot();
  try {
    await fn(r);
  } finally {
    await r.close();
  }
}

const cardsOf = (view: any): any[] => view.columns.flatMap((c: any) => c.cards);
const numbersOf = (view: any): number[] => cardsOf(view).map((c) => c.number).sort((a, b) => a - b);
const entry = (view: any, login: string) => view.organizations.find((o: any) => o.login === login);

describe('#609/AC-1 GET /api/work joins the Projects of every granted organization and of the account', () => {
  test('#609/AC-1 Given acme-labs and northwind granted and the account with a Project, When the board is read without ?project=, Then it carries the items of every Project, each card with its origin', () =>
    withRig(async (r) => {
      const { status, json } = await get(r);
      assert.equal(status, 200);
      assert.deepEqual(numbersOf(json), [499, 503, 509, 510, 511]);
      const origin = (n: number) => cardsOf(json).find((c) => c.number === n).origin;
      assert.deepEqual(origin(509), { organization: 'acme-labs', project: { owner: 'acme-labs', number: 3, title: 'Platform' } });
      assert.deepEqual(origin(499), { organization: 'acme-labs', project: { owner: 'acme-labs', number: 4, title: 'Mobile' } });
      assert.deepEqual(origin(503), { organization: 'northwind', project: { owner: 'northwind', number: 1, title: 'Roadmap' } });
      assert.deepEqual(origin(511), { organization: ACCOUNT, project: { owner: ACCOUNT, number: 1, title: 'Experiments' } });
      assert.equal(json.total, 5);
    }));

  test('#609/AC-1 Then organizations[] summarises each owner and the Projects read, the account last, and project is null', () =>
    withRig(async (r) => {
      const { json } = await get(r);
      assert.deepEqual(
        json.organizations.map((o: any) => [o.login, o.own, o.state, o.projects.map((p: any) => p.number)]),
        [
          ['acme-labs', false, 'read', [3, 4]],
          ['northwind', false, 'read', [1]],
          [ACCOUNT, true, 'read', [1]],
        ],
      );
      assert.equal(json.organizations[0].readAt, r.now());
      assert.equal(json.project, null, 'several Projects: no single Project heads the board');
      assert.deepEqual(
        json.options.orgs.map((o: any) => [o.login, o.own, o.count]),
        [['acme-labs', false, 3], ['northwind', false, 1], [ACCOUNT, true, 1]],
      );
      assert.deepEqual(
        json.options.projects.map((p: any) => [p.owner, p.number, p.title, p.count]),
        [['acme-labs', 3, 'Platform', 2], ['acme-labs', 4, 'Mobile', 1], ['northwind', 1, 'Roadmap', 1], [ACCOUNT, 1, 'Experiments', 1]],
      );
    }));

  test('#609/AC-1 Given exactly one Project read, Then project names it for the screen to keep today\'s header', () =>
    withRig(async (r) => {
      r.orgs.list = [];
      r.options.read = { projects: [raw(ACCOUNT, 1, 'Experiments')], owners: [owner(ACCOUNT)] };
      const { json } = await get(r);
      assert.deepEqual([json.project.owner, json.project.number, json.project.title], [ACCOUNT, 1, 'Experiments']);
      assert.deepEqual(numbersOf(json), [511]);
    }));

  test('#609/AC-1 Given closed Projects and Projects with no Status field, Then they are skipped', () =>
    withRig(async (r) => {
      r.options.read.projects.push(raw('acme-labs', 5, 'Archive', { closed: true }), raw('northwind', 2, 'Notes', { hasStatusField: false }));
      const { json } = await get(r);
      assert.deepEqual(entry(json, 'acme-labs').projects.map((p: any) => p.number), [3, 4]);
      assert.deepEqual(entry(json, 'northwind').projects.map((p: any) => p.number), [1]);
    }));

  test('#609/AC-1 Given the same issue in two Projects, Then it is shown once, under the first', () =>
    withRig(async (r) => {
      r.projects.get('acme-labs/4')!.items.push(issue('acme-labs', 509, {}, 'acme4'));
      const { json } = await get(r);
      const same = cardsOf(json).filter((c) => c.number === 509);
      assert.equal(same.length, 1);
      assert.equal(same[0].origin.project.number, 3);
    }));
});

describe('#609/AC-2 ?org= and ?project= filter the board, and the other filters still hold over the set', () => {
  test('#609/AC-2 Given ?org=acme-labs (any letter case), Then only that organization\'s cards come, and filters echoes it', () =>
    withRig(async (r) => {
      const { json } = await get(r, '?org=ACME-Labs');
      assert.deepEqual(numbersOf(json), [499, 509, 510]);
      assert.equal(json.filters.org, 'ACME-Labs');
      assert.equal(json.filters.project, null);
    }));

  test('#609/AC-2 Given ?project=acme-labs/3, Then only that Project\'s cards come, project names it, and filters echoes it', () =>
    withRig(async (r) => {
      const { json } = await get(r, '?project=acme-labs/3');
      assert.deepEqual(numbersOf(json), [509, 510]);
      assert.deepEqual([json.project.owner, json.project.number, json.project.title], ['acme-labs', 3, 'Platform']);
      assert.equal(json.filters.project, 'acme-labs/3');
    }));

  test('#609/AC-2 Given ?org, ?project and the six other filters together, Then they combine by AND', () =>
    withRig(async (r) => {
      r.projects.get('acme-labs/3')!.items[0] = issue('acme-labs', 509, { type: 'Bug', labels: ['urgent'] }, 'acme3');
      const all = await get(r, '?org=acme-labs&project=acme-labs/3&type=bug&label=urgent&repo=app&status=todo');
      assert.deepEqual(numbersOf(all.json), [509]);
      const narrower = await get(r, '?org=acme-labs&project=acme-labs/3&type=bug&label=nope');
      assert.deepEqual(numbersOf(narrower.json), []);
      const bugs = await get(r, '?type=bug');
      assert.deepEqual(numbersOf(bugs.json), [503, 509], 'a filter alone spans organizations');
    }));

  test('#609/AC-2 Given Projects whose Status options have different ids but the same name, Then ?status= matches them all', () =>
    withRig(async (r) => {
      const { json } = await get(r, '?status=todo');
      assert.deepEqual(numbersOf(json), [499, 503, 509, 510, 511]);
      assert.deepEqual(json.options.statuses.map((s: any) => [s.id, s.count]), [['todo', 5], ['done', 0]]);
    }));

  test('#609/AC-2 Given a ?project= from another organization than ?org=, Then 200 with an empty set', () =>
    withRig(async (r) => {
      const { status, json } = await get(r, '?org=northwind&project=acme-labs/3');
      assert.equal(status, 200);
      assert.deepEqual(numbersOf(json), []);
    }));

  test('#609/AC-2 Given a malformed ?project= or ?org=, Then 400 bad-filter naming the param', () =>
    withRig(async (r) => {
      for (const bad of ['acme-labs', 'acme-labs/', 'acme-labs/0', 'acme-labs/three', '/3', 'a/b/3']) {
        const { status, json } = await get(r, `?project=${encodeURIComponent(bad)}`);
        assert.deepEqual([status, json], [400, { error: 'bad-filter', param: 'project' }], bad);
      }
      const { status, json } = await get(r, `?org=${encodeURIComponent('not a login')}`);
      assert.deepEqual([status, json], [400, { error: 'bad-filter', param: 'org' }]);
    }));
});

describe('#609/AC-3 an organization that restricts the app or fails to read becomes a warning, the others stay', () => {
  test('#609/AC-3 Given an org in orgs.pending, one behind SAML and one whose read fails, Then each is an entry with its state and a reason code, never GitHub\'s message', () =>
    withRig(async (r) => {
      r.orgs.list.push(
        { login: 'globex', access: 'pending', approvalUrl: 'https://github.com/organizations/globex/settings/oauth_application_policy', requestUrl: 'https://github.com/settings/connections/applications/x' },
        { login: 'umbrella', access: 'granted' },
      );
      r.options.read.owners.push(owner('initech', { blocked: { reason: 'saml', message: GITHUB_MESSAGE } }), owner('umbrella'));
      r.options.read.projects.push(raw('umbrella', 1, 'Secret'));
      r.projects.set('umbrella/1', new FakeProject('Secret', 'umb1'));
      r.projects.get('umbrella/1')!.fail = new GithubGatewayError(GITHUB_MESSAGE, 502);
      const { status, json } = await get(r);
      assert.equal(status, 200);
      assert.deepEqual(numbersOf(json), [499, 503, 509, 510, 511], 'the other organizations stay on the board');
      const globex = entry(json, 'globex');
      assert.deepEqual([globex.state, globex.reason, globex.approvalUrl, globex.requestUrl, globex.projects, globex.readAt], ['restricted', 'oauth-restricted', 'https://github.com/organizations/globex/settings/oauth_application_policy', 'https://github.com/settings/connections/applications/x', [], null]);
      const initech = entry(json, 'initech');
      assert.deepEqual([initech.state, initech.reason, initech.projects, initech.readAt], ['saml', 'saml', [], null]);
      const umbrella = entry(json, 'umbrella');
      assert.deepEqual([umbrella.state, umbrella.reason, umbrella.projects, umbrella.readAt], ['failed', 'github-error', [], null]);
      assert.equal(JSON.stringify(json).includes('OAuth App access restrictions'), false, 'GitHub\'s message never reaches the response');
      assert.equal(json.organizations.at(-1).login, ACCOUNT, 'the account stays last');
    }));

  test('#609/AC-3 Given an org read before that now fails, Then its stored cards stay with the time of its last read, and the others are not touched', () =>
    withRig(async (r) => {
      await get(r);
      const readAt = r.now();
      r.now.add(31 * 60_000);
      r.projects.get('northwind/1')!.fail = new GithubGatewayError('boom', 502);
      const { status, json } = await get(r, '?refresh=1');
      assert.equal(status, 200);
      assert.deepEqual(numbersOf(json), [499, 503, 509, 510, 511], 'northwind keeps its stored card');
      const northwind = entry(json, 'northwind');
      assert.deepEqual([northwind.state, northwind.reason, northwind.readAt], ['failed', 'github-error', readAt]);
      assert.deepEqual(northwind.projects.map((p: any) => p.number), [1]);
      assert.equal(entry(json, 'acme-labs').state, 'read');
      assert.equal(entry(json, 'acme-labs').readAt, r.now());
    }));

  test('#609/AC-3 Given every organization failed and nothing stored, Then 502 github-unavailable with a reason code', () =>
    withRig(async (r) => {
      for (const p of r.projects.values()) p.fail = new GithubGatewayError(GITHUB_MESSAGE, 502);
      const { status, json } = await get(r);
      assert.deepEqual([status, json], [502, { error: 'github-unavailable', reason: 'github-error' }]);
    }));

  test('#609/AC-3 Given GitHub fully down after a read, Then it is the stale of today, not a warning per organization', () =>
    withRig(async (r) => {
      await get(r);
      r.now.add(31 * 60_000);
      for (const p of r.projects.values()) p.fail = new GithubGatewayError('down', 502);
      const { status, json } = await get(r, '?refresh=1');
      assert.equal(status, 200);
      assert.deepEqual([json.stale, json.staleReason], [true, 'github-error']);
      assert.deepEqual(numbersOf(json), [499, 503, 509, 510, 511]);
      assert.deepEqual(json.organizations.map((o: any) => o.state), ['read', 'read', 'read']);
    }));

  test('#609/AC-3 Given one organization with Project 3 fresh and Project 4 failing, and the account\'s only Project failing with a network error, Then it is not stale for all: both owners are failed warnings and the fresh Project\'s cards are shown', () =>
    withRig(async (r) => {
      r.projects.get('acme-labs/4')!.fail = new GithubGatewayError('boom', 502);
      r.projects.get(`${ACCOUNT}/1`)!.fail = new TypeError('fetch failed');
      r.orgs.list = [{ login: 'acme-labs', access: 'granted' }];
      const { status, json } = await get(r);
      assert.equal(status, 200);
      assert.deepEqual([json.stale, json.staleReason], [false, null]);
      assert.deepEqual(numbersOf(json), [509, 510], 'the fresh Project\'s cards stay');
      const acme = entry(json, 'acme-labs');
      assert.deepEqual([acme.state, acme.reason, acme.projects.map((p: any) => p.number)], ['failed', 'github-error', [3]]);
      const account = entry(json, ACCOUNT);
      assert.deepEqual([account.state, account.reason, account.own, account.projects, account.readAt], ['failed', 'network', true, [], null]);
      assert.deepEqual(r.reader.readOwners(), [], 'an owner with a failed Project is not a trusted read owner');
    }));

  test('#609/AC-3 Given an organization whose Project 4 failed after a read, Then it keeps the stored cards of Project 4 with their readAt, is failed, and owners all read stay read', () =>
    withRig(async (r) => {
      await get(r);
      const readAt = r.now();
      r.now.add(31 * 60_000);
      r.projects.get('acme-labs/4')!.fail = new GithubGatewayError('boom', 502);
      const { json } = await get(r, '?refresh=1');
      assert.deepEqual([json.stale, numbersOf(json)], [false, [499, 503, 509, 510, 511]]);
      const acme = entry(json, 'acme-labs');
      assert.deepEqual([acme.state, acme.reason, acme.readAt, acme.projects.map((p: any) => p.number)], ['failed', 'github-error', readAt, [3, 4]]);
      assert.equal(entry(json, 'northwind').state, 'read');
      assert.equal(entry(json, ACCOUNT).state, 'read');
      assert.deepEqual(r.reader.readOwners().sort(), ['northwind', ACCOUNT].sort());
    }));

  test('#609/AC-3 Given only restricted organizations and no account Project, Then 200 with the warnings and an empty board', () =>
    withRig(async (r) => {
      r.orgs.list = [{ login: 'globex', access: 'pending', approvalUrl: 'https://example.test/approve', requestUrl: 'https://example.test/request' }];
      r.options.read = { projects: [], owners: [owner(ACCOUNT)] };
      const { status, json } = await get(r);
      assert.equal(status, 200);
      assert.deepEqual(numbersOf(json), []);
      assert.equal(entry(json, 'globex').state, 'restricted');
    }));
});

describe('#609/AC-4 without a stored work.trustedOwners, the trusted owners are the owners of the Projects read', () => {
  const trustedOf = (view: any) => Object.fromEntries(cardsOf(view).map((c) => [c.repo, c.trusted]));

  test('#609/AC-4 Given no stored list, Then the read organizations and the account are trusted, and an organization with a warning is not', () =>
    withRig(async (r) => {
      r.orgs.list.push({ login: 'globex', access: 'pending', approvalUrl: 'https://example.test/a', requestUrl: 'https://example.test/r' });
      const { json } = await get(r);
      assert.deepEqual(trustedOf(json), { 'acme-labs/app': true, 'northwind/app': true, [`${ACCOUNT}/app`]: true });
      assert.deepEqual(r.reader.readOwners().sort(), ['acme-labs', ACCOUNT, 'northwind'].sort());
      assert.equal(r.reader.readOwners().includes('globex'), false);
    }));

  test('#609/AC-4 Given a stored list, Then it wins over the Projects read', () =>
    withRig(async (r) => {
      r.settings.set('work.trustedOwners', ['northwind']);
      const { json } = await get(r);
      assert.deepEqual(trustedOf(json), { 'acme-labs/app': false, 'northwind/app': true, [`${ACCOUNT}/app`]: false });
    }));
});

describe('#609 contract: the shape of GET /api/work the screen of layer 3 reads', () => {
  const sorted = (o: object) => Object.keys(o).sort();

  test('#609/AC-1 every card carries origin { organization, project: { owner, number, title } }', () =>
    withRig(async (r) => {
      const { json } = await get(r);
      for (const c of cardsOf(json)) {
        assert.deepEqual(sorted(c.origin), ['organization', 'project']);
        assert.deepEqual(sorted(c.origin.project), ['number', 'owner', 'title']);
        assert.equal(typeof c.origin.project.number, 'number');
      }
    }));

  test('#609/AC-1 an organizations[] entry is login, own, state, readAt, projects[] (and the optional reason, approvalUrl, requestUrl only on a warning)', () =>
    withRig(async (r) => {
      r.orgs.list.push({ login: 'globex', access: 'pending', approvalUrl: 'https://example.test/a', requestUrl: 'https://example.test/r' });
      const { json } = await get(r);
      assert.deepEqual(sorted(entry(json, 'acme-labs')), ['login', 'own', 'projects', 'readAt', 'state']);
      assert.deepEqual(sorted(entry(json, 'globex')), ['approvalUrl', 'login', 'own', 'projects', 'readAt', 'reason', 'requestUrl', 'state']);
      assert.deepEqual(sorted(entry(json, 'acme-labs').projects[0]), ['number', 'owner', 'title']);
      assert.ok(['read', 'restricted', 'saml', 'failed'].includes(entry(json, 'globex').state));
    }));

  test('#609/AC-2 options.orgs is { login, own, count }, options.projects is { owner, number, title, count }, and filters has org and project', () =>
    withRig(async (r) => {
      const { json } = await get(r, '?org=northwind');
      assert.deepEqual(sorted(json.options.orgs[0]), ['count', 'login', 'own']);
      assert.deepEqual(sorted(json.options.projects[0]), ['count', 'number', 'owner', 'title']);
      assert.deepEqual(sorted(json.filters), ['epic', 'initiative', 'label', 'level', 'org', 'project', 'repo', 'status', 'type']);
      assert.equal(json.countsWithoutFilter.org, 5, 'with the org filter off the board would show every card');
    }));
});
