// The project kanban chosen on the screen (#241, decision 0011 §7): GET /api/project/options lists
// the Projects the account sees, POST /api/project/selection stores one, and GET /api/project follows
// the selection (env > setting > demo > none) and says where it came from. And the 409 gate: while
// GitHub is not connected, every GitHub-backed screen route answers 409 without any outbound call.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type ApiOptions, type LocalApi } from '../../src/api/index.ts';
import { createGithubScreens } from '../../src/api/github-screens.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubCache, MemoryCacheStore, RateLimitedError } from '../../src/github/cache.ts';
import { GithubConnection, MemoryVault } from '../../src/github/connection/index.ts';
import { GithubProject } from '../../src/github/project.ts';
import { ProjectOptions, type ProjectOptionsReader } from '../../src/github/project-options.ts';
import { ProjectResolver } from '../../src/github/project-selection.ts';
import { FleetReader } from '../../src/mcp/fleet.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';
import { SimulatorProject } from '../../src/simulator/project.ts';

const TOKEN = 'gho_FAKEselection0000000000000000000000';

function call(api: LocalApi, path: string, { method = 'GET', headers = {} as Record<string, string>, body = '' } = {}) {
  const { hostname, port } = new URL(api.url);
  return new Promise<{ status: number; text: string; json: any }>((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (text += p));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function boot(extra: Partial<ApiOptions>) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, port: 0, log: () => {}, ...extra });
  const host = `127.0.0.1:${new URL(api.url).port}`;
  return {
    api,
    host,
    storage,
    ui: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    async close() {
      await api.close();
      await storage.close();
    },
  };
}

function project(env: Record<string, string> = {}, reader?: ProjectOptionsReader) {
  const settings = new MemoryInstallationSettings();
  const cache = new GithubCache({ store: new MemoryCacheStore() });
  const resolver = new ProjectResolver({ env, settings, build: (sel) => new GithubProject({ source: new SimulatorProject(), cache, project: sel }) });
  const gh = createFakeGithub(DEMO_GITHUB_DATA);
  const options = new ProjectOptions({
    source: reader ?? { list: () => import('../../src/github/project-options.ts').then((m) => new m.GithubProjectOptionsSource({ token: TOKEN, fetch: gh.fetch, url: 'https://fake.invalid/graphql' }).list()) },
    cache,
    queue: new GithubCallQueue(),
  });
  return { settings, resolver, options, gh, opts: { project: { kanban: null, fonte: 'github' as const, resolver, options }, projectSelection: resolver } };
}

describe('#241/AC-5 the Project options and the selection', () => {
  test('GET /api/project/options lists the Projects with the selection and the env override', async () => {
    const p = project();
    const b = await boot(p.opts);
    try {
      const r = await call(b.api, '/api/project/options', { headers: { host: b.host } });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.json), ['projects', 'selection', 'envOverride', 'fetchedAt', 'stale', 'reason']);
      assert.deepEqual(r.json.projects.map((x: { owner: string; number: number }) => `${x.owner}/${x.number}`), ['dev-sintetico/1', 'dev-sintetico/2', 'exemplo/3']);
      assert.deepEqual(r.json.projects[2], { owner: 'exemplo', ownerType: 'organization', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/exemplo/projects/3', items: 12, hasStatusField: true, closed: false });
      assert.equal(r.json.selection, null);
      assert.equal(r.json.envOverride, null);
      assert.equal(r.json.stale, false);
    } finally {
      await b.close();
    }
  });

  test('another site asking for the options (it spends quota) is 403', async () => {
    const p = project();
    const b = await boot(p.opts);
    try {
      for (const site of ['cross-site', 'same-site']) {
        const r = await call(b.api, '/api/project/options', { headers: { host: b.host, 'sec-fetch-site': site } });
        assert.equal(r.status, 403);
      }
      assert.deepEqual(p.gh.calls, []);
    } finally {
      await b.close();
    }
  });

  test('options errors: rate limited 429, GitHub down without data 502 github-down', async () => {
    const limited = project({}, { list: () => Promise.reject(new RateLimitedError('limit', 60_000)) });
    const b = await boot(limited.opts);
    try {
      const r = await call(b.api, '/api/project/options', { headers: { host: b.host } });
      assert.deepEqual([r.status, r.json.code], [429, 'rate-limited']);
    } finally {
      await b.close();
    }
    const down = project({}, { list: () => Promise.reject(new Error('GitHub respondeu 500')) });
    const c = await boot(down.opts);
    try {
      const r = await call(c.api, '/api/project/options', { headers: { host: c.host } });
      assert.deepEqual([r.status, r.json.code], [502, 'github-down']);
    } finally {
      await c.close();
    }
  });

  test('no selection: 503 no-project that points to the screen; after selecting, the board says from settings', async () => {
    const p = project();
    const b = await boot(p.opts);
    try {
      const none = await call(b.api, '/api/project', { headers: { host: b.host } });
      assert.deepEqual([none.status, none.json.code], [503, 'no-project']);
      assert.match(none.json.error, /escolha um Project na tela/);
      const sel = await call(b.api, '/api/project/selection', { method: 'POST', headers: b.ui, body: JSON.stringify({ owner: 'exemplo', number: 3 }) });
      assert.equal(sel.status, 200, sel.text);
      assert.deepEqual(sel.json, { selection: { owner: 'exemplo', number: 3, field: 'Status', from: 'settings' }, envOverride: null });
      const board = await call(b.api, '/api/project', { headers: { host: b.host } });
      assert.equal(board.status, 200, board.text);
      assert.deepEqual(board.json.selection, { owner: 'exemplo', number: 3, field: 'Status', from: 'settings' });
      assert.equal(board.json.envOverride, null);
      const bad = await call(b.api, '/api/project/selection', { method: 'POST', headers: b.ui, body: JSON.stringify({ owner: '-x', number: 3 }) });
      assert.deepEqual([bad.status, bad.json], [400, { error: 'invalid' }]);
    } finally {
      await b.close();
    }
  });

  test('the env wins and is reported on the board, the options and the selection answer', async () => {
    const p = project({ AHRENA_CONSOLE_PROJECT: 'exemplo/3' });
    const b = await boot(p.opts);
    try {
      const board = await call(b.api, '/api/project', { headers: { host: b.host } });
      assert.deepEqual(board.json.selection, { owner: 'exemplo', number: 3, field: 'Status', from: 'env' });
      assert.deepEqual(board.json.envOverride, { variable: 'AHRENA_CONSOLE_PROJECT', value: 'exemplo/3' });
      const sel = await call(b.api, '/api/project/selection', { method: 'POST', headers: b.ui, body: JSON.stringify({ owner: 'acme', number: 1 }) });
      assert.equal(sel.json.selection.from, 'env');
      const opts = await call(b.api, '/api/project/options', { headers: { host: b.host } });
      assert.deepEqual(opts.json.envOverride, { variable: 'AHRENA_CONSOLE_PROJECT', value: 'exemplo/3' });
    } finally {
      await b.close();
    }
  });
});

describe('#241/AC-2 409 github-not-connected on every GitHub screen, with no outbound call', () => {
  test('each GitHub-backed route answers 409 and nothing reaches GitHub', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const sent: string[] = [];
    const fetch = (async (u: string | URL | Request) => (sent.push(String(u)), new Response('{}', { status: 500 }))) as typeof globalThis.fetch;
    const settings = new MemoryInstallationSettings({ 'project.selection': { owner: 'exemplo', number: 3, field: 'Status' } });
    const connection = new GithubConnection({ vault: new MemoryVault(), settings, clientId: 'test-client-id', fetch, env: {}, ghInstalled: () => false, ghToken: async () => TOKEN });
    const screens = createGithubScreens({
      demo: false,
      noGithub: false,
      github: { token: () => connection.token(), fetch, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' },
      cache: new GithubCache({ store: new MemoryCacheStore() }),
      queue: new GithubCallQueue(),
      changes: new ChangeCursor(),
      fleet: new FleetReader({ storage, accounts: new Accounts({ storage, file: null }) }),
      storage,
      settings,
      env: {},
      devConsole: { file: null },
      log: () => undefined,
    });
    const b = await boot({
      connection,
      githubConnected: () => connection.connected(),
      repos: screens.repos,
      agentInstructions: screens.agentInstructions,
      frameworkInstall: screens.frameworkInstall,
      decisions: screens.decisions,
      devConsole: screens.devConsole as never,
      project: { kanban: null, fonte: 'github', resolver: screens.project!, options: screens.projectOptions! },
      projectSelection: screens.project,
    });
    try {
      const reads = [
        '/api/repos',
        '/api/repos/exemplo-labs/vitrine-demo',
        '/api/agent-instructions/exemplo-labs/vitrine-demo',
        '/api/adrs',
        '/api/pdrs',
        '/api/dev-console',
        '/api/project',
        '/api/project/options',
        '/api/framework-install/exemplo-labs/vitrine-demo/plan',
        '/api/analytics/delivery',
      ];
      for (const path of reads) {
        const r = await call(b.api, path, { headers: { host: b.host } });
        assert.deepEqual([r.status, r.json], [409, { error: 'github-not-connected' }], path);
      }
      for (const [path, body] of [
        ['/api/project/move', { itemId: 'PVTI_x', optionId: 'y' }],
        ['/api/framework-install/exemplo-labs/vitrine-demo', { platforms: [], plugins: [], planHash: 'x' }],
      ] as const) {
        const r = await call(b.api, path, { method: 'POST', headers: b.ui, body: JSON.stringify(body) });
        assert.deepEqual([r.status, r.json], [409, { error: 'github-not-connected' }], path);
      }
      assert.deepEqual(sent, [], 'no request left');
      const st = await call(b.api, '/api/connections', { headers: { host: b.host } });
      assert.equal(st.json.github.state, 'disconnected');
    } finally {
      connection.close();
      await b.close();
      await storage.close();
    }
  });
});
