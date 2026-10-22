// Every GitHub-backed screen built in one place (#241, decision 0011 §4-5): `createGithubScreens`
// builds them with the one credential provider and, on an identity change (disconnect, another
// login, another source), deletes every row of `github_cache`, drops what is in flight and builds
// the services again behind the same route functions, so nothing read with the previous identity is
// served afterwards.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts } from '../../src/api/index.ts';
import { createGithubScreens, type GithubScreensOptions } from '../../src/api/github-screens.ts';
import { TrabalhoPorBranch } from '../../src/api/work.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { FleetReader } from '../../src/mcp/fleet.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEscreens00000000000000000000000';
const dir = mkdtempSync(join(tmpdir(), 'github-screens-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(over: Partial<GithubScreensOptions> = {}) {
  const storage = openSqliteStorage({ path: join(dir, `${Math.random().toString(16).slice(2)}.sqlite`) });
  const fleet = new FleetReader({ storage, accounts: new Accounts({ storage, file: null }) });
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { auth: { clientId: 'test-client-id', token: TOKEN, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', requireToken: true } });
  const cache = new GithubCache({ store: new SqliteCacheStore(storage.db) });
  const rows = () => (storage.db.prepare('SELECT COUNT(*) AS n FROM github_cache').get() as { n: number }).n;
  const screens = createGithubScreens({
    demo: false,
    noGithub: false,
    github: { token: async () => TOKEN, fetch: gh.fetch, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' },
    cache,
    queue: new GithubCallQueue(),
    changes: new ChangeCursor(),
    fleet,
    storage,
    settings: new MemoryInstallationSettings(),
    env: {},
    devConsole: { file: null },
    log: () => undefined,
    ...over,
  });
  return { screens, storage, gh, cache, rows };
}

describe('#241/AC-4 the GitHub screens are rebuilt on an identity change', () => {
  test('outside the demo and --no-github the factory needs the github access', () => {
    assert.throws(() => setup({ github: null }), /github access/);
  });

  test('reads go through the provider; resetIdentity empties github_cache and builds new services', async () => {
    const { screens, rows, gh } = setup();
    const before = screens.current();
    await before.repos.lista();
    await before.repos.esperar();
    assert.equal((await before.repos.lista()).state, 'ready');
    await screens.projectOptions!.list();
    assert.ok(rows() > 0, 'something was cached');
    assert.deepEqual(gh.calls.filter((c) => c.startsWith('UNAUTHORIZED')), []);

    await screens.resetIdentity();
    assert.equal(rows(), 0, 'every github_cache row is gone');
    const now = screens.current();
    for (const k of ['repos', 'agentInstructions', 'frameworkInstall', 'decisions', 'devConsole', 'delivery'] as const) {
      assert.notEqual(now[k], before[k], `${k} rebuilt`);
    }
    assert.equal(now.sessions, before.sessions, 'the session → repository map does not depend on GitHub');
    const reads = gh.calls.length;
    await now.repos.lista();
    await now.repos.esperar();
    assert.ok(gh.calls.length > reads, 'the new service reads GitHub again');
  });

  test('onReset runs after the rebuild (the panel\'s work by branch forgets its GitHub reads)', async () => {
    let calls = 0;
    const { screens } = setup({ onReset: () => void calls++ });
    await screens.resetIdentity();
    assert.equal(calls, 1);
    const work = new TrabalhoPorBranch({ fonte: null, git: async () => null as never });
    work.ler('/x', null);
    await work.esperar();
    work.forget();
    assert.equal(work.espiar('/x', null), null);
  });

  test('the route functions stay the same and delegate to the current services', async () => {
    const { screens } = setup();
    const routes = [screens.repos, screens.agentInstructions, screens.frameworkInstall, screens.decisions, screens.devConsole, screens.delivery];
    await screens.resetIdentity();
    assert.deepEqual([screens.repos, screens.agentInstructions, screens.frameworkInstall, screens.decisions, screens.devConsole, screens.delivery], routes);
    assert.equal(typeof screens.repos, 'function');
    assert.equal(typeof screens.devConsole.overview, 'function');
    assert.equal(typeof screens.delivery.github.read, 'function');
  });

  test('the project kanban follows the selection and is rebuilt on an identity change', async () => {
    const { screens } = setup();
    assert.equal(screens.project!.kanban(), null, 'no default Project');
    screens.project!.select({ owner: 'exemplo', number: 3 });
    const k = screens.project!.kanban();
    assert.deepEqual(k!.project, { owner: 'exemplo', number: 3, field: 'Status' });
    await screens.resetIdentity();
    assert.notEqual(screens.project!.kanban(), k);
  });

  test('--no-github: routes exist, no project, no options, reset is harmless', async () => {
    const { screens } = setup({ noGithub: true, github: null });
    assert.equal(screens.project, null);
    assert.equal(screens.projectOptions, null);
    await screens.resetIdentity();
    assert.equal(typeof screens.repos, 'function');
  });

  test('the demo: fake GitHub per screen, the simulator Project by default, its options from the fake', async () => {
    const { screens } = setup({ demo: true, github: { token: async () => 'demo-token' } });
    assert.deepEqual(screens.project!.selection(), { owner: 'exemplo', number: 3, field: 'Status', from: 'demo' });
    const options = await screens.projectOptions!.list();
    assert.deepEqual(options.projects.map((p) => `${p.owner}/${p.number}`), ['dev-sintetico/1', 'dev-sintetico/2', 'exemplo/3']);
    const board = await screens.project!.kanban()!.board();
    assert.ok(board.lanes.length > 0);
    const none = setup({ demo: true, github: { token: async () => 'demo-token' }, demoProject: false });
    assert.equal(none.screens.project!.selection(), null);
  });
});
