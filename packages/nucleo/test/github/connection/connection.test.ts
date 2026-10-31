// The GitHub connection service (#241, decision 0011): the state machine behind /api/connections and
// the one credential provider every GitHub source takes its token from. Fake GitHub, in-memory vault,
// manual timers and clock: nothing leaves the process, and `gh` never runs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GithubConnection,
  GithubConnectionError,
  GithubNotConnectedError,
  MAX_CHECKED_ORGS,
  MemoryVault,
  missingScopes,
  type CredentialVault,
  type GithubConnectionOptions,
  type GithubConnectionStatus,
} from '../../../src/github/connection/index.ts';
import { GithubCallQueue } from '../../../src/github/call-queue.ts';
import { SemGithubError } from '../../../src/github/repos-source.ts';
import { MemoryInstallationSettings } from '../../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, type FakeGithubAuth } from '../../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEconnection000000000000000000000';
const OTHER_TOKEN = 'gho_FAKEsecondaccount0000000000000000000';
const T0 = Date.parse('2026-10-21T12:00:00.000Z');
const REQUIRED = ['repo', 'read:org', 'project'];
const APPROVAL = 'https://github.com/settings/connections/applications/test-client-id';

/** A vault that counts calls and can be made to fail. */
class SpyVault implements CredentialVault {
  readonly kind = 'memory' as const;
  readonly inner: MemoryVault;
  calls: string[] = [];
  fail = new Set<string>();
  /** While set, `set` waits for it (a test races an action against the vault write). */
  setGate: Promise<void> | null = null;
  constructor(seed: Record<string, string> = {}) {
    this.inner = new MemoryVault(seed);
  }
  private check(op: string) {
    this.calls.push(op);
    if (this.fail.has(op)) throw new Error(`vault ${op} failed`);
  }
  async get(a: string) {
    this.check('get');
    return this.inner.get(a);
  }
  async set(a: string, s: string) {
    this.check('set');
    if (this.setGate) await this.setGate;
    return this.inner.set(a, s);
  }
  async delete(a: string) {
    this.check('delete');
    return this.inner.delete(a);
  }
  async list() {
    this.check('list');
    return this.inner.list();
  }
}

interface Setup {
  auth?: Partial<FakeGithubAuth>;
  vault?: CredentialVault | null;
  seed?: Record<string, string>;
  settings?: MemoryInstallationSettings;
  options?: Partial<GithubConnectionOptions>;
}

function setup(o: Setup = {}) {
  let t = T0;
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let seq = 0;
  const auth: FakeGithubAuth = { clientId: 'test-client-id', token: TOKEN, scopes: [...REQUIRED], login: 'dev-sintetico', interval: 5, ...o.auth };
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { now: () => t, auth });
  const vault = o.vault === undefined ? new SpyVault(o.seed) : o.vault;
  const settings = o.settings ?? new MemoryInstallationSettings();
  const events = { change: 0, identity: 0 };
  const logs: string[] = [];
  const queued: string[] = [];
  const queue = new GithubCallQueue();
  const run = queue.run.bind(queue);
  queue.run = (fn) => {
    queued.push('run');
    return run(fn);
  };
  const setTimer = (fn: () => void, ms: number) => {
    timers.push({ id: ++seq, fn, ms });
    return seq;
  };
  const clearTimer = (id: unknown) => {
    const i = timers.findIndex((x) => x.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const conn = new GithubConnection({
    vault,
    settings,
    clientId: 'test-client-id',
    fetch: gh.fetch,
    oauthUrl: 'http://fake-github.test',
    apiUrl: 'http://fake-api.test',
    env: {},
    ghInstalled: () => false,
    ghToken: () => assert.fail('gh must not run in this test'),
    now: () => t,
    setTimer,
    clearTimer,
    queue,
    onChange: () => void events.change++,
    onIdentityChange: () => void events.identity++,
    log: (line) => void logs.push(line),
    ...o.options,
  });
  return {
    conn,
    gh,
    auth,
    vault: vault as SpyVault,
    settings,
    events,
    logs,
    queued,
    timers,
    setTimer,
    clearTimer,
    now: () => t,
    advance: (ms: number) => (t += ms),
    /** Runs the next timer (advancing the clock by its delay) and waits for the poll to settle. */
    async fire() {
      const next = timers.shift();
      assert.ok(next, 'a poll is scheduled');
      t += next.ms;
      next.fn();
      await conn.idle();
      return next.ms;
    },
  };
}

/** Starts the device flow and polls until it ends. */
async function connect(s: ReturnType<typeof setup>) {
  await s.conn.start();
  while (s.timers.length > 0) await s.fire();
  await s.conn.idle();
  return s.conn.status();
}

const COMMON = ['state', 'source', 'sourceFrom', 'vault', 'clientId', 'ghInstalled', 'requiredScopes'];

describe('#241/AC-2 unavailable: no client id, no vault, GitHub off', () => {
  test('no client id: unavailable no-client-id, start refuses, token() is not connected; nothing touched', async () => {
    const s = setup({ options: { clientId: null } });
    const st = await s.conn.status();
    assert.equal(st.state, 'unavailable');
    assert.equal(st.reason, 'no-client-id');
    assert.equal(st.clientId, null);
    await assert.rejects(s.conn.start(), (e: GithubConnectionError) => e.code === 'github-unavailable' && e.reason === 'no-client-id');
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.equal(await s.conn.connected(), false);
    assert.deepEqual(s.vault.calls, []);
    assert.deepEqual(s.gh.calls, []);
  });

  test('no vault: unavailable no-vault, vault null in the status', async () => {
    const s = setup({ vault: null });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.reason, st.vault], ['unavailable', 'no-vault', null]);
    await assert.rejects(s.conn.start(), (e: GithubConnectionError) => e.reason === 'no-vault');
  });

  test('GitHub off (--no-github): unavailable github-off for both sources', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN }, options: { off: true } });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.reason], ['unavailable', 'github-off']);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.deepEqual(s.vault.calls, []);
  });

  test('GithubNotConnectedError is a SemGithubError (the services already treat it as "no GitHub")', () => {
    const e = new GithubNotConnectedError();
    assert.ok(e instanceof SemGithubError);
    assert.equal(e.code, 'github-not-connected');
  });
});

describe('#241/AC-2 connecting through the device flow', () => {
  test('the vault is touched lazily: building the connection reads nothing', async () => {
    const s = setup();
    assert.deepEqual(s.vault.calls, []);
    const st = await s.conn.status();
    assert.deepEqual(Object.keys(st).slice(0, COMMON.length), COMMON);
    assert.deepEqual(
      { state: st.state, source: st.source, sourceFrom: st.sourceFrom, vault: st.vault, clientId: st.clientId, ghInstalled: st.ghInstalled, requiredScopes: st.requiredScopes, lastError: st.lastError },
      { state: 'disconnected', source: 'console', sourceFrom: 'default', vault: 'memory', clientId: 'test-client-id', ghInstalled: false, requiredScopes: REQUIRED, lastError: null },
    );
    assert.deepEqual(s.vault.calls, ['list']);
  });

  test('start → pending with the user code; a second start returns the same code without a new request', async () => {
    const s = setup({ auth: { interval: 7, expiresIn: 900 } });
    const st = await s.conn.start();
    assert.equal(st.state, 'pending');
    assert.equal(st.userCode, 'FAKE-0001');
    assert.equal(st.verificationUri, 'https://github.com/login/device');
    assert.equal(st.expiresAt, new Date(T0 + 900_000).toISOString());
    assert.equal(st.interval, 7);
    assert.equal(s.events.change, 1);
    const again = await s.conn.start();
    assert.equal(again.userCode, 'FAKE-0001');
    assert.equal(s.gh.auth!.deviceCodes.length, 1);
    assert.deepEqual(s.timers.map((x) => x.ms), [7000]);
    const [concurrentA, concurrentB] = await Promise.all([s.conn.start(), s.conn.start()]);
    assert.equal(concurrentA.userCode, concurrentB.userCode);
    assert.equal(s.gh.auth!.deviceCodes.length, 1);
  });

  test('pending polls until the token, then connected: vault, settings, token(), scopes, events', async () => {
    const s = setup({ auth: { approveAfterPolls: 2 } });
    await s.conn.start();
    await s.fire();
    await s.fire();
    assert.equal((await s.conn.status()).state, 'pending');
    await s.fire();
    const st = await s.conn.status();
    assert.equal(st.state, 'connected');
    assert.equal(st.login, 'dev-sintetico');
    assert.deepEqual(st.scopes, REQUIRED);
    assert.deepEqual(st.missingScopes, []);
    assert.equal(st.revokeUrl, APPROVAL);
    assert.equal(await s.vault.inner.get('dev-sintetico'), TOKEN);
    assert.equal(s.settings.get('github.login'), 'dev-sintetico');
    assert.equal(await s.conn.token(), TOKEN);
    assert.equal(await s.conn.connected(), true);
    assert.equal(s.timers.length, 0, 'no poll left');
    assert.equal(s.events.identity, 1);
    assert.ok(s.events.change >= 2);
    assert.equal(s.gh.auth!.polls.get(s.gh.auth!.deviceCodes[0]), 3);
  });

  test('slow_down raises the interval to the one GitHub returns', async () => {
    const s = setup({ auth: { slowDownOnPoll: 1, interval: 5, approveAfterPolls: 5 } });
    await s.conn.start();
    assert.equal(await s.fire(), 5000);
    assert.deepEqual(s.timers.map((x) => x.ms), [10_000]);
    assert.equal((await s.conn.status()).interval, 10);
  });

  test('slow_down without an interval adds 5 s', async () => {
    const s = setup({ auth: { interval: 5 } });
    let first = true;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/login/oauth/access_token') && first) {
        first = false;
        return Response.json({ error: 'slow_down' });
      }
      return s.gh.fetch(input, init);
    }) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    const [t] = s.timers.splice(0);
    s.advance(t.ms);
    t.fn();
    await conn.idle();
    assert.deepEqual(s.timers.map((x) => x.ms), [10_000]);
    conn.close();
  });

  test('access_denied ends the flow: disconnected, lastError denied, nothing stored', async () => {
    const s = setup({ auth: { deny: true } });
    const st = await connect(s);
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'denied']);
    assert.deepEqual(await s.vault.inner.list(), []);
    assert.equal(s.settings.get('github.login'), null);
    assert.equal(s.events.identity, 0);
  });

  test('expired_token from GitHub ends the flow with lastError expired', async () => {
    const s = setup({ auth: { neverApprove: true, expiresIn: 12, interval: 5 } });
    await s.conn.start();
    await s.fire(); // 5 s: pending
    await s.fire(); // 10 s: pending
    assert.equal((await s.conn.status()).state, 'pending');
    await s.fire(); // 15 s: past expiresAt
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'expired']);
    assert.equal(s.timers.length, 0);
  });

  test('past expiresAt the status says expired even before the next poll; start begins a new code', async () => {
    const s = setup({ auth: { neverApprove: true, expiresIn: 900 } });
    await s.conn.start();
    s.advance(901_000);
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'expired']);
    assert.equal(s.timers.length, 0);
    const again = await s.conn.start();
    assert.equal(again.userCode, 'FAKE-0002');
    assert.equal(again.lastError, undefined);
  });

  test('a GitHub error code ends the flow with github-error; a failed code request throws github-error', async () => {
    const s = setup();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/login/oauth/access_token') ? Response.json({ error: 'device_flow_disabled' }) : s.gh.fetch(input, init)) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    const [t] = s.timers.splice(0);
    t.fn();
    await conn.idle();
    assert.deepEqual([(await conn.status()).state, (await conn.status()).lastError], ['disconnected', 'github-error']);

    const refused = new GithubConnection({ ...connOptions(s), clientId: 'not-the-app' });
    await assert.rejects(refused.start(), (e: GithubConnectionError) => e.code === 'github-error');
    assert.equal((await refused.status()).state, 'disconnected');
  });

  test('a network failure while polling keeps the flow pending', async () => {
    const s = setup();
    let down = true;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (down && String(input).endsWith('/login/oauth/access_token')) throw new TypeError('fetch failed');
      return s.gh.fetch(input, init);
    }) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    let [t] = s.timers.splice(0);
    t.fn();
    await conn.idle();
    assert.equal((await conn.status()).state, 'pending');
    down = false;
    [t] = s.timers.splice(0);
    t.fn();
    await conn.idle();
    [t] = s.timers.splice(0);
    t.fn();
    await conn.idle();
    assert.equal((await conn.status()).state, 'connected');
  });

  test('cancel drops the flow and its timer; a poll answer arriving after cancel is ignored', async () => {
    const s = setup({ auth: { approveAfterPolls: 0 } });
    await s.conn.start();
    const [t] = s.timers;
    const changes = s.events.change;
    const st = await s.conn.cancel();
    assert.deepEqual([st.state, st.lastError], ['disconnected', null]);
    assert.equal(s.timers.length, 0);
    assert.equal(s.events.change, changes + 1);
    t.fn(); // a timer callback that fired anyway
    await s.conn.idle();
    assert.equal((await s.conn.status()).state, 'disconnected');
    assert.deepEqual(await s.vault.inner.list(), []);
    await s.conn.cancel(); // no flow: no-op
  });

  test('missing scopes: required minus granted; admin:org and write:org satisfy read:org', async () => {
    assert.deepEqual(missingScopes(['repo']), ['read:org', 'project']);
    assert.deepEqual(missingScopes(['repo', 'admin:org', 'project']), []);
    assert.deepEqual(missingScopes(['repo', 'write:org', 'read:project']), ['project']);
    const s = setup({ auth: { scopes: ['repo'] } });
    const st = await connect(s);
    assert.deepEqual(st.scopes, ['repo']);
    assert.deepEqual(st.missingScopes, ['read:org', 'project']);
  });

  test('#336 the orgs the token sees and the public ones that restrict the app, through the single call queue', async () => {
    const s = setup({ auth: { blockedOrgs: ['estudio-ficticio'] } });
    await connect(s);
    const st = await s.conn.status();
    assert.equal(st.orgsChecked, true);
    assert.deepEqual(st.orgs, [
      { login: 'estudio-ficticio', access: 'pending', approvalUrl: 'https://github.com/organizations/estudio-ficticio/settings/oauth_application_policy', requestUrl: APPROVAL },
      { login: 'exemplo-labs', access: 'granted' },
    ]);
    const apiCalls = s.gh.calls.filter((c) => c.startsWith('GET '));
    assert.deepEqual(apiCalls, ['GET /user', 'GET /user/orgs?per_page=100', 'GET /users/dev-sintetico/orgs?per_page=100', 'GET /user/memberships/orgs/estudio-ficticio']);
    assert.equal(s.queued.length, apiCalls.length, 'every API call went through the queue');
  });

  test('#336 without the public list, the orgs the token sees still show', async () => {
    const s = setup({ auth: { blockedOrgs: ['estudio-ficticio'] } });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/users/') ? new Response('{}', { status: 502 }) : s.gh.fetch(input, init)) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    while (s.timers.length) {
      s.timers.shift()!.fn();
      await conn.idle();
    }
    const st = await conn.status();
    assert.deepEqual([st.orgsChecked, st.orgs], [true, [{ login: 'exemplo-labs', access: 'granted' }]]);
  });

  test('#336 recheckOrgs reads the orgs again after an owner approves the app', async () => {
    const s = setup({ auth: { blockedOrgs: ['estudio-ficticio'] } });
    await connect(s);
    assert.equal((await s.conn.status()).orgs?.[0]?.access, 'pending');
    s.auth.blockedOrgs = [];
    const during = await s.conn.recheckOrgs();
    assert.equal(during.orgsChecked, false);
    await s.conn.idle();
    const st = await s.conn.status();
    assert.deepEqual([st.orgsChecked, st.orgs], [true, [{ login: 'exemplo-labs', access: 'granted' }, { login: 'estudio-ficticio', access: 'granted' }]]);
  });

  test('#336 a recheck that fails says so and can run again; the next one succeeds', async () => {
    const s = setup({ auth: { blockedOrgs: ['estudio-ficticio'] } });
    let down = false;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      down && String(input).includes('/user/orgs') ? new Response('{}', { status: 502 }) : s.gh.fetch(input, init)) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    while (s.timers.length) {
      s.timers.shift()!.fn();
      await conn.idle();
    }
    const before = (await conn.status()).orgs;
    down = true;
    await conn.recheckOrgs();
    await conn.idle();
    const failed = await conn.status();
    assert.deepEqual([failed.orgsChecked, failed.orgsFailed, failed.orgs], [true, true, before], 'what the earlier check found stays');
    down = false;
    s.auth.blockedOrgs = [];
    assert.equal((await conn.recheckOrgs()).orgsChecked, false, 'a failed check does not block the next one');
    await conn.idle();
    const st = await conn.status();
    assert.deepEqual([st.orgsChecked, st.orgsFailed, st.orgs?.map((o) => o.access)], [true, false, ['granted', 'granted']]);
  });

  test('#336 a recheck while a check runs starts no second one', async () => {
    const s = setup();
    await connect(s);
    const reads = () => s.gh.calls.filter((c) => c.startsWith('GET /user/orgs')).length;
    const n = reads();
    await Promise.all([s.conn.recheckOrgs(), s.conn.recheckOrgs()]);
    await s.conn.idle();
    assert.equal(reads(), n + 1);
  });

  test('#336 each list keeps at most MAX_CHECKED_ORGS', async () => {
    const many = Array.from({ length: MAX_CHECKED_ORGS + 5 }, (_, i) => `org-${i}`);
    const s = setup({ auth: { publicOrgs: many } });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/user/orgs')) return Response.json(many.slice(0, MAX_CHECKED_ORGS + 5).map((login) => ({ login })));
      if (url.includes('/users/')) return Response.json(many.map((login) => ({ login: `${login}-pub` })));
      if (url.includes('/user/memberships/orgs/')) return Response.json({ state: 'active' });
      return s.gh.fetch(input, init);
    }) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    while (s.timers.length) {
      s.timers.shift()!.fn();
      await conn.idle();
    }
    const st = await conn.status();
    assert.equal(st.orgs?.length, MAX_CHECKED_ORGS);
  });

  test('a failing org list ends the check as failed, with no org', async () => {
    const s = setup();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/user/orgs') ? new Response('{}', { status: 502 }) : s.gh.fetch(input, init)) as typeof globalThis.fetch;
    const conn = new GithubConnection({ ...connOptions(s), fetch });
    await conn.start();
    while (s.timers.length) {
      s.timers.shift()!.fn();
      await conn.idle();
    }
    const st = await conn.status();
    assert.deepEqual([st.state, st.orgsChecked, st.orgsFailed, st.orgs], ['connected', true, true, []]);
  });
});

describe('#241/AC-3 the credential lives only in the vault', () => {
  test('adopts the single vault entry on first access, reading the secret once', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    const st = await s.conn.status();
    assert.equal(st.state, 'connected');
    assert.equal(st.login, 'dev-sintetico');
    assert.equal(s.settings.get('github.login'), 'dev-sintetico');
    assert.equal(await s.conn.token(), TOKEN);
    assert.equal(await s.conn.token(), TOKEN);
    assert.deepEqual(s.vault.calls, ['list', 'get']);
  });

  test('token() needs only the vault, not GitHub', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    const conn = new GithubConnection({ ...connOptions(s), fetch: (async () => assert.fail('no GitHub call for a token')) as never });
    s.settings.set('github.login', 'dev-sintetico');
    const done = conn.token();
    assert.equal(await done, TOKEN);
    conn.close();
  });

  test('two vault entries and no login: nothing is adopted', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN, other: OTHER_TOKEN } });
    assert.equal((await s.conn.status()).state, 'disconnected');
    assert.equal(s.settings.get('github.login'), null);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
  });

  test('the settings login wins over adoption; a login whose entry vanished is cleared', async () => {
    const settings = new MemoryInstallationSettings({ 'github.login': 'gone-user' });
    const s = setup({ seed: { 'dev-sintetico': TOKEN }, settings });
    const st = await s.conn.status();
    assert.equal(st.state, 'disconnected');
    assert.equal(settings.get('github.login'), null);
    assert.deepEqual(s.vault.calls, ['get']);
  });

  test('a vault read failure is vault-error, and the next access tries again', async () => {
    const settings = new MemoryInstallationSettings({ 'github.login': 'dev-sintetico' });
    const s = setup({ seed: { 'dev-sintetico': TOKEN }, settings });
    s.vault.fail.add('get');
    assert.deepEqual([(await s.conn.status()).state, (await s.conn.status()).lastError], ['disconnected', 'vault-error']);
    assert.equal(settings.get('github.login'), 'dev-sintetico', 'a transient failure keeps the login');
    s.vault.fail.clear();
    assert.equal(await s.conn.token(), TOKEN);
  });

  test('a vault write failure ends the flow with vault-error and stores nothing', async () => {
    const s = setup();
    s.vault.fail.add('set');
    const st = await connect(s);
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'vault-error']);
    assert.equal(s.settings.get('github.login'), null);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
  });

  test('a credential GitHub rejects (401) is not served (revoked); the vault is left alone', async () => {
    const s = setup({ seed: { 'dev-sintetico': 'gho_revoked' } });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'revoked']);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.equal(await s.vault.inner.get('dev-sintetico'), 'gho_revoked');
  });

  test('GitHub down while checking the scopes: still connected, scopesChecked false', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    const conn = new GithubConnection({ ...connOptions(s), fetch: (async () => new Response('', { status: 503 })) as never });
    const st = await conn.status();
    assert.deepEqual([st.state, st.login, st.scopesChecked, st.missingScopes], ['connected', 'dev-sintetico', false, []]);
    assert.equal(await conn.token(), TOKEN);
  });

  test('reconnecting as another login: the old credential serves until the new one replaces it; then the old entry is deleted', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    assert.equal(await s.conn.token(), TOKEN);
    s.auth.login = 'second-account';
    s.auth.token = OTHER_TOKEN;
    await s.conn.start();
    const pending = await s.conn.status();
    assert.equal(pending.state, 'pending');
    assert.equal(pending.login, 'dev-sintetico', 'the still-active connection shows while pending');
    assert.equal(await s.conn.token(), TOKEN);
    const identity = s.events.identity;
    while (s.timers.length) await s.fire();
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.login], ['connected', 'second-account']);
    assert.equal(await s.conn.token(), OTHER_TOKEN);
    assert.equal(s.settings.get('github.login'), 'second-account');
    assert.deepEqual(await s.vault.inner.list(), ['second-account'], 'no live token outlives its use (review 2, decided)');
    assert.equal(s.events.identity, identity + 1);
  });

  test('#241/AC-6 the device code and the credential never leave memory: status, settings, logs', async () => {
    const s = setup({ auth: { blockedOrgs: ['estudio-ficticio'] } });
    const seen: GithubConnectionStatus[] = [await s.conn.status(), await s.conn.start()];
    while (s.timers.length) {
      await s.fire();
      seen.push(await s.conn.status());
    }
    await s.conn.idle();
    seen.push(await s.conn.status());
    const deviceCode = s.gh.auth!.deviceCodes[0];
    const settingsDump = JSON.stringify(['github.login', 'github.source', 'project.selection'].map((k) => s.settings.get(k as never)));
    for (const text of [...seen.map((x) => JSON.stringify(x)), settingsDump, ...s.logs]) {
      assert.ok(!text.includes(TOKEN), `credential in ${text}`);
      assert.ok(!text.includes(deviceCode), `device code in ${text}`);
      assert.ok(!/deviceCode|device_code|token"/i.test(text), `field name in ${text}`);
    }
    assert.ok(s.logs.length > 0, 'something was logged');
  });
});

describe('#241/AC-4 disconnecting', () => {
  test('deletes the vault entry, forgets the credential and the login; identity change; no re-adoption', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    assert.equal(await s.conn.token(), TOKEN);
    const before = { ...s.events };
    const st = await s.conn.disconnect();
    assert.deepEqual([st.state, st.lastError], ['disconnected', null]);
    assert.deepEqual(await s.vault.inner.list(), []);
    assert.equal(s.settings.get('github.login'), null);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.equal(s.events.identity, before.identity + 1);
    assert.equal(s.events.change, before.change + 1);
    await s.vault.inner.set('dev-sintetico', TOKEN); // another installation reconnects meanwhile
    assert.equal((await s.conn.status()).state, 'disconnected', 'not adopted again in this process');
  });

  test('disconnect during a pending flow cancels it too', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.start();
    await s.conn.disconnect();
    assert.equal(s.timers.length, 0);
    assert.equal((await s.conn.status()).state, 'disconnected');
  });

  test('a vault delete failure still forgets everything here and reports vault-error', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.token();
    s.vault.fail.add('delete');
    const st = await s.conn.disconnect();
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'vault-error']);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.equal(s.settings.get('github.login'), null);
  });

  test('under the gh source disconnect is refused (source-is-gh)', async () => {
    const s = setup({ options: { env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'gh' }, ghInstalled: () => true, ghToken: async () => TOKEN } });
    await assert.rejects(s.conn.disconnect(), (e: GithubConnectionError) => e.code === 'source-is-gh');
    await assert.rejects(s.conn.start(), (e: GithubConnectionError) => e.code === 'source-is-gh');
  });

  test('close() clears the poll timer', async () => {
    const s = setup();
    await s.conn.start();
    s.conn.close();
    assert.equal(s.timers.length, 0);
  });
});

describe('#241/AC-2 the gh source (opt-in)', () => {
  test('env forces gh; not installed → unavailable gh-not-installed, gh never runs', async () => {
    const s = setup({ options: { env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'gh' } } });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.reason, st.source, st.sourceFrom], ['unavailable', 'gh-not-installed', 'gh', 'env']);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
  });

  test('gh installed but not authenticated → unavailable gh-not-authenticated; asked once', async () => {
    let asked = 0;
    const s = setup({
      settings: new MemoryInstallationSettings({ 'github.source': 'gh' }),
      options: { ghInstalled: () => true, ghToken: async () => (asked++, Promise.reject(new Error('no token'))) },
    });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.reason, st.sourceFrom], ['unavailable', 'gh-not-authenticated', 'settings']);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.equal(asked, 1);
  });

  test('gh authenticated → connected with the login from /user, no revokeUrl; the vault is never read', async () => {
    let asked = 0;
    const s = setup({ options: { env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'gh' }, ghInstalled: () => true, ghToken: async () => (asked++, TOKEN) } });
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.login, st.revokeUrl, st.ghInstalled], ['connected', 'dev-sintetico', undefined, true]);
    assert.equal(await s.conn.token(), TOKEN);
    assert.equal(asked, 1);
    assert.deepEqual(s.vault.calls, []);
  });

  test('the default gh token function never runs gh under node --test', async () => {
    const s = setup();
    // only the injected env counts: the guard must not depend on this process's NODE_TEST_CONTEXT
    const conn = new GithubConnection({ ...connOptions(s), env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'gh', NODE_TEST_CONTEXT: 'child-v8' }, ghInstalled: () => true, ghToken: undefined });
    assert.equal(conn.ghGuarded, true);
    const st = await conn.status();
    assert.deepEqual([st.state, st.reason], ['unavailable', 'gh-not-authenticated']);
  });
});

describe('#241/AC-2 choosing the source', () => {
  test('setSource validates, needs gh installed, stores the choice and drops the in-memory credentials', async () => {
    let installed = false;
    let ghAsked = 0;
    // gh hands out a credential the fake GitHub accepts too: what tells the sources apart is who is asked
    const s = setup({ seed: { 'dev-sintetico': TOKEN }, options: { ghInstalled: () => installed, ghToken: async () => (ghAsked++, TOKEN) } });
    assert.equal(await s.conn.token(), TOKEN);
    await assert.rejects(s.conn.setSource('keychain' as never), (e: GithubConnectionError) => e.code === 'invalid');
    await assert.rejects(s.conn.setSource('gh'), (e: GithubConnectionError) => e.code === 'gh-not-installed');
    installed = true;
    const identity = s.events.identity;
    const st = await s.conn.setSource('gh');
    assert.deepEqual([st.source, st.sourceFrom, st.state], ['gh', 'settings', 'connected']);
    assert.equal(s.settings.get('github.source'), 'gh');
    assert.equal(await s.conn.token(), TOKEN);
    assert.equal(ghAsked, 1);
    assert.equal(s.events.identity, identity + 1);
    const back = await s.conn.setSource('console');
    assert.deepEqual([back.source, back.state, back.login], ['console', 'connected', 'dev-sintetico']);
    assert.equal(await s.conn.token(), TOKEN);
    assert.equal(s.vault.calls.filter((c) => c === 'get').length, 2, 'the vault is read again after the switch');
    assert.equal(ghAsked, 1);
  });

  test('when the env forces a source, the status says sourceFrom env even after setSource', async () => {
    const s = setup({ options: { env: { AHRENA_CONSOLE_GITHUB_SOURCE: 'console' }, ghInstalled: () => true } });
    const st = await s.conn.setSource('gh');
    assert.deepEqual([st.source, st.sourceFrom], ['console', 'env']);
    assert.equal(s.settings.get('github.source'), 'gh');
  });
});

/** The options of a setup's connection, to build a variant with one dependency changed. */
function connOptions(s: ReturnType<typeof setup>): GithubConnectionOptions {
  return {
    vault: s.vault,
    settings: s.settings,
    clientId: 'test-client-id',
    fetch: s.gh.fetch,
    oauthUrl: 'http://fake-github.test',
    apiUrl: 'http://fake-api.test',
    env: {},
    ghInstalled: () => false,
    ghToken: () => assert.fail('gh must not run in this test'),
    now: s.now,
    setTimer: s.setTimer,
    clearTimer: s.clearTimer,
  };
}

/** Starts a flow and runs polls until the vault write is reached and held. */
async function heldAtVaultWrite(s: ReturnType<typeof setup>) {
  let release!: () => void;
  s.vault.setGate = new Promise<void>((r) => (release = r));
  await s.conn.start();
  while (s.timers.length) {
    const next = s.timers.shift()!;
    s.advance(next.ms);
    next.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (s.vault.calls.includes('set')) break;
  }
  assert.ok(s.vault.calls.includes('set'), 'the flow reached the vault write');
  return () => {
    release();
    return s.conn.idle();
  };
}

describe('#241/AC-2 review B1: no action is undone by a flow finishing behind it', () => {
  test('cancel during the vault write: stays disconnected, the entry just written is removed', async () => {
    const s = setup();
    const release = await heldAtVaultWrite(s);
    await s.conn.cancel();
    await release();
    const st = await s.conn.status();
    assert.equal(st.state, 'disconnected');
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
    assert.deepEqual(await s.vault.inner.list(), []);
    assert.equal(s.settings.get('github.login'), null);
  });

  test('disconnect during the vault write: stays disconnected, nothing stored', async () => {
    const s = setup();
    const release = await heldAtVaultWrite(s);
    await s.conn.disconnect();
    await release();
    assert.equal((await s.conn.status()).state, 'disconnected');
    assert.deepEqual(await s.vault.inner.list(), []);
    assert.equal(s.settings.get('github.login'), null);
  });

  test('setSource(gh) during the vault write: the console token is never served under gh', async () => {
    const s = setup({ options: { ghInstalled: () => true, ghToken: async () => OTHER_TOKEN } });
    const release = await heldAtVaultWrite(s);
    await s.conn.setSource('gh');
    await release();
    // gh's token is not one the fake GitHub accepts, so gh may end not authenticated; never the flow's token
    assert.notEqual(await s.conn.token().catch(() => null), TOKEN);
    assert.equal((await s.conn.status()).source, 'gh');
    assert.deepEqual(await s.vault.inner.list(), []);
  });

  test('the entry of the active login is not deleted when its reconnect is cancelled at the vault write', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    assert.equal(await s.conn.token(), TOKEN);
    s.auth.token = OTHER_TOKEN; // same login, new token
    const release = await heldAtVaultWrite(s);
    await s.conn.cancel();
    await release();
    assert.equal(await s.conn.token(), TOKEN, 'the old credential still serves');
    assert.deepEqual(await s.vault.inner.list(), ['dev-sintetico']);
  });

  for (const action of ['cancel', 'disconnect', 'setSource'] as const) {
    test(`${action} while the device code is being requested: no flow starts`, async () => {
      const s = setup({ options: { ghInstalled: () => true, ghToken: async () => OTHER_TOKEN } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const conn = new GithubConnection({
        ...connOptions(s),
        ghInstalled: () => true,
        ghToken: async () => OTHER_TOKEN,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/login/device/code')) await gate;
          return s.gh.fetch(input, init);
        }) as typeof fetch,
      });
      const starting = conn.start().catch(() => null);
      await new Promise((r) => setImmediate(r));
      if (action === 'cancel') await conn.cancel();
      if (action === 'disconnect') await conn.disconnect();
      if (action === 'setSource') await conn.setSource('gh');
      release();
      await starting;
      await conn.idle();
      assert.notEqual((await conn.status()).state, 'pending');
      assert.equal(s.timers.length, 0, 'no poll scheduled');
    });
  }

  test('401 from /user after the token: github-error, nothing stored', async () => {
    const s = setup();
    const conn = new GithubConnection({
      ...connOptions(s),
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).endsWith('/user') ? Response.json({ message: 'Bad credentials' }, { status: 401 }) : s.gh.fetch(input, init)) as typeof fetch,
    });
    await conn.start();
    while (s.timers.length) {
      const next = s.timers.shift()!;
      next.fn();
      await conn.idle();
    }
    const st = await conn.status();
    assert.deepEqual([st.state, st.lastError], ['disconnected', 'github-error']);
    assert.deepEqual(await s.vault.inner.list(), []);
  });
});

describe('#241/AC-4 review Q1: a disconnect survives a restart', () => {
  const restart = (s: ReturnType<typeof setup>) => new GithubConnection(connOptions(s));

  test('after disconnect, a new core over the same settings does not adopt a single vault entry', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.token();
    await s.conn.disconnect();
    await s.vault.inner.set('dev-sintetico', TOKEN); // another installation reconnected meanwhile
    assert.equal((await restart(s).status()).state, 'disconnected');
    assert.equal(s.settings.get('github.login'), null);
  });

  test('after a failed vault delete the restart stays disconnected too', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.token();
    s.vault.fail.add('delete');
    await s.conn.disconnect();
    s.vault.fail.clear();
    assert.equal((await restart(s).status()).state, 'disconnected');
  });

  test('first boot (no github.login key at all) still adopts; a vanished entry is not re-adopted', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    assert.equal((await s.conn.status()).state, 'connected');
    const gone = setup({ seed: { other: OTHER_TOKEN }, settings: new MemoryInstallationSettings({ 'github.login': 'gone-user' }) });
    assert.equal((await gone.conn.status()).state, 'disconnected');
    assert.equal((await restart(gone).status()).state, 'disconnected', 'the single remaining entry is not adopted');
  });
});

describe('#241/AC-2 review L1, L2, L6', () => {
  test('a GitHub 5xx while polling keeps the flow pending', async () => {
    const s = setup();
    let fail = true;
    const conn = new GithubConnection({
      ...connOptions(s),
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        fail && String(input).endsWith('/login/oauth/access_token') ? new Response('', { status: 502 }) : s.gh.fetch(input, init)) as typeof fetch,
    });
    await conn.start();
    let t = s.timers.shift()!;
    t.fn();
    await conn.idle();
    assert.equal((await conn.status()).state, 'pending');
    assert.equal(s.timers.length, 1);
    fail = false;
    while (s.timers.length) {
      t = s.timers.shift()!;
      t.fn();
      await conn.idle();
    }
    assert.equal((await conn.status()).state, 'connected');
  });

  test('the interval is at least 5 s (minIntervalS lowers it for the demo); slow_down never shortens it', async () => {
    const fast = setup({ auth: { interval: 1 } });
    await fast.conn.start();
    assert.deepEqual(fast.timers.map((x) => x.ms), [5000]);
    const demo = setup({ auth: { interval: 1 }, options: { minIntervalS: 1 } });
    await demo.conn.start();
    assert.deepEqual(demo.timers.map((x) => x.ms), [1000]);
    const s = setup({ auth: { interval: 5 } });
    let first = true;
    const conn = new GithubConnection({
      ...connOptions(s),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (first && String(input).endsWith('/login/oauth/access_token')) {
          first = false;
          return Response.json({ error: 'slow_down', interval: 3 });
        }
        return s.gh.fetch(input, init);
      }) as typeof fetch,
    });
    await conn.start();
    s.timers.shift()!.fn();
    await conn.idle();
    assert.deepEqual(s.timers.map((x) => x.ms), [10_000]);
  });

  test('setSource to the source already chosen and disconnect with no login change no identity', async () => {
    const s = setup();
    await s.conn.setSource('console');
    await s.conn.disconnect();
    assert.equal(s.events.identity, 0);
  });
});

describe('#241 review 2 (Argos)', () => {
  test('H1: disconnect while a first-boot adoption waits on vault.list() stays disconnected', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const vault = new SpyVault({ 'dev-sintetico': TOKEN });
    const list = vault.list.bind(vault);
    vault.list = async () => {
      await gate;
      return list();
    };
    const s = setup({ vault });
    const first = s.conn.status();
    assert.equal((await s.conn.disconnect()).state, 'disconnected');
    release();
    await first;
    await s.conn.idle();
    const st = await s.conn.status();
    assert.equal(st.state, 'disconnected');
    assert.equal(s.settings.get('github.login'), null);
    await assert.rejects(s.conn.token(), GithubNotConnectedError);
  });

  test('reconnecting as the same login keeps its (overwritten) entry', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.token();
    s.auth.token = OTHER_TOKEN;
    await connect(s);
    assert.deepEqual(await s.vault.inner.list(), ['dev-sintetico']);
    assert.equal(await s.vault.inner.get('dev-sintetico'), OTHER_TOKEN);
  });

  test('a failed delete of the previous entry is logged, and the new connection stands', async () => {
    const s = setup({ seed: { 'dev-sintetico': TOKEN } });
    await s.conn.token();
    s.auth.login = 'second-account';
    s.auth.token = OTHER_TOKEN;
    s.vault.fail.add('delete');
    const st = await connect(s);
    assert.deepEqual([st.state, st.login], ['connected', 'second-account']);
    assert.ok(s.logs.some((l) => /previous vault entry could not be deleted/.test(l)));
  });
});

// #372: an app update starts a new core on the same data dir. It reads the vault entry the old core
// wrote; nothing about the update itself drops the connection.
describe('a new core on the same data dir (#372)', () => {
  test('a valid stored credential: the new core is connected without a device flow', async () => {
    const s = setup();
    assert.equal((await connect(s)).state, 'connected');
    s.conn.close();
    const next = new GithubConnection(connOptions(s));
    const st = await next.status();
    assert.deepEqual([st.state, st.login], ['connected', 'dev-sintetico']);
  });

  test('a credential GitHub revoked meanwhile: revoked, with the login to reconnect; reconnecting replaces the entry', async () => {
    const s = setup();
    await connect(s);
    s.conn.close();
    s.auth.token = OTHER_TOKEN; // GitHub revoked the stored token and will issue another one
    const next = new GithubConnection({ ...connOptions(s), log: (line) => void s.logs.push(line) });
    const st = await next.status();
    assert.deepEqual([st.state, st.lastError, st.login, st.securityLogUrl], ['disconnected', 'revoked', 'dev-sintetico', 'https://github.com/settings/security-log']);
    await assert.rejects(next.token(), GithubNotConnectedError);
    assert.equal(s.settings.get('github.login'), 'dev-sintetico', 'the login stays for Reconnect');
    assert.ok(s.logs.some((l) => l === 'github: GitHub rejected the credential (401)'));
    await next.start();
    for (let poll = s.timers.shift(); poll; poll = s.timers.shift()) {
      s.advance(poll.ms);
      poll.fn();
      await next.idle();
    }
    const again = await next.status();
    assert.deepEqual([again.state, again.login, again.lastError], ['connected', 'dev-sintetico', undefined]);
    assert.equal(await s.vault.inner.get('dev-sintetico'), OTHER_TOKEN);
    next.close();
  });
});
