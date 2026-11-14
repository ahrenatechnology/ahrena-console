// #612 the background sync while the credential is revoked: no cycle calls GitHub, a 401 on a sync call
// stops the next ones, the log has one line for the transition, and the sync resumes on reconnect.
// Real connection over the fake GitHub (which refuses any bearer but the issued one), the sync's own steps.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { githubSyncSteps } from '../../src/api/github-screens.ts';
import { GithubBackgroundSync } from '../../src/github/background-sync.ts';
import { GithubHttpError } from '../../src/github/github-source.ts';
import { GithubConnection, MemoryVault } from '../../src/github/connection/index.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEsyncrevoked00000000000000000000';
const NEW_TOKEN = 'gho_FAKEsyncreconnect000000000000000000';
const T0 = Date.parse('2026-11-14T12:00:00Z');

function setup(stored: string) {
  let t = T0;
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const auth = { clientId: 'test-client-id', token: TOKEN, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', interval: 5, requireToken: true };
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { now: () => t, auth });
  const settings = new MemoryInstallationSettings();
  settings.set('github.login', 'dev-sintetico');
  const conn = new GithubConnection({
    vault: new MemoryVault({ 'dev-sintetico': stored }),
    settings,
    clientId: 'test-client-id',
    fetch: gh.fetch,
    oauthUrl: 'http://fake-github.test',
    apiUrl: 'http://fake-api.test',
    env: {},
    ghInstalled: () => false,
    ghToken: () => assert.fail('gh must not run in this test'),
    now: () => t,
    setTimer: (fn) => void timers.push(fn),
    clearTimer: () => undefined,
    log: (line) => void logs.push(line),
  });
  // What the screens' sources do: a data call with the connection's credential, through the watched fetch.
  const watched = conn.watchRejections(gh.fetch);
  const dataCall = async () => {
    const res = await watched('http://fake-api.test/user', { headers: { authorization: `bearer ${await conn.token()}` } });
    if (!res.ok) throw new GithubHttpError(`GitHub respondeu ${res.status}`, res.status);
  };
  const screens = {
    project: { kanban: () => ({ board: async () => (await dataCall(), { stale: false }) }) },
    current: () => ({ decisions: { sync: async () => (await dataCall(), 'done' as const) } }),
  } as unknown as Parameters<typeof githubSyncSteps>[0];
  const sync = new GithubBackgroundSync({ steps: githubSyncSteps(screens, () => conn.connected()), now: () => t, tickMs: 15_000, log: (line) => void logs.push(line) });
  const dataCalls = () => gh.calls.filter((c) => c.startsWith('UNAUTHORIZED') || c === 'GET /user').length;
  return {
    conn,
    gh,
    auth,
    logs,
    sync,
    dataCalls,
    /** One cycle: the clock moves by one tick and the sync looks for due steps. */
    async cycle() {
      t += 15_000;
      await sync.tick();
    },
    async reconnect() {
      await conn.start();
      while (timers.length > 0) {
        t += 5_000;
        timers.shift()!();
        await conn.idle();
      }
    },
  };
}

describe('#612 the background sync while the credential is revoked', () => {
  test('#612/AC-1 with the connection revoked at start, no cycle calls GitHub', async () => {
    const s = setup('gho_FAKEalreadyrevoked000000000000000000');
    await s.conn.status(); // the credential is loaded and refused: revoked
    const before = s.gh.calls.length;
    for (let i = 0; i < 4; i++) await s.cycle();
    assert.equal(s.gh.calls.length, before, 'nothing reached the fake GitHub');
    assert.equal((await s.conn.status()).lastError, 'revoked');
  });

  test('#612/AC-2 #612/AC-4 a 401 in a sync call revokes the connection; the next cycles call nothing and the log has one line', async () => {
    const s = setup(TOKEN);
    await s.conn.status();
    s.auth.token = NEW_TOKEN; // GitHub revokes the credential the core holds
    const logsBefore = s.logs.length;
    await s.cycle(); // project: 401
    const first = s.dataCalls();
    for (let i = 0; i < 4; i++) await s.cycle();
    assert.equal(s.dataCalls(), first, 'no call after the 401');
    const st = await s.conn.status();
    assert.deepEqual([st.state, st.lastError, st.login], ['disconnected', 'revoked', 'dev-sintetico']);
    assert.deepEqual(s.logs.slice(logsBefore), ['github: GitHub rejected the credential (401)']);
  });

  test('#612/AC-3 on reconnect the sync resumes on the next cycle', async () => {
    const s = setup(TOKEN);
    await s.conn.status();
    s.auth.token = NEW_TOKEN;
    await s.cycle();
    await s.cycle();
    const stopped = s.dataCalls();
    await s.reconnect();
    assert.equal((await s.conn.status()).state, 'connected');
    await s.cycle();
    assert.ok(s.dataCalls() > stopped, 'the due steps called GitHub again');
    assert.deepEqual(s.sync.status().steps.map((x) => x.lastOutcome), ['done', 'done']);
  });
});
