import { OWNER_TOKEN, ownerRequest as request } from '../owner-http.ts';
// The cloud connector routes (#277, decision 0013 section 6) on 127.0.0.1, with a FAKE `aws`
// (test/clouds/fake-aws.ts) and a FAKE remote núcleo on loopback: the shapes of GET /api/connectors,
// Entrar and Cancelar, 404 for an unknown or unsupported session, the Origin defense (another Origin
// gets 403 and nothing is spawned), the body's fixed enum, and the remote machine's read and
// forwarding (only the session name travels, as a local request, with mode device-code).
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createCloudsRoute } from '../../src/api/clouds.ts';
import { AwsConnector } from '../../src/clouds/aws-connector.ts';
import { ssoCacheFileName } from '../../src/clouds/aws-sso-cache.ts';
import { loopbackWrite } from '../../src/clouds/remote-connectors.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { CONFIG, DEVICE_PAGE, fakeAws, type FakeAwsState } from '../clouds/fake-aws.ts';

const SENTINEL = 'TOKEN-SENTINEL-c0ffee';

interface Recorded {
  method: string;
  url: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** A fake remote núcleo: answers what the test sets, records every request. */
async function fakeRemote(answers: { connectors: { status: number; body: unknown }; login: { status: number; body: unknown } }) {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host, origin: req.headers.origin, contentType: req.headers['content-type'], body });
      const a = req.url === '/api/connectors' ? answers.connectors : answers.login;
      const text = JSON.stringify(a.body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  return { port, requests, answers, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function boot(state: Partial<FakeAwsState> = {}, remotes: Record<string, number> = {}) {
  const f = fakeAws(state);
  f.writeConfig(CONFIG);
  const logs: string[] = [];
  const aws = new AwsConnector({
    logFile: f.logFile,
    home: f.home,
    env: { HOME: f.home, PATH: '/usr/bin:/bin' },
    loginPath: async () => f.bin,
    log: (m) => logs.push(m),
    login: { msPerSecond: 20, killGraceMs: 150 },
  });
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const clouds = createCloudsRoute({ aws, remote: { port: (id) => remotes[id], get: loopbackGet({ timeoutMs: 1000 }), write: loopbackWrite({ timeoutMs: 1000 }) } });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: (m) => logs.push(m), clouds });
  const port = Number(new URL(api.url).port);
  return {
    f,
    aws,
    api,
    logs,
    host: `127.0.0.1:${port}`,
    close: async () => {
      await aws.stop();
      await api.close();
      await storage.close();
      f.close();
    },
  };
}

function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

const LOGIN = '/api/connectors/aws/sessions/sessao-exemplo/login';
const settle = () => new Promise((res) => setTimeout(res, 300));
const sso = (b: { f: { calls(): string[][] } }) => b.f.calls().filter((a) => a[0] === 'sso');

describe('#277 GET /api/connectors', () => {
  test('#277 the shape: aws with state, cli, configFile, sessions and outOfScope, then gcp and azure soon; no token', async () => {
    const b = await boot({ sts: 'ok' });
    try {
      writeFileSync(join(b.f.cacheDir, ssoCacheFileName({ kind: 'sso-session', name: 'sessao-exemplo', startUrl: null })!), JSON.stringify({ accessToken: SENTINEL, refreshToken: SENTINEL, expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() }));
      await b.aws.probeAll();
      const r = await call(b.api.url, 'GET', '/api/connectors');
      assert.equal(r.status, 200);
      const [aws, gcp, azure] = r.json.connectors;
      assert.deepEqual(gcp, { kind: 'gcp', state: 'soon' });
      assert.deepEqual(azure, { kind: 'azure', state: 'soon' });
      assert.deepEqual(Object.keys(aws), ['kind', 'state', 'cli', 'configFile', 'sessions', 'outOfScope']);
      assert.equal(aws.state, 'valid');
      const s = aws.sessions[0];
      assert.deepEqual(Object.keys(s), ['name', 'kind', 'startUrlHost', 'region', 'loginSupported', 'state', 'expiresAt', 'checkedAt', 'profiles', 'login']);
      assert.deepEqual(Object.keys(s.login), ['state', 'mode', 'startedAt', 'endedAt', 'timeoutSeconds', 'exitCode', 'startedBy', 'logFile', 'deviceCode']);
      assert.equal(s.login.timeoutSeconds, 300);
      assert.equal(s.startUrlHost, 'exemplo.awsapps.com');
      assert.doesNotMatch(r.text, new RegExp(`${SENTINEL}|startUrl"|/start|STS-OUTPUT-SENTINEL|000000000000`));
      // The /ui's own same-origin read passes too.
      assert.equal((await call(b.api.url, 'GET', '/api/connectors', { origin: `http://${b.host}` })).status, 200);
      assert.equal((await call(b.api.url, 'GET', '/api/connectors', { origin: 'http://evil.example' })).status, 403);
    } finally {
      await b.close();
    }
  });
});

describe('#277 POST and DELETE /api/connectors/aws/sessions/<name>/login', () => {
  test('#277 from the tray (no Origin): 202, browser mode by default, startedBy local; the fixed argv runs', async () => {
    const b = await boot({ login: 'sleep' });
    try {
      const r = await call(b.api.url, 'POST', LOGIN);
      assert.equal(r.status, 202);
      assert.equal(r.json.login.state, 'running');
      assert.equal(r.json.login.mode, 'browser');
      assert.equal(r.json.login.startedBy, 'local');
      await settle();
      assert.deepEqual(sso(b), [['sso', 'login', '--sso-session', 'sessao-exemplo']]);
      const again = await call(b.api.url, 'POST', LOGIN);
      assert.equal(again.status, 202);
      const d = await call(b.api.url, 'DELETE', LOGIN);
      assert.equal(d.status, 200);
      assert.equal(d.json.login.state, 'canceled');
      assert.equal(sso(b).length, 1, 'one login at a time');
      await b.aws.logins.exited('sessao-exemplo');
      assert.equal((await call(b.api.url, 'DELETE', LOGIN)).status, 409);
    } finally {
      await b.close();
    }
  });

  test('#277 from the same-origin /ui with { mode: device-code }: 202, startedBy ui, the device code in the login state', async () => {
    const b = await boot({ login: 'device', deviceLines: DEVICE_PAGE });
    try {
      const r = await call(b.api.url, 'POST', LOGIN, { origin: `http://${b.host}`, 'content-type': 'application/json' }, JSON.stringify({ mode: 'device-code' }));
      assert.equal(r.status, 202, r.text);
      assert.equal(r.json.login.startedBy, 'ui');
      assert.equal(r.json.login.mode, 'device-code');
      let dc = null;
      for (let i = 0; i < 100 && !dc; i++) {
        await new Promise((res) => setTimeout(res, 30));
        dc = (await call(b.api.url, 'GET', '/api/connectors')).json.connectors[0].sessions[0].login.deviceCode;
      }
      assert.equal(dc.verificationUri, 'https://device.sso.regiao-exemplo-1.amazonaws.com/');
      assert.equal(dc.userCode, 'ABCD-EFGH');
      const text = (await call(b.api.url, 'GET', '/api/connectors')).text;
      assert.doesNotMatch(text, /LOGIN-OUTPUT-SENTINEL|Please visit/);
      assert.equal((await call(b.api.url, 'DELETE', LOGIN, { origin: `http://${b.host}` })).status, 200);
    } finally {
      await b.close();
    }
  });

  test('#277 another Origin gets 403 and nothing is spawned', async () => {
    const b = await boot({ login: 'ok' });
    try {
      const port = b.host.split(':')[1];
      const cases: [string, Record<string, string>][] = [
        [LOGIN, { origin: 'http://evil.example' }],
        [LOGIN, { origin: 'null' }],
        [LOGIN, { origin: `https://${b.host}` }],
        [LOGIN, { host: `evil.example:${port}` }],
        [LOGIN, { host: `evil.example:${port}`, origin: `http://${b.host}` }],
        [`${LOGIN}?x=1`, { origin: `http://${b.host}` }],
        ['/api/machines/ws-exemplo/connectors/aws/sessions/sessao-exemplo/login', { origin: 'http://evil.example' }],
      ];
      for (const method of ['POST', 'DELETE']) for (const [path, headers] of cases) assert.equal((await call(b.api.url, method, path, headers)).status, 403, `${method} ${path} ${JSON.stringify(headers)}`);
      await settle();
      assert.deepEqual(sso(b), []);
      assert.equal((await b.aws.view()).sessions[0]!.login.state, 'idle');
    } finally {
      await b.close();
    }
  });

  test('#277 unknown session and an unsupported name: 404, nothing spawned', async () => {
    const b = await boot();
    try {
      for (const name of ['nao-existe', 'nome%20com%20espaco', 'a;b', '..', `${'a'.repeat(65)}`]) {
        const r = await call(b.api.url, 'POST', `/api/connectors/aws/sessions/${name}/login`);
        assert.equal(r.status, 404, name);
      }
      assert.equal((await call(b.api.url, 'DELETE', '/api/connectors/aws/sessions/nao-existe/login')).status, 404);
      await settle();
      assert.deepEqual(sso(b), []);
    } finally {
      await b.close();
    }
  });

  test('#277 the body: only { mode } with the fixed enum, JSON, at most 1 KiB', async () => {
    const b = await boot();
    try {
      const json = { 'content-type': 'application/json' };
      assert.equal((await call(b.api.url, 'POST', LOGIN, {}, '{"mode":"browser"}')).status, 415);
      assert.equal((await call(b.api.url, 'POST', LOGIN, json, '{"mode":"shell"}')).status, 400);
      assert.equal((await call(b.api.url, 'POST', LOGIN, json, '{"mode":"browser","argv":["x"]}')).status, 400);
      assert.equal((await call(b.api.url, 'POST', LOGIN, json, '[1]')).status, 400);
      assert.equal((await call(b.api.url, 'POST', LOGIN, json, '{oops')).status, 400);
      assert.equal((await call(b.api.url, 'POST', LOGIN, json, JSON.stringify({ mode: 'browser', pad: 'x'.repeat(2000) }))).status, 413);
      await settle();
      assert.deepEqual(sso(b), []);
      assert.equal((await call(b.api.url, 'GET', LOGIN)).status, 405);
    } finally {
      await b.close();
    }
  });

  test('#277 a CLI that cannot log in: 409 with the reason', async () => {
    const b = await boot({ version: '1.29.0' });
    try {
      const r = await call(b.api.url, 'POST', LOGIN);
      assert.equal(r.status, 409);
      assert.equal(r.json.reason, 'cli-unsupported');
      assert.equal(typeof r.json.error, 'string');
    } finally {
      await b.close();
    }
  });
});

describe('#277 a remote machine through its tunnel port', () => {
  const remoteBody = {
    connectors: [
      {
        kind: 'aws',
        state: 'expired',
        token: SENTINEL,
        cli: { found: true, version: 2, deviceCodeSupported: true, path: '/caminho/remoto' },
        configFile: { status: 'ok' },
        sessions: [
          {
            name: 'sessao-remota',
            kind: 'sso-session',
            startUrlHost: 'exemplo.awsapps.com',
            region: 'regiao-exemplo-1',
            loginSupported: true,
            state: 'expired',
            expiresAt: '2026-10-22T08:00:00.000Z',
            checkedAt: '2026-10-22T09:00:00.000Z',
            accessToken: SENTINEL,
            profiles: [{ name: 'perfil-remoto', accountId: '444444444444', roleName: 'PapelExemplo', region: 'regiao-exemplo-1', secret: SENTINEL }],
            login: { state: 'running', mode: 'device-code', startedAt: '2026-10-22T09:00:00.000Z', endedAt: null, timeoutSeconds: 300, exitCode: null, startedBy: 'local', logFile: '/dados/reconnect.log', deviceCode: { verificationUri: 'https://evil.example/device', userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' }, output: SENTINEL },
          },
          { name: 'sessao;rm', kind: 'sso-session', state: 'never', loginSupported: true, profiles: [] },
          { name: 'sem-estado', kind: 'sso-session', state: 'weird' },
        ],
        outOfScope: [{ name: 'perfil-chave', reason: 'no-sso' }],
      },
      { kind: 'gcp', state: 'soon' },
      { kind: 'plugin-externo', state: 'valid' },
    ],
  };

  test('#277 GET /api/machines/<id>/connectors: the remote answer re-projected; extra fields and a non-AWS device URI dropped', async () => {
    const remote = await fakeRemote({ connectors: { status: 200, body: remoteBody }, login: { status: 202, body: {} } });
    const b = await boot({}, { 'ws-exemplo': remote.port });
    try {
      const r = await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connectors');
      assert.equal(r.status, 200);
      assert.equal(r.json.machine, 'ws-exemplo');
      assert.equal(r.json.status, 'ok');
      assert.doesNotMatch(r.text, new RegExp(`${SENTINEL}|evil\\.example|/caminho/remoto|plugin-externo`));
      const [aws, gcp] = r.json.connectors;
      assert.deepEqual(gcp, { kind: 'gcp', state: 'soon' });
      assert.equal(r.json.connectors.length, 2);
      assert.deepEqual(aws.cli, { found: true, version: 2, deviceCodeSupported: true });
      assert.deepEqual(
        aws.sessions.map((s: { name: string; loginSupported: boolean }) => [s.name, s.loginSupported]),
        [
          ['sessao-remota', true],
          ['sessao;rm', false],
        ],
      );
      assert.deepEqual(aws.sessions[0].profiles, [{ name: 'perfil-remoto', accountId: '444444444444', roleName: 'PapelExemplo', region: 'regiao-exemplo-1' }]);
      assert.equal(aws.sessions[0].login.deviceCode, null);
      assert.equal(aws.sessions[0].login.state, 'running');
      assert.ok(remote.requests.every((q) => q.method === 'GET' && q.host === '127.0.0.1:4720' && q.origin === undefined));
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#277 an AWS device code from the remote is kept once an earlier code-free answer vouched for the portal', async () => {
    const body = structuredClone(remoteBody);
    const login = body.connectors[0]!.sessions![0]!.login!;
    const running = { ...login, deviceCode: { ...login.deviceCode, verificationUri: 'https://device.sso.regiao-exemplo-1.amazonaws.com/' } };
    body.connectors[0]!.sessions![0]!.login = { state: 'idle' } as typeof login;
    const remote = await fakeRemote({ connectors: { status: 200, body }, login: { status: 202, body: {} } });
    const b = await boot({}, { 'ws-exemplo': remote.port });
    try {
      const first = await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connectors');
      assert.equal(first.json.connectors[0].sessions[0].login.deviceCode, null);
      body.connectors[0]!.sessions![0]!.login = running;
      const r = await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connectors');
      assert.deepEqual(r.json.connectors[0].sessions[0].login.deviceCode, { verificationUri: 'https://device.sso.regiao-exemplo-1.amazonaws.com/', userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' });
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#277 POST and DELETE forward only the session name, as a local request with mode device-code; the body sent here is ignored', async () => {
    const login = { state: 'running', mode: 'device-code', startedAt: '2026-10-22T09:00:00.000Z', endedAt: null, timeoutSeconds: 300, exitCode: null, startedBy: 'local', logFile: '/dados/reconnect.log', deviceCode: null, extra: SENTINEL };
    const remote = await fakeRemote({ connectors: { status: 200, body: remoteBody }, login: { status: 202, body: { login } } });
    const b = await boot({}, { 'ws-exemplo': remote.port });
    try {
      const path = '/api/machines/ws-exemplo/connectors/aws/sessions/sessao-remota/login';
      const r = await call(b.api.url, 'POST', path, { origin: `http://${b.host}`, 'content-type': 'application/json' }, JSON.stringify({ mode: 'browser', argv: ['x'] }));
      assert.equal(r.status, 202, r.text);
      assert.equal(r.json.login.state, 'running');
      assert.doesNotMatch(r.text, new RegExp(SENTINEL));
      remote.answers.login = { status: 200, body: { login: { ...login, state: 'canceled' } } };
      const d = await call(b.api.url, 'DELETE', path);
      assert.equal(d.status, 200);
      assert.deepEqual(
        remote.requests.map((q) => [q.method, q.url, q.host, q.origin, q.contentType ?? null, q.body]),
        [
          ['POST', '/api/connectors/aws/sessions/sessao-remota/login', '127.0.0.1:4720', undefined, 'application/json', '{"mode":"device-code"}'],
          ['DELETE', '/api/connectors/aws/sessions/sessao-remota/login', '127.0.0.1:4720', undefined, null, ''],
        ],
      );
      // The remote's refusal comes back with its status and reason; a remote without the route, 404 without a reason.
      remote.answers.login = { status: 409, body: { error: 'a aws CLI desta máquina não tem o login por código', reason: 'device-code-unsupported' } };
      const refused = await call(b.api.url, 'POST', path);
      assert.equal(refused.status, 409);
      assert.equal(refused.json.reason, 'device-code-unsupported');
      remote.answers.login = { status: 404, body: { error: 'não encontrado' } };
      const old = await call(b.api.url, 'POST', path);
      assert.equal(old.status, 404);
      assert.equal(old.json.reason, undefined);
      // An unsafe name never leaves this Mac.
      const before = remote.requests.length;
      assert.equal((await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connectors/aws/sessions/a;b/login')).status, 404);
      assert.equal(remote.requests.length, before);
      // Nothing ran on this Mac.
      assert.deepEqual(sso(b), []);
    } finally {
      await b.close();
      await remote.close();
    }
  });

  test('#277 unknown machine 404; the local id 404; a closed tunnel: unreachable on GET, 502 on POST', async () => {
    const remote = await fakeRemote({ connectors: { status: 200, body: remoteBody }, login: { status: 202, body: {} } });
    const closedPort = remote.port;
    await remote.close();
    const b = await boot({}, { 'ws-exemplo': closedPort });
    try {
      assert.equal((await call(b.api.url, 'GET', '/api/machines/nao-existe/connectors')).status, 404);
      assert.equal((await call(b.api.url, 'GET', '/api/machines/local/connectors')).status, 404);
      const g = await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connectors');
      assert.deepEqual(g.json, { machine: 'ws-exemplo', status: 'unreachable', reason: 'port-closed', connectors: [] });
      const p = await call(b.api.url, 'POST', '/api/machines/ws-exemplo/connectors/aws/sessions/sessao-remota/login');
      assert.equal(p.status, 502);
      assert.equal(p.json.reason, 'unreachable');
    } finally {
      await b.close();
    }
  });

  test('#277 a remote núcleo without the route: unsupported', async () => {
    const remote = await fakeRemote({ connectors: { status: 404, body: { error: 'não encontrado' } }, login: { status: 404, body: {} } });
    const b = await boot({}, { 'ws-exemplo': remote.port });
    try {
      const g = await call(b.api.url, 'GET', '/api/machines/ws-exemplo/connectors');
      assert.deepEqual(g.json, { machine: 'ws-exemplo', status: 'unsupported', connectors: [] });
    } finally {
      await b.close();
      await remote.close();
    }
  });
});
