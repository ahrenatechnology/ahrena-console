// The --demo connection states (#241): `--demo-github <state>` boots the console's GitHub connection
// in each state the /ui is built against, on the fake GitHub, with an in-memory vault and a fake `gh`.
// Nothing here reaches the real GitHub, the real Keychain or the real `gh`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDemoGithubConnection, DEMO_GITHUB_STATES, DEMO_GITHUB_TOKEN, parseDemoGithubState, type DemoGithubState } from '../../../src/simulator/demo-github-connection.ts';
import { MemoryInstallationSettings } from '../../../src/settings/installation-settings.ts';

/** A manual clock and timer queue: `tick(ms)` runs the timers that came due. */
function manualTime() {
  let now = Date.parse('2026-10-21T12:00:00Z');
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    async tick(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now);
        if (due.length === 0) return;
        timers = timers.filter((t) => t.at > now);
        for (const t of due) t.fn();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

async function boot(state: DemoGithubState) {
  const time = manualTime();
  const changes: string[] = [];
  const settings = new MemoryInstallationSettings();
  const demo = await createDemoGithubConnection(state, { settings, onChange: () => changes.push('connections'), ...time });
  await demo.connection.idle();
  return { ...demo, time, settings, changes };
}

describe('#241 --demo-github states', () => {
  test('the state names are English and parse; anything else is refused', () => {
    assert.deepEqual(
      [...DEMO_GITHUB_STATES],
      ['connected', 'disconnected', 'pending', 'denied', 'expired', 'revoked', 'missing-scopes', 'blocked-orgs', 'no-client-id', 'no-vault', 'gh', 'gh-not-authenticated'],
    );
    assert.equal(parseDemoGithubState(undefined), 'connected');
    assert.equal(parseDemoGithubState('pending'), 'pending');
    assert.throws(() => parseDemoGithubState('conectado'), /--demo-github/);
  });

  test('connected (the default): dev-sintetico with every scope, the revoke link, every org granted', async () => {
    const d = await boot('connected');
    const s = await d.connection.status();
    assert.equal(s.state, 'connected');
    assert.equal(s.login, 'dev-sintetico');
    assert.deepEqual(s.missingScopes, []);
    assert.deepEqual(s.orgs, [{ login: 'exemplo-labs', access: 'granted' }, { login: 'estudio-ficticio', access: 'granted' }]);
    assert.equal(s.orgsChecked, true);
    assert.equal(s.vault, 'memory');
    assert.equal(s.clientId, 'demo-client-id');
    assert.equal(s.revokeUrl, 'https://github.com/settings/connections/applications/demo-client-id');
    assert.equal(await d.connection.token(), DEMO_GITHUB_TOKEN);
    d.connection.close();
  });

  test('disconnected: Connect gives a code, the fake approves after 3 polls at 1 s → connected', async () => {
    const d = await boot('disconnected');
    assert.equal((await d.connection.status()).state, 'disconnected');
    const p = await d.connection.start();
    assert.equal(p.state, 'pending');
    assert.equal(p.interval, 1);
    assert.match(p.userCode!, /^FAKE-/);
    for (let i = 0; i < 4; i++) await d.time.tick(1000);
    await d.connection.idle();
    const s = await d.connection.status();
    assert.equal(s.state, 'connected');
    assert.equal(s.login, 'dev-sintetico');
    d.connection.close();
  });

  test('pending: boots with a code the fake never approves; Cancel → disconnected', async () => {
    const d = await boot('pending');
    for (let i = 0; i < 5; i++) await d.time.tick(1000);
    const s = await d.connection.status();
    assert.equal(s.state, 'pending');
    assert.equal(s.verificationUri, 'https://github.com/login/device');
    assert.ok(!('deviceCode' in s));
    assert.equal((await d.connection.cancel()).state, 'disconnected');
    d.connection.close();
  });

  test('denied: the first poll is refused → disconnected with lastError denied', async () => {
    const d = await boot('denied');
    await d.time.tick(1000);
    await d.connection.idle();
    const s = await d.connection.status();
    assert.deepEqual([s.state, s.lastError], ['disconnected', 'denied']);
    d.connection.close();
  });

  test('expired: the code expires after 5 s → disconnected with lastError expired', async () => {
    const d = await boot('expired');
    assert.equal((await d.connection.status()).state, 'pending');
    for (let i = 0; i < 6; i++) await d.time.tick(1000);
    await d.connection.idle();
    const s = await d.connection.status();
    assert.deepEqual([s.state, s.lastError], ['disconnected', 'expired']);
    d.connection.close();
  });

  test('revoked: the stored credential GitHub refuses → disconnected with lastError revoked and the login; Reconnect → connected', async () => {
    const d = await boot('revoked');
    const s = await d.connection.status();
    assert.deepEqual([s.state, s.lastError, s.login], ['disconnected', 'revoked', 'dev-sintetico']);
    await d.connection.start();
    for (let i = 0; i < 4; i++) await d.time.tick(1000);
    await d.connection.idle();
    const again = await d.connection.status();
    assert.deepEqual([again.state, again.login], ['connected', 'dev-sintetico']);
    d.connection.close();
  });

  test('missing-scopes: connected with repo only → read:org and project are missing', async () => {
    const d = await boot('missing-scopes');
    const s = await d.connection.status();
    assert.equal(s.state, 'connected');
    assert.deepEqual(s.missingScopes, ['read:org', 'project']);
    d.connection.close();
  });

  test('blocked-orgs: estudio-ficticio restricts OAuth Apps', async () => {
    const d = await boot('blocked-orgs');
    const s = await d.connection.status();
    assert.equal(s.state, 'connected');
    assert.deepEqual(s.orgs, [
      {
        login: 'estudio-ficticio',
        access: 'pending',
        approvalUrl: 'https://github.com/organizations/estudio-ficticio/settings/oauth_application_policy',
        requestUrl: 'https://github.com/settings/connections/applications/demo-client-id',
      },
      { login: 'exemplo-labs', access: 'granted' },
    ]);
    d.connection.close();
  });

  test('no-client-id and no-vault: unavailable with the reason', async () => {
    for (const [state, reason] of [
      ['no-client-id', 'no-client-id'],
      ['no-vault', 'no-vault'],
    ] as const) {
      const d = await boot(state);
      const s = await d.connection.status();
      assert.deepEqual([s.state, s.reason], ['unavailable', reason], state);
      d.connection.close();
    }
  });

  test('gh: the gh source (from the settings) with a fake gh credential; gh-not-authenticated: unavailable', async () => {
    const d = await boot('gh');
    const s = await d.connection.status();
    assert.deepEqual([s.state, s.source, s.sourceFrom, s.login], ['connected', 'gh', 'settings', 'dev-sintetico']);
    assert.equal(s.revokeUrl, undefined);
    d.connection.close();
    const n = await boot('gh-not-authenticated');
    const u = await n.connection.status();
    assert.deepEqual([u.state, u.reason], ['unavailable', 'gh-not-authenticated']);
    n.connection.close();
  });

  test('gh is installed in every demo state (the /ui offers it), and the fake gh is the only one', async () => {
    const d = await boot('disconnected');
    assert.equal((await d.connection.status()).ghInstalled, true);
    assert.equal((await d.connection.setSource('gh')).state, 'connected');
    d.connection.close();
  });
});
