// The connection routes (#241, decision 0011 §6): GET /api/connections and the four writes under
// /api/connections/github, plus POST /api/project/selection. The five writes are accepted ONLY from the
// /ui itself: POST, the exact path (no query), our Host, `Origin` exactly `http://<Host>`, JSON, at most
// 4 KiB, and not a browser saying cross-site or same-site. Without `Origin` (another local process, the
// MCP, the mod, the CLI) they are 403 even though other writes let such a request through.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { CHANGE_TYPES } from '../../src/changes/cursor.ts';
import { MCP_CHANGE_TYPES } from '../../src/changes/mcp.ts';
import { GithubConnection, MemoryVault } from '../../src/github/connection/index.ts';
import { ProjectResolver } from '../../src/github/project-selection.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEroutes000000000000000000000000';
const WRITES = ['/api/connections/github/start', '/api/connections/github/cancel', '/api/connections/github/disconnect', '/api/connections/github/source', '/api/project/selection'];
const BODIES: Record<string, string> = {
  '/api/connections/github/source': JSON.stringify({ source: 'console' }),
  '/api/project/selection': JSON.stringify({ owner: 'exemplo', number: 3 }),
};

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function boot(o: { clientId?: string | null; vault?: MemoryVault | null; env?: Record<string, string>; ghInstalled?: boolean } = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { auth: { clientId: 'test-client-id', token: TOKEN, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', interval: 5 } });
  const settings = new MemoryInstallationSettings();
  const connection = new GithubConnection({
    vault: o.vault === undefined ? new MemoryVault() : o.vault,
    settings,
    clientId: o.clientId === undefined ? 'test-client-id' : o.clientId,
    fetch: gh.fetch,
    oauthUrl: 'https://fake-github.invalid',
    apiUrl: 'https://fake-github.invalid',
    env: o.env ?? {},
    ghInstalled: () => o.ghInstalled ?? false,
    ghToken: async () => TOKEN,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const resolver = new ProjectResolver({ env: {}, settings, build: () => null });
  const api = await startLocalApi({ panelBuilder, hooks: { storage }, port: 0, log: () => {}, connection, projectSelection: resolver });
  const host = `127.0.0.1:${new URL(api.url).port}`;
  const ui = (extra: Record<string, string> = {}) => ({ host, origin: `http://${host}`, 'content-type': 'application/json', ...extra });
  const post = (path: string, body = BODIES[path] ?? '{}', headers = ui()) => call(api, path, { method: 'POST', headers, body });
  return {
    api,
    gh,
    settings,
    connection,
    host,
    ui,
    post,
    async close() {
      connection.close();
      await api.close();
      await storage.close();
    },
  };
}

describe('#241/AC-2 GET /api/connections and the github writes', () => {
  let b: Awaited<ReturnType<typeof boot>>;
  before(async () => {
    b = await boot();
  });
  after(() => b.close());

  test('GET answers the github status, from the /ui or a local process', async () => {
    for (const headers of [{ host: b.host }, { host: b.host, origin: `http://${b.host}` }]) {
      const r = await call(b.api, '/api/connections', { headers });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json), ['github']);
      assert.equal(r.json.github.state, 'disconnected');
      assert.equal(r.json.github.lastError, null);
      assert.deepEqual(r.json.github.requiredScopes, ['repo', 'read:org', 'project']);
    }
  });

  test('start → pending with the user code, never the device code; a second start gives the same code; cancel', async () => {
    const r = await b.post('/api/connections/github/start');
    assert.equal(r.status, 200);
    assert.equal(r.json.github.state, 'pending');
    assert.equal(r.json.github.userCode, 'FAKE-0001');
    assert.equal(r.json.github.verificationUri, 'https://github.com/login/device');
    const again = await b.post('/api/connections/github/start');
    assert.equal(again.json.github.userCode, 'FAKE-0001');
    for (const code of b.gh.auth!.deviceCodes) {
      assert.ok(!r.text.includes(code) && !again.text.includes(code), 'no device code in a response');
    }
    assert.ok(!/deviceCode|device_code/.test(r.text));
    const c = await b.post('/api/connections/github/cancel');
    assert.deepEqual([c.status, c.json.github.state], [200, 'disconnected']);
  });

  test('disconnect answers the status; source switches and validates', async () => {
    const d = await b.post('/api/connections/github/disconnect');
    assert.deepEqual([d.status, d.json.github.state], [200, 'disconnected']);
    const bad = await b.post('/api/connections/github/source', JSON.stringify({ source: 'keychain' }));
    assert.deepEqual([bad.status, bad.json], [400, { error: 'invalid' }]);
    const notJson = await b.post('/api/connections/github/source', '{nope');
    assert.deepEqual([notJson.status, notJson.json], [400, { error: 'invalid' }]);
    const noGh = await b.post('/api/connections/github/source', JSON.stringify({ source: 'gh' }));
    assert.deepEqual([noGh.status, noGh.json], [409, { error: 'gh-not-installed' }]);
  });

  test('review 2 (decided): another site reading the status is 403, like the Project options', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await call(b.api, '/api/connections', { headers: { host: b.host, 'sec-fetch-site': site } });
      assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }], site);
    }
    for (const site of ['same-origin', 'none']) {
      const r = await call(b.api, '/api/connections', { headers: { host: b.host, 'sec-fetch-site': site } });
      assert.equal(r.status, 200, site);
    }
  });

  test('connections is a change type for the /ui, kept out of MCP', () => {
    assert.ok((CHANGE_TYPES as readonly string[]).includes('connections'));
    assert.ok(!(MCP_CHANGE_TYPES as readonly string[]).includes('connections'));
  });
});

describe('#241/AC-2 the github write errors', () => {
  test('unavailable: 409 github-unavailable with the reason', async () => {
    const b = await boot({ clientId: null });
    try {
      const r = await b.post('/api/connections/github/start');
      assert.deepEqual([r.status, r.json], [409, { error: 'github-unavailable', reason: 'no-client-id' }]);
      const s = await call(b.api, '/api/connections', { headers: { host: b.host } });
      assert.deepEqual([s.json.github.state, s.json.github.reason], ['unavailable', 'no-client-id']);
    } finally {
      await b.close();
    }
  });

  test('under the gh source: start and disconnect are 409 source-is-gh', async () => {
    const b = await boot({ env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'gh' }, ghInstalled: true });
    try {
      for (const path of ['/api/connections/github/start', '/api/connections/github/disconnect']) {
        const r = await b.post(path);
        assert.deepEqual([r.status, r.json], [409, { error: 'source-is-gh' }], path);
      }
    } finally {
      await b.close();
    }
  });

  test('GitHub refusing the code request: 502 github-error', async () => {
    const b = await boot({ clientId: 'not-the-app' });
    try {
      const r = await b.post('/api/connections/github/start');
      assert.deepEqual([r.status, r.json], [502, { error: 'github-error' }]);
    } finally {
      await b.close();
    }
  });
});

describe('#241/AC-6 the five writes only from the /ui itself', () => {
  let b: Awaited<ReturnType<typeof boot>>;
  before(async () => {
    b = await boot();
  });
  after(() => b.close());

  const port = () => new URL(b.api.url).port;
  const cases: { name: string; status: number; send: (path: string) => Promise<Answer> }[] = [
    { name: 'no Origin (a local process, even one the other writes let through)', status: 403, send: (p) => b.post(p, undefined, { host: b.host, 'content-type': 'application/json' }) },
    { name: 'a foreign Origin', status: 403, send: (p) => b.post(p, undefined, b.ui({ origin: 'https://evil.example' })) },
    { name: 'an Origin with another port', status: 403, send: (p) => b.post(p, undefined, b.ui({ origin: `http://127.0.0.1:${Number(port()) + 1}` })) },
    { name: 'an Origin with another host name', status: 403, send: (p) => b.post(p, undefined, b.ui({ origin: `http://localhost:${port()}` })) },
    { name: 'a foreign Host', status: 403, send: (p) => b.post(p, undefined, { host: `evil.example:${port()}`, origin: `http://evil.example:${port()}`, 'content-type': 'application/json' }) },
    { name: 'Sec-Fetch-Site: cross-site', status: 403, send: (p) => b.post(p, undefined, b.ui({ 'sec-fetch-site': 'cross-site' })) },
    { name: 'Sec-Fetch-Site: same-site', status: 403, send: (p) => b.post(p, undefined, b.ui({ 'sec-fetch-site': 'same-site' })) },
    { name: 'a query string', status: 403, send: (p) => b.post(`${p}?x=1`) },
    { name: 'no JSON content type', status: 415, send: (p) => b.post(p, undefined, b.ui({ 'content-type': 'text/plain' })) },
    { name: 'a body over 4 KiB', status: 413, send: (p) => b.post(p, JSON.stringify({ source: 'console', pad: 'x'.repeat(5000) })) },
    { name: 'a GET', status: 405, send: (p) => call(b.api, p, { headers: b.ui() }) },
  ];

  for (const path of WRITES) {
    for (const c of cases) {
      test(`${path}: ${c.name} → ${c.status}`, async () => {
        const before = b.gh.calls.length;
        const r = await c.send(path);
        assert.equal(r.status, c.status, r.text);
        assert.equal(b.gh.calls.length, before, 'nothing reached GitHub');
      });
    }
    test(`${path}: from the /ui itself → 200`, async () => {
      const r = await b.post(path);
      assert.equal(r.status, 200, r.text);
      await b.post('/api/connections/github/cancel');
    });
  }

  test('localhost as Host with its own Origin is the /ui too', async () => {
    const host = `localhost:${port()}`;
    const r = await b.post('/api/connections/github/cancel', '{}', { host, origin: `http://${host}`, 'content-type': 'application/json' });
    assert.equal(r.status, 200);
  });
});
