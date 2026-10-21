// The credential does not leak (#241, decision 0011 §3 and §9). A full flow, wired the production way
// (src/api/core-github.ts, as cli.ts does outside the demo) with the fake GitHub as the transport and an
// in-memory vault: connect by the device flow (the fake hands out a sentinel credential and accepts no
// other bearer), read every GitHub-backed screen, a GitHub error, choose a Project, disconnect, read again
// (409). Then the sentinel is searched in every HTTP response (body and headers), every log line (the
// injected log, stderr, stdout and console), the SQLite file and its -wal/-shm, and every file of the data
// folder. Zero hits. The device code never appears in a response nor in a log either.
//
// The lock (nucleo.json) and the instance registry are written by cli.ts only, from the port, pid,
// version and folder: they are outside this in-process flow and hold no credential by construction.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { RotaAnalytics } from '../../src/api/analytics-route.ts';
import { createCoreGithub } from '../../src/api/core-github.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubConnection, MemoryVault } from '../../src/github/connection/index.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { FleetReader } from '../../src/mcp/fleet.ts';
import { SqliteInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';

const SENTINEL = `gho_SENTINEL${randomBytes(12).toString('hex')}`;
const BASE = 'https://fake-github.invalid';
const dir = mkdtempSync(join(tmpdir(), 'github-leak-'));
after(() => rmSync(dir, { recursive: true, force: true }));

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
          // not JSON
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

describe('#241/AC-7 the credential never leaks (sentinel)', () => {
  test('connect, read every GitHub screen, a GitHub error, disconnect: zero hits anywhere', async () => {
    const output = captureOutput();
    const logs: string[] = [];
    const log = (line: string) => void logs.push(line);
    const timers: (() => void)[] = [];
    const storage = openSqliteStorage({ path: join(dir, 'nucleo.sqlite') });
    const gh = createFakeGithub(DEMO_GITHUB_DATA, {
      auth: { clientId: 'test-client-id', token: SENTINEL, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', approveAfterPolls: 1, requireToken: true },
    });
    const vault = new MemoryVault();
    const changes = new ChangeCursor();
    const settings = new SqliteInstallationSettings(storage.db);
    const queue = new GithubCallQueue();
    const core = await createCoreGithub({
      demo: false,
      noGithub: false,
      connection: (hooks) =>
        new GithubConnection({
          vault,
          settings,
          clientId: 'test-client-id',
          fetch: gh.fetch,
          oauthUrl: BASE,
          apiUrl: BASE,
          env: {},
          ghInstalled: () => false,
          queue,
          setTimer: (fn) => timers.push(fn),
          clearTimer: () => undefined,
          ...hooks,
          log,
        }),
      transport: { fetch: gh.fetch, url: `${BASE}/graphql`, api: BASE },
      cache: new GithubCache({ store: new SqliteCacheStore(storage.db) }),
      queue,
      changes,
      fleet: new FleetReader({ storage, accounts: new Accounts({ storage, file: null }) }),
      storage,
      settings,
      env: {},
      devConsole: { file: null },
      log,
    });
    const { connection, screens } = core;
    const accounts = new Accounts({ storage, file: null });
    const api = await startLocalApi({
      panelBuilder: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null }),
      hooks: { storage },
      port: 0,
      log,
      changes,
      connection,
      githubConnected: core.connected,
      projectSelection: screens.project,
      project: { kanban: null, fonte: 'github', resolver: screens.project, options: screens.projectOptions, log },
      repos: screens.repos,
      agentInstructions: screens.agentInstructions,
      frameworkInstall: screens.frameworkInstall,
      decisions: screens.decisions,
      devConsole: screens.devConsole,
      analytics: new RotaAnalytics({ storage, contas: accounts, versao: () => changes.current, delivery: screens.delivery }),
    });
    const host = `127.0.0.1:${new URL(api.url).port}`;
    const ui = { host, origin: `http://${host}`, 'content-type': 'application/json' };
    const answers: Answer[] = [];
    const get = async (path: string) => {
      const a = await call(api, path, { headers: { host } });
      answers.push(a);
      return a;
    };
    const post = async (path: string, body: unknown = {}) => {
      const a = await call(api, path, { method: 'POST', headers: ui, body: JSON.stringify(body) });
      answers.push(a);
      return a;
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

    try {
      assert.equal((await get('/api/connections')).json.github.state, 'disconnected');
      // Connect: the device flow, polled by hand.
      const started = await post('/api/connections/github/start');
      assert.equal(started.json.github.state, 'pending', started.raw);
      while (timers.length > 0) {
        timers.shift()!();
        await connection.idle();
      }
      const connected = await get('/api/connections');
      assert.equal(connected.json.github.state, 'connected', connected.raw);
      assert.equal(await vault.get('dev-sintetico'), SENTINEL, 'the vault (only) holds the credential');

      // Every GitHub-backed screen, twice: the second read gets what the background loads brought in.
      for (const path of screenReads) await get(path);
      await screens.current().repos.esperar();
      await Promise.allSettled([screens.current().decisions.esperar?.()]);
      for (const path of screenReads) await get(path);
      const second = answers.slice(-screenReads.length).map((a, k) => [screenReads[k], a.status]);
      // Every screen answered with data; the kanban has no Project chosen yet (503 no-project).
      assert.deepEqual(second, screenReads.map((path) => [path, path === '/api/project' ? 503 : 200]));
      assert.equal((await get('/api/repos')).status, 200);
      assert.deepEqual(gh.calls.filter((c) => c.startsWith('UNAUTHORIZED')), [], 'the provider credential is the one that flowed');
      assert.ok(gh.calls.length > 5, 'GitHub was read');

      // Choose a Project and read the kanban; a GitHub error (the fake does not serve the board query).
      assert.equal((await post('/api/project/selection', { owner: 'exemplo', number: 3 })).status, 200);
      const board = await get('/api/project?refresh=1');
      assert.ok(board.status >= 500, `a GitHub error reaches the screen: ${board.raw}`);
      gh.failNext('ReposLista');
      await get('/api/repos?refresh=1');

      // Disconnect: the vault entry and every github_cache row go; the screens answer 409.
      const off = await post('/api/connections/github/disconnect');
      assert.equal(off.json.github.state, 'disconnected');
      await core.settled();
      assert.deepEqual(await vault.list(), []);
      assert.equal((storage.db.prepare('SELECT COUNT(*) AS n FROM github_cache').get() as { n: number }).n, 0, 'github_cache is empty');
      for (const path of screenReads) assert.equal((await get(path)).status, 409, path);
    } finally {
      output.restore();
      connection.close();
      await api.close();
    }
    storage.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    const settingsRows = storage.db.prepare('SELECT key, value_json FROM installation_settings').all() as { key: string; value_json: string }[];
    const dataFiles = filesUnder(dir).map((path) => ({ path, bytes: readFileSync(path) }));
    await storage.close();
    const closedFiles = filesUnder(dir).map((path) => ({ path, bytes: readFileSync(path) }));

    const deviceCodes = gh.auth!.deviceCodes;
    assert.ok(deviceCodes.length > 0);
    const responses = answers.map((a) => a.raw);
    const logLines = [...logs, ...output.lines];
    for (const [where, texts] of [
      ['an HTTP response', responses],
      ['a log line', logLines],
      ['installation_settings', settingsRows.map((r) => `${r.key}=${r.value_json}`)],
    ] as const) {
      for (const text of texts) {
        assert.ok(!text.includes(SENTINEL), `the credential in ${where}: ${text.slice(0, 200)}`);
        for (const code of deviceCodes) assert.ok(!text.includes(code), `the device code in ${where}`);
      }
    }
    assert.ok(dataFiles.some((f) => f.path.endsWith('nucleo.sqlite')));
    for (const f of [...dataFiles, ...closedFiles]) {
      assert.equal(f.bytes.indexOf(SENTINEL), -1, `the credential in ${f.path}`);
      assert.equal(f.bytes.indexOf(Buffer.from(SENTINEL, 'utf16le')), -1, `the credential (UTF-16) in ${f.path}`);
    }
    assert.ok(logs.some((l) => /connected as dev-sintetico/.test(l)), 'the log did run');
  });
});
