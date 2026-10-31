// The AWS connector (#277, decision 0013 sections 2 and 3) with a FAKE `aws` on a temporary PATH
// (fake-aws.ts): the CLI found or not, v1, the session states from the probe and the cache, one probe
// per session at a time, the config re-read by mtime with the last good reading kept, the login
// guards, the change publishing, and a sentinel token that reaches no response or log.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { MCP_CHANGE_TYPES } from '../../src/changes/mcp.ts';
import { AwsConnector, parseAwsVersion, publishConnectorChanges, sessionState, type AwsConnectorOptions } from '../../src/clouds/aws-connector.ts';
import { ssoCacheFileName } from '../../src/clouds/aws-sso-cache.ts';
import { append, CONFIG, fakeAws, type FakeAws, type FakeAwsState } from './fake-aws.ts';

const SENTINEL = 'TOKEN-SENTINEL-9a8b7c';
const cacheFile = (f: FakeAws, name: string) => join(f.cacheDir, ssoCacheFileName({ kind: 'sso-session', name, startUrl: null })!);
const writeCache = (f: FakeAws, name: string, msFromNow: number) =>
  writeFileSync(cacheFile(f, name), JSON.stringify({ startUrl: 'https://exemplo.awsapps.com/start', region: 'regiao-exemplo-1', accessToken: SENTINEL, refreshToken: SENTINEL, expiresAt: new Date(Date.now() + msFromNow).toISOString().replace(/\.\d+Z$/, 'Z') }));

function setup(state: Partial<FakeAwsState> = {}, over: Partial<AwsConnectorOptions> = {}, pathTo: 'bin' | 'empty' = 'bin') {
  const f = fakeAws(state);
  f.writeConfig(CONFIG);
  const logs: string[] = [];
  let changes = 0;
  const c = new AwsConnector({
    logFile: f.logFile,
    home: f.home,
    env: { HOME: f.home, PATH: '/usr/bin:/bin' },
    loginPath: async () => (pathTo === 'bin' ? f.bin : f.emptyBin),
    log: (m) => logs.push(m),
    onChange: () => changes++,
    login: { msPerSecond: 20, killGraceMs: 150 },
    ...over,
  });
  return { f, c, logs, changes: () => changes };
}

const stsCalls = (f: FakeAws) => f.calls().filter((a) => a[0] === 'sts');
const loginCalls = (f: FakeAws) => f.calls().filter((a) => a[0] === 'sso');

describe('#277 AwsConnector', () => {
  test('#277 valid: the probe answers and the cache has more than 15 min; the probe uses the first profile of the session', async () => {
    const { f, c } = setup({ sts: 'ok' });
    try {
      writeCache(f, 'sessao-exemplo', 2 * 3600_000);
      await c.probeAll();
      const v = await c.view();
      assert.equal(v.kind, 'aws');
      assert.deepEqual(v.cli, { found: true, version: 2, deviceCodeSupported: true });
      assert.deepEqual(v.configFile, { status: 'ok' });
      const s = v.sessions.find((x) => x.name === 'sessao-exemplo')!;
      assert.equal(s.state, 'valid');
      assert.ok(s.expiresAt && Math.abs(Date.parse(s.expiresAt) - (Date.now() + 2 * 3600_000)) < 5000);
      assert.ok(s.checkedAt);
      assert.equal(s.login.state, 'idle');
      assert.deepEqual(stsCalls(f)[0], ['sts', 'get-caller-identity', '--profile', 'perfil-dev', '--output', 'json']);
      assert.deepEqual(stsCalls(f)[1], ['sts', 'get-caller-identity', '--profile', 'perfil-antigo', '--output', 'json']);
      // The legacy session has no cache file: the probe answered, so valid without an end.
      assert.equal(v.sessions.find((x) => x.name === 'perfil-antigo')!.state, 'valid');
      assert.deepEqual(v.outOfScope, [
        { name: 'default', reason: 'no-sso' },
        { name: 'perfil-chave', reason: 'no-sso' },
      ]);
      assert.equal(v.state, 'valid');
    } finally {
      f.close();
    }
  });

  test('#277 expiring (15 min or less), expired (token error with a cache file), never (no cache file), unknown (another error)', async () => {
    const { f, c } = setup({ sts: 'ok' });
    try {
      writeCache(f, 'sessao-exemplo', 10 * 60_000);
      await c.probeAll();
      assert.equal((await c.view()).sessions[0]!.state, 'expiring');
      assert.equal((await c.view()).state, 'expiring');

      f.set({ sts: 'expired' });
      writeCache(f, 'sessao-exemplo', -3600_000);
      await c.probeAll();
      let v = await c.view();
      assert.equal(v.sessions[0]!.state, 'expired');
      assert.equal(v.sessions[1]!.state, 'never');
      assert.equal(v.state, 'expired');

      f.set({ sts: 'error' });
      await c.probeAll();
      v = await c.view();
      assert.deepEqual(
        v.sessions.map((s) => s.state),
        ['unknown', 'unknown'],
      );
    } finally {
      f.close();
    }
  });

  test('#277 the state rules', () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    assert.equal(sessionState('ok', null, now), 'valid');
    assert.equal(sessionState('ok', at(-1000), now), 'expiring');
    assert.equal(sessionState('expired', null, now), 'never');
    assert.equal(sessionState('expired', at(3600_000), now), 'expired');
    assert.equal(sessionState(null, null, now), 'never');
    assert.equal(sessionState(null, at(-1), now), 'expired');
    assert.equal(sessionState(null, at(60_000), now), 'expiring');
    assert.equal(sessionState(null, at(3600_000), now), 'valid');
    assert.deepEqual(parseAwsVersion('aws-cli/2.22.1 Python/3.12'), { major: 2, minor: 22 });
    assert.equal(parseAwsVersion('outra coisa'), null);
  });

  test('#277 v1: shown as found, version 1, no probe and no login', async () => {
    const { f, c } = setup({ version: '1.29.0' });
    try {
      await c.probeAll();
      const v = await c.view();
      assert.deepEqual(v.cli, { found: true, version: 1, deviceCodeSupported: false });
      assert.equal(v.state, 'unsupported-cli');
      assert.deepEqual(await c.login('sessao-exemplo', 'browser', 'ui'), { kind: 'refused', reason: 'cli-unsupported' });
      assert.deepEqual(stsCalls(f), []);
      assert.deepEqual(loginCalls(f), []);
    } finally {
      f.close();
    }
  });

  test('#277 an older v2 without --use-device-code: browser login only', async () => {
    const { f, c } = setup({ version: '2.15.0' });
    try {
      assert.equal((await c.view()).cli.deviceCodeSupported, false);
      assert.deepEqual(await c.login('sessao-exemplo', 'device-code', 'local'), { kind: 'refused', reason: 'device-code-unsupported' });
      assert.deepEqual(loginCalls(f), []);
    } finally {
      f.close();
    }
  });

  test('#277 no aws on the PATH: missing-cli, sessions from the cache alone, no login', async () => {
    const { f, c } = setup({}, {}, 'empty');
    try {
      writeCache(f, 'sessao-exemplo', 2 * 3600_000);
      await c.probeAll();
      const v = await c.view();
      assert.deepEqual(v.cli, { found: false, version: null, deviceCodeSupported: false });
      assert.equal(v.state, 'missing-cli');
      assert.equal(v.sessions[0]!.state, 'valid');
      assert.equal(v.sessions[0]!.checkedAt, null);
      assert.deepEqual(await c.login('sessao-exemplo', 'browser', 'ui'), { kind: 'refused', reason: 'cli-missing' });
      assert.deepEqual(f.calls(), []);
    } finally {
      f.close();
    }
  });

  test('#277 never more than one probe per session at a time', async () => {
    const { f, c } = setup({ sts: 'ok', stsSleepMs: 300 });
    try {
      await c.view();
      await Promise.all([c.probe('sessao-exemplo'), c.probe('sessao-exemplo'), c.probe('sessao-exemplo')]);
      assert.equal(stsCalls(f).length, 1);
    } finally {
      f.close();
    }
  });

  test('#277 the config is re-read by mtime: a session added appears; a parse error keeps the last good reading, with the line, and blocks login', async () => {
    const { f, c } = setup();
    try {
      assert.equal((await c.view()).sessions.length, 2);
      append(f.configFile, '\n[sso-session sessao-nova]\nsso_start_url = https://novo-exemplo.awsapps.com/start\n');
      assert.deepEqual(
        (await c.view()).sessions.map((s) => s.name),
        ['sessao-exemplo', 'sessao-nova', 'perfil-antigo'],
      );
      append(f.configFile, 'linha quebrada\n');
      const v = await c.view();
      assert.equal(v.configFile.status, 'error');
      assert.equal(v.configFile.error?.line, CONFIG.split('\n').length + 3);
      assert.equal(v.sessions.length, 3);
      assert.deepEqual(await c.login('sessao-exemplo', 'browser', 'ui'), { kind: 'refused', reason: 'invalid-file' });
      assert.deepEqual(loginCalls(f), []);
    } finally {
      f.close();
    }
  });

  test('#277 a config file that is gone: missing, not-configured', async () => {
    const { f, c } = setup();
    try {
      f.writeConfig('');
      const { rmSync } = await import('node:fs');
      rmSync(f.configFile);
      const v = await c.view();
      assert.deepEqual(v.configFile, { status: 'missing' });
      assert.equal(v.state, 'not-configured');
      assert.deepEqual(await c.login('sessao-exemplo', 'browser', 'ui'), { kind: 'refused', reason: 'unknown' });
    } finally {
      f.close();
    }
  });

  test('#277 login: the fixed argv from the file, probed right after exit 0, changes published', async () => {
    const { f, c, changes } = setup({ sts: 'expired', login: 'ok' });
    try {
      await c.probeAll();
      assert.equal((await c.view()).sessions[0]!.state, 'never');
      f.set({ sts: 'ok', cacheWrite: { path: cacheFile(f, 'sessao-exemplo'), content: JSON.stringify({ accessToken: SENTINEL, expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() }) } });
      const before = stsCalls(f).length;
      const r = await c.login('sessao-exemplo', 'browser', 'ui');
      assert.equal(r.kind, 'started');
      await c.logins.exited('sessao-exemplo');
      await new Promise((res) => setTimeout(res, 50));
      await c.probe('sessao-exemplo');
      assert.deepEqual(loginCalls(f), [['sso', 'login', '--sso-session', 'sessao-exemplo']]);
      assert.ok(stsCalls(f).length > before, 'probed after the login');
      const v = await c.view();
      assert.equal(v.sessions[0]!.state, 'valid');
      assert.equal(v.sessions[0]!.login.state, 'succeeded');
      assert.ok(changes() >= 3);

      await c.login('perfil-antigo', 'device-code', 'local');
      await c.logins.exited('perfil-antigo');
      assert.deepEqual(loginCalls(f).at(-1), ['sso', 'login', '--profile', 'perfil-antigo', '--use-device-code', '--no-browser']);
    } finally {
      f.close();
    }
  });

  test('#277 login refuses an unknown session and an unsupported name, spawning nothing', async () => {
    const { f, c } = setup();
    try {
      append(f.configFile, '\n[sso-session nome com espaco]\nsso_start_url = https://exemplo.awsapps.com/start\n');
      assert.deepEqual(await c.login('nao-existe', 'browser', 'ui'), { kind: 'refused', reason: 'unknown' });
      assert.deepEqual(await c.login('nome com espaco', 'browser', 'ui'), { kind: 'refused', reason: 'name-not-supported' });
      assert.deepEqual(loginCalls(f), []);
      assert.deepEqual(await c.cancel('nao-existe'), { kind: 'unknown' });
      assert.deepEqual(await c.cancel('sessao-exemplo'), { kind: 'not-running' });
    } finally {
      f.close();
    }
  });

  test('#277 the sentinel token and the command output reach no view, console log line or reconnect.log', async () => {
    const { f, c, logs } = setup({ sts: 'ok', login: 'ok' });
    try {
      writeCache(f, 'sessao-exemplo', 2 * 3600_000);
      await c.probeAll();
      await c.login('sessao-exemplo', 'browser', 'ui');
      await c.logins.exited('sessao-exemplo');
      f.set({ sts: 'error' });
      await c.probeAll();
      const all = JSON.stringify(await c.view()) + logs.join('\n') + readFileSync(f.logFile, 'utf8');
      assert.doesNotMatch(all, new RegExp(SENTINEL));
      assert.doesNotMatch(all, /STS-OUTPUT-SENTINEL|STS-ERROR-SENTINEL/);
      assert.doesNotMatch(JSON.stringify(await c.view()) + logs.join('\n'), /LOGIN-OUTPUT-SENTINEL/);
    } finally {
      f.close();
    }
  });

  test('#277 the change is { type: connector, key: aws }, for the HTTP route only (not MCP)', async () => {
    const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
    const start = cursor.current;
    publishConnectorChanges(cursor)();
    const all = await cursor.wait(start, { timeoutMs: 0 });
    assert.deepEqual(
      all.changes.map((x) => [x.type, x.key, x.sessionId, x.accountId]),
      [['connector', 'aws', null, null]],
    );
    assert.equal((MCP_CHANGE_TYPES as readonly string[]).includes('connector'), false);
  });

  test('#277 start probes at once and on the interval; stop ends the timer', async () => {
    let tick: (() => void) | null = null;
    const { f, c } = setup({ sts: 'ok' }, { timers: { setInterval: (fn) => ((tick = fn), 1), clearInterval: () => (tick = null) } });
    try {
      c.start();
      await c.probeAll();
      const first = stsCalls(f).length;
      assert.ok(first >= 2);
      tick!();
      await c.probeAll();
      assert.ok(stsCalls(f).length > first);
      await c.stop();
      assert.equal(tick, null);
    } finally {
      f.close();
    }
  });

  test('#277 nothing runs at construction; with wakeOnView the first view starts the probing, and not after stop', async () => {
    let ticks = 0;
    const { f, c } = setup({ sts: 'ok' }, { wakeOnView: true, timers: { setInterval: () => (ticks++, 1), clearInterval: () => {} } });
    try {
      await new Promise((res) => setTimeout(res, 100));
      assert.deepEqual(f.calls(), []);
      await c.view();
      await c.probeAll();
      assert.equal(ticks, 1);
      assert.ok(stsCalls(f).length >= 2);
      await c.stop();
      await c.view();
      assert.equal(ticks, 1);
    } finally {
      f.close();
    }
  });
});
