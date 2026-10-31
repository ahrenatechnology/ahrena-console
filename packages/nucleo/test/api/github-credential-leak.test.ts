// The credential does not leak (#241, decision 0011 §3 and §9). A full flow, wired the production way
// (src/api/core-github.ts, as cli.ts does outside the demo) with the fake GitHub as the transport and an
// in-memory vault holding the sentinel once connected:
//
// - the failures first: GitHub refusing the code request, a poll error, a network blip while polling,
//   a vault write failure;
// - connect by the device flow (the fake hands out the sentinel and accepts no other bearer);
// - read every GitHub-backed screen, /api/changes, MCP's `wait_for_changes`, the work by branch;
// - choose a Project, a GitHub error on the kanban and on the repository list;
// - a restart whose `/user` answers 401 for the stored credential;
// - disconnect, and read again (409);
// - the lock (nucleo.json) and the instance registry written as cli.ts writes them.
//
// Then the sentinel, its first 12 characters, its base64 forms (plain, url-safe, the `Basic` pairs
// git and the API accept) and UTF-16 are searched in every HTTP response (status, headers, body), every
// log line (the injected log, stderr, stdout and console), installation_settings, the SQLite file and its
// -wal/-shm, every file of the data folder, the lock and the registry. The device codes too. Zero hits.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { RotaAnalytics } from '../../src/api/analytics-route.ts';
import { createCoreGithub, type CoreGithub } from '../../src/api/core-github.ts';
import { TrabalhoPorBranch } from '../../src/api/work.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { waitForChanges } from '../../src/changes/mcp.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubConnection, MemoryVault, type CredentialVault } from '../../src/github/connection/index.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { createMcpServer } from '../../src/mcp/index.ts';
import { claimLock } from '../../src/owner/owner.ts';
import { instanceId, writeInstance } from '../../src/owner/registry.ts';
import { SqliteInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, FAKE_GITHUB_BASE } from '../../src/simulator/fake-github.ts';

// Random from the first characters on, so its 12-character prefix is as unique as the whole.
const SENTINEL = `gho_${randomBytes(18).toString('hex')}`;
const OTHER = `gho_${randomBytes(18).toString('hex')}`;
const root = mkdtempSync(join(tmpdir(), 'github-leak-'));
const dataDir = join(root, 'data');
const home = join(root, 'home');
mkdirSync(dataDir, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

/** Every form of a secret that must not appear. */
function forms(secret: string): { name: string; bytes: Buffer }[] {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const text = [
    ['plain', secret],
    ['first 12 characters', secret.slice(0, 12)],
    ['base64', b64(secret)],
    ['base64url', b64url(secret)],
    ['Basic x-access-token:<secret>', b64(`x-access-token:${secret}`)],
    ['Basic <secret>:x-oauth-basic', b64(`${secret}:x-oauth-basic`)],
    ['Basic :<secret>', b64(`:${secret}`)],
    ['Basic <secret>:', b64(`${secret}:`)],
  ];
  return [...text.map(([name, s]) => ({ name, bytes: Buffer.from(s) })), { name: 'UTF-16', bytes: Buffer.from(secret, 'utf16le') }];
}

interface Answer {
  status: number;
  raw: string;
  json: any;
}

function call(api: LocalApi, path: string, { method = 'GET', headers = {} as Record<string, string>, body = '' } = {}): Promise<Answer> {
  const { hostname, port } = new URL(api.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (text += p));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON (an SSE answer, a 202)
        }
        const head = Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join('\n');
        resolve({ status: res.statusCode ?? 0, raw: `${res.statusCode}\n${head}\n\n${text}`, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Captures stderr, stdout and console while the flow runs. */
function captureOutput() {
  const lines: string[] = [];
  const restore: (() => void)[] = [];
  for (const stream of [process.stderr, process.stdout]) {
    const write = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => void (stream.write = write));
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    restore.push(() => void (console[level] = original));
  }
  return { lines, restore: () => restore.forEach((r) => r()) };
}

/** The in-memory vault that can be made to fail its next write. */
class FlakyVault implements CredentialVault {
  readonly kind = 'memory' as const;
  readonly inner = new MemoryVault();
  failNextSet = false;
  get = (a: string) => this.inner.get(a);
  delete = (a: string) => this.inner.delete(a);
  list = () => this.inner.list();
  async set(a: string, s: string) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('vault: write failed');
    }
    return this.inner.set(a, s);
  }
}

describe('#241/AC-7 the credential never leaks (sentinel)', () => {
  test('failures, connect, every GitHub reader, a 401 restart, disconnect: zero hits anywhere', async () => {
    const output = captureOutput();
    const logs: string[] = [];
    const log = (line: string) => void logs.push(line);
    const timers: (() => void)[] = [];
    const storage: SqliteStorage = openSqliteStorage({ path: join(dataDir, 'nucleo.sqlite') });
    const auth = { clientId: 'test-client-id', token: SENTINEL, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', approveAfterPolls: 1, requireToken: true };
    const gh = createFakeGithub(DEMO_GITHUB_DATA, { auth });
    let networkBlips = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (networkBlips > 0 && String(input).endsWith('/login/oauth/access_token')) {
        networkBlips--;
        throw new TypeError('fetch failed');
      }
      return gh.fetch(input, init);
    }) as typeof globalThis.fetch;
    const vault = new FlakyVault();
    const changes = new ChangeCursor();
    const settings = new SqliteInstallationSettings(storage.db);
    const accounts = new Accounts({ storage, file: null });
    const answers: Answer[] = [];

    // The work by branch (the panel's enrichment), on the same credential: a repository on GitHub.
    let work: TrabalhoPorBranch | null = null;
    const git = async (_cwd: string, args: string[]) =>
      args[0] === 'branch' ? 'feat/1-sentinel' : args[0] === 'remote' ? 'https://github.com/exemplo-labs/vitrine-demo.git' : args[0] === 'rev-parse' ? 'origin/feat/1-sentinel' : null;

    /** A core over the shared vault, settings and database, like cli.ts builds it. */
    async function boot() {
      const queue = new GithubCallQueue();
      const cache = new GithubCache({ store: new SqliteCacheStore(storage.db) });
      const mcp = createMcpServer({ storage, accounts, desktop: null, log });
      mcp.server.register(waitForChanges({ changes, accounts }));
      const core: CoreGithub = await createCoreGithub({
        demo: false,
        noGithub: false,
        connection: (hooks) =>
          new GithubConnection({
            vault,
            settings,
            clientId: 'test-client-id',
            fetch,
            oauthUrl: FAKE_GITHUB_BASE,
            apiUrl: FAKE_GITHUB_BASE,
            env: {},
            ghInstalled: () => false,
            queue,
            setTimer: (fn) => timers.push(fn),
            clearTimer: () => undefined,
            ...hooks,
            log,
          }),
        transport: { fetch, url: `${FAKE_GITHUB_BASE}/graphql`, api: FAKE_GITHUB_BASE },
        cache,
        queue,
        changes,
        fleet: mcp.fleet,
        storage,
        settings,
        env: {},
        devConsole: { file: null },
        onReset: () => work?.forget(),
        log,
      });
      work ??= new TrabalhoPorBranch({ fonte: new GithubGraphqlSource({ token: core.access!.token, fetch, url: `${FAKE_GITHUB_BASE}/graphql` }), cache, git });
      const { connection, screens } = core;
      const api = await startLocalApi({
        panelBuilder: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: work }),
        hooks: { storage },
        port: 0,
        log,
        changes,
        mcp: mcp.server,
        connection,
        githubConnected: core.connected,
        projectSelection: screens.project,
        project: { kanban: null, fonte: 'github', resolver: screens.project, options: screens.projectOptions, credentialSource: () => connection.credentialSource(), log },
        repos: screens.repos,
        agentInstructions: screens.agentInstructions,
        frameworkInstall: screens.frameworkInstall,
        decisions: screens.decisions,
        devConsole: screens.devConsole,
        analytics: new RotaAnalytics({ storage, contas: accounts, versao: () => changes.current, delivery: screens.delivery }),
      });
      const host = `127.0.0.1:${new URL(api.url).port}`;
      const ui = { host, origin: `http://${host}`, 'content-type': 'application/json' };
      const get = async (path: string, headers: Record<string, string> = {}) => {
        const a = await call(api, path, { headers: { host, ...headers } });
        answers.push(a);
        return a;
      };
      const post = async (path: string, body: unknown = {}, headers: Record<string, string> = ui) => {
        const a = await call(api, path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
        answers.push(a);
        return a;
      };
      return { core, connection, screens, api, host, get, post };
    }
    const drain = async (c: GithubConnection) => {
      while (timers.length > 0) {
        timers.shift()!();
        await c.idle();
      }
    };

    const screenReads = [
      '/api/repos',
      '/api/repos/exemplo-labs/vitrine-demo',
      '/api/agent-instructions/exemplo-labs/vitrine-demo',
      '/api/agent-instructions/estudio-ficticio/app-receitas/file?path=AGENTS.md',
      '/api/adrs',
      '/api/pdrs',
      '/api/adrs/exemplo-labs/vitrine-demo',
      '/api/dev-console',
      '/api/project/options',
      '/api/project',
      '/api/framework-install/exemplo-labs/vitrine-demo/plan',
      '/api/analytics/delivery',
    ];

    const a = await boot();
    const firstCursor = changes.current;
    const b: { api: LocalApi | null } = { api: null };
    try {
      assert.equal((await a.get('/api/connections')).json.github.state, 'disconnected');

      // GitHub refuses the code request: 502, nothing pending.
      auth.clientId = 'another-app';
      assert.deepEqual((await a.post('/api/connections/github/start')).json, { error: 'github-error' });
      auth.clientId = 'test-client-id';

      // A poll error (GitHub refuses the poll): the flow ends with github-error.
      assert.equal((await a.post('/api/connections/github/start')).json.github.state, 'pending');
      auth.clientId = 'another-app';
      await drain(a.connection);
      auth.clientId = 'test-client-id';
      assert.equal((await a.get('/api/connections')).json.github.lastError, 'github-error');

      // A network blip while polling keeps the flow; then the vault refuses the write: vault-error.
      networkBlips = 1;
      vault.failNextSet = true;
      assert.equal((await a.post('/api/connections/github/start')).json.github.state, 'pending');
      await drain(a.connection);
      assert.equal(networkBlips, 0, 'the blip happened');
      assert.equal((await a.get('/api/connections')).json.github.lastError, 'vault-error');
      assert.deepEqual(await vault.list(), []);

      // Connect.
      assert.equal((await a.post('/api/connections/github/start')).json.github.state, 'pending');
      await drain(a.connection);
      const connected = await a.get('/api/connections');
      assert.equal(connected.json.github.state, 'connected', connected.raw);
      assert.equal(await vault.get('dev-sintetico'), SENTINEL, 'the vault (only) holds the credential');

      // Every GitHub-backed screen, twice: the second read gets what the background loads brought in.
      for (const path of screenReads) await a.get(path);
      await a.screens.current().repos.esperar();
      for (const path of screenReads) await a.get(path);
      const second = answers.slice(-screenReads.length).map((x, k) => [screenReads[k], x.status]);
      // Every screen answered with data; the kanban has no Project chosen yet (503 no-project).
      assert.deepEqual(second, screenReads.map((path) => [path, path === '/api/project' ? 503 : 200]));

      // The work by branch reads GitHub with the same credential.
      work!.ler('/simulacao/vitrine-demo', null);
      await work!.esperar();
      assert.ok(gh.calls.some((c) => /^GRAPHQL Work/.test(c)), `the work read GitHub: ${gh.calls.filter((c) => c.startsWith('GRAPHQL')).join(', ')}`);

      // The changes the /ui long-polls, and MCP's wait_for_changes.
      const changed = await a.get(`/api/changes?since=${encodeURIComponent(firstCursor)}&wait=0`);
      assert.equal(changed.status, 200, changed.raw);
      assert.ok(changed.json.changes.some((c: { type: string }) => c.type === 'connections'));
      const mcpHeaders = { host: a.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
      await a.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'leak', version: '1' } } }, mcpHeaders);
      const waited = await a.post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for_changes', arguments: { cursor: firstCursor, timeout: 0 } } }, mcpHeaders);
      assert.equal(waited.status, 200, waited.raw);
      assert.match(waited.raw, /cursor/);

      // Choose a Project and read the kanban: a GitHub error (the fake does not serve the board query).
      assert.equal((await a.post('/api/project/selection', { owner: 'exemplo', number: 3 })).status, 200);
      const board = await a.get('/api/project?refresh=1');
      assert.ok(board.status >= 500, `a GitHub error reaches the screen: ${board.raw}`);
      gh.failNext('ReposLista');
      await a.get('/api/repos?refresh=1');
      assert.deepEqual(gh.calls.filter((c) => c.startsWith('UNAUTHORIZED')), [], 'the provider credential is the one that flowed');

      // A restart whose /user answers 401 for the stored credential: disconnected, revoked (#372).
      auth.token = OTHER;
      const restarted = await boot();
      b.api = restarted.api;
      const rejected = await restarted.get('/api/connections');
      assert.deepEqual([rejected.json.github.state, rejected.json.github.lastError], ['disconnected', 'revoked'], rejected.raw);
      assert.ok(gh.calls.includes('UNAUTHORIZED /user') || gh.calls.some((c) => c === 'GET /user'));
      restarted.connection.close();
      await restarted.api.close();
      b.api = null;
      auth.token = SENTINEL;

      // Disconnect: the vault entry and every github_cache row go; the screens answer 409.
      const off = await a.post('/api/connections/github/disconnect');
      assert.equal(off.json.github.state, 'disconnected');
      await a.core.settled();
      assert.deepEqual(await vault.list(), []);
      assert.equal((storage.db.prepare('SELECT COUNT(*) AS n FROM github_cache').get() as { n: number }).n, 0, 'github_cache is empty');
      for (const path of screenReads) assert.equal((await a.get(path)).status, 409, path);

      // The lock and the instance registry, as cli.ts writes them.
      const lock = await claimLock({ dir: dataDir, port: Number(new URL(a.api.url).port), version: 'test', parent: null });
      assert.ok(!('conflict' in lock));
      writeInstance({ id: instanceId('dev'), installation: 'dev', pid: process.pid, port: Number(new URL(a.api.url).port), version: 'test', commit: null, dataDir, startedAt: lock.startedAt }, { home });
    } finally {
      output.restore();
      a.connection.close();
      await a.api.close();
      await b.api?.close();
    }
    storage.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    const settingsRows = storage.db.prepare('SELECT key, value_json FROM installation_settings').all() as { key: string; value_json: string }[];
    const openFiles = filesUnder(root).map((path) => ({ path, bytes: readFileSync(path) }));
    await storage.close();
    const closedFiles = filesUnder(root).map((path) => ({ path, bytes: readFileSync(path) }));

    const deviceCodes = gh.auth!.deviceCodes;
    assert.equal(deviceCodes.length, 3, 'the poll-error, vault-error and connecting flows each had a code');
    const secrets = [...forms(SENTINEL).map((f) => ({ ...f, name: `the credential (${f.name})` })), ...deviceCodes.flatMap((code) => forms(code).filter((f) => f.name !== 'first 12 characters').map((f) => ({ ...f, name: `a device code (${f.name})` })))];
    const texts: { where: string; bytes: Buffer }[] = [
      ...answers.map((x) => ({ where: 'an HTTP response', bytes: Buffer.from(x.raw) })),
      ...[...logs, ...output.lines].map((l) => ({ where: 'a log line', bytes: Buffer.from(l) })),
      ...settingsRows.map((r) => ({ where: 'installation_settings', bytes: Buffer.from(`${r.key}=${r.value_json}`) })),
      ...[...openFiles, ...closedFiles].map((f) => ({ where: f.path, bytes: f.bytes })),
    ];
    for (const { where, bytes } of texts) {
      for (const s of secrets) assert.equal(bytes.indexOf(s.bytes), -1, `${s.name} in ${where}: ${bytes.toString('utf8').slice(0, 200)}`);
    }
    const names = closedFiles.map((f) => f.path);
    assert.ok(names.some((p) => p.endsWith('nucleo.sqlite')));
    assert.ok(names.some((p) => p.endsWith('nucleo.json')), 'the lock was scanned');
    assert.ok(names.some((p) => p.includes(join('home', 'instances'))), 'the registry was scanned');
    assert.ok(logs.some((l) => /connected as dev-sintetico/.test(l)), 'the log did run');
  });
});
