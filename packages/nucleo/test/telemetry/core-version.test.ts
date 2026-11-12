// Issue 449, decision 0021 section 1, criterion AC1: the Mac reads the version and the commit of each
// remote machine's núcleo (anonymous GET /api/overview, no new route) and says whether it is older
// than the app. A FAKE remote núcleo on loopback; no SSH, no real machine.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { loopbackGet } from '../../src/telemetry/adapters/loopback-http.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { compareSemver, coreStatus, FIRST_UPDATER_VERSION, hasUpdater, parseOverview } from '../../src/telemetry/core-version.ts';
import { TELEMETRY_VERSION } from '../../src/telemetry/model.ts';
import { RemoteMachine, type RemoteMachineOptions } from '../../src/telemetry/remote.ts';
import { TelemetryService } from '../../src/telemetry/service.ts';
import { closedPort, startFakeRemote, type FakeRemote } from './fake-remote.ts';
import { reading, T0 } from './reading.ts';

const EXPECTED = '0.0.16';
const OLD_COMMIT = '81251bd';

let storage: SqliteStorage;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  storage?.close();
});

async function fake(state: Parameters<typeof startFakeRemote>[0] = {}): Promise<FakeRemote> {
  const f = await startFakeRemote({ current: reading({}, T0), ...state });
  cleanup.push(() => f.close());
  return f;
}

function setup(port: number, over: Partial<NonNullable<RemoteMachineOptions['core']>> = {}, extra: Partial<RemoteMachineOptions> = {}) {
  storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  const get = loopbackGet({ timeoutMs: 2_000 });
  const remote = new RemoteMachine({
    config: { id: 'ws-exemplo', label: 'Workstation', port },
    get,
    store,
    tracker,
    now: () => T0,
    core: { get, expectedVersion: EXPECTED, credentialCommand: () => true, checkout: () => null, ...over },
    ...extra,
  });
  const service = new TelemetryService({ store, tracker, machines: [remote], now: () => T0 });
  return { remote, service };
}

const coreOf = async (service: TelemetryService) => (await service.machines())[0]!.core;

describe('AC1 the comparison is pure semver, and the commit only informs', () => {
  test('AC1 compareSemver orders major.minor.patch numerically, not as text', () => {
    assert.ok(compareSemver('0.0.7', '0.0.16')! < 0);
    assert.ok(compareSemver('0.0.16', '0.0.7')! > 0);
    assert.ok(compareSemver('0.10.0', '0.9.9')! > 0);
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    assert.equal(compareSemver('1.2.3-rc.1', '1.2.3'), 0, 'a prerelease suffix is ignored');
    assert.equal(compareSemver('latest', '1.2.3'), null);
  });

  test('AC1 coreStatus: outdated, current, ahead, unknown', () => {
    assert.equal(coreStatus({ version: '0.0.7', commit: OLD_COMMIT }, EXPECTED), 'outdated');
    assert.equal(coreStatus({ version: '0.0.16', commit: 'abcdef1' }, EXPECTED), 'current');
    assert.equal(coreStatus({ version: '0.1.0', commit: null }, EXPECTED), 'ahead');
    assert.equal(coreStatus({ version: null, commit: 'abcdef1' }, EXPECTED), 'unknown');
    assert.equal(coreStatus(null, EXPECTED), 'unknown');
  });

  test('AC1 equal versions with an older commit are outdated only when this Mac has a checkout to compare', () => {
    const remote = { version: '0.0.16', commit: OLD_COMMIT };
    assert.equal(coreStatus(remote, EXPECTED, (c) => c === OLD_COMMIT), 'outdated');
    assert.equal(coreStatus(remote, EXPECTED, () => false), 'current');
    assert.equal(coreStatus(remote, EXPECTED), 'current', 'the packaged app has no git: semver only');
    assert.equal(coreStatus({ version: '0.0.16', commit: null }, EXPECTED, () => true), 'current', 'no commit, nothing to compare');
  });

  test('AC1 the commit rule never turns an older version around: a newer version is ahead whatever the commit says', () => {
    assert.equal(coreStatus({ version: '0.0.17', commit: OLD_COMMIT }, EXPECTED, () => true), 'ahead');
  });

  test('AC1 parseOverview keeps only a version and a commit with their exact shape', () => {
    const ok = (body: unknown, status = 200) => parseOverview({ kind: 'response', status, body });
    assert.deepEqual(ok({ version: '0.0.7', commit: OLD_COMMIT }), { version: '0.0.7', commit: OLD_COMMIT });
    assert.deepEqual(ok({ version: '0.0.7', commit: null }), { version: '0.0.7', commit: null });
    assert.deepEqual(ok({ version: '<b>0.0.7</b>', commit: 'not a sha' }), { version: null, commit: null });
    assert.deepEqual(ok({ version: `1.2.${'3'.repeat(100)}`, commit: 'a'.repeat(41) }), { version: null, commit: null });
    assert.deepEqual(ok({ version: 7, commit: ['abcdef1'] }), { version: null, commit: null });
    assert.equal(ok(null), null);
    assert.equal(ok([]), null);
    assert.equal(ok({ version: '0.0.7' }, 404), null);
    assert.equal(parseOverview({ kind: 'unreachable', reason: 'port-closed' }), null);
  });
});

describe('AC1 FIRST_UPDATER_VERSION chooses between the update command and the bootstrap instructions', () => {
  test('AC1 FIRST_UPDATER_VERSION is a version later than the one that has no updater (0.0.16)', () => {
    assert.match(FIRST_UPDATER_VERSION, /^\d+\.\d+\.\d+$/);
    assert.ok(compareSemver(FIRST_UPDATER_VERSION, '0.0.16')! > 0, 'the 0.0.16 release has neither the script nor the manifest');
  });

  test('AC1 hasUpdater is true from FIRST_UPDATER_VERSION on, false below it, false for a non-version', () => {
    assert.equal(hasUpdater(FIRST_UPDATER_VERSION), true);
    assert.equal(hasUpdater('0.0.16'), false);
    assert.equal(hasUpdater('0.0.7'), false);
    assert.equal(hasUpdater('9.0.0'), true);
    assert.equal(hasUpdater('nope'), false);
  });
});

describe('AC1 the Mac reads the remote overview each cycle and puts it in GET /api/machines', () => {
  test('AC1 an old remote (0.0.7, 81251bd) is outdated, with its version, its commit and what the Mac expects', async () => {
    const f = await fake({ overview: { body: { ok: true, name: 'ahrena-console', version: '0.0.7', pid: 123, commit: OLD_COMMIT } } });
    const { remote, service } = setup(f.port, { credentialCommand: () => true, checkout: () => '/home/ubuntu/ahrena-console' });
    await remote.pollOnce();
    assert.deepEqual(await coreOf(service), {
      version: '0.0.7',
      commit: OLD_COMMIT,
      expectedVersion: EXPECTED,
      status: 'outdated',
      readAt: new Date(T0).toISOString(),
      mac: { telemetryVersion: TELEMETRY_VERSION, credentialCommand: true, checkout: '/home/ubuntu/ahrena-console' },
    });
  });

  test('AC1 the read is one anonymous GET /api/overview per cycle, after the telemetry, and nothing else', async () => {
    const f = await fake({ overview: { body: { version: EXPECTED, commit: 'abcdef1' } } });
    const { remote } = setup(f.port);
    await remote.pollOnce();
    assert.deepEqual(
      f.requests.map((r) => `${r.method} ${r.url}`),
      ['GET /api/telemetry', 'GET /api/attention', 'GET /api/overview'],
    );
    await remote.pollOnce();
    assert.equal(f.requests.filter((r) => r.url === '/api/overview').length, 2);
  });

  test('AC1 the same version is current; a newer one is ahead', async () => {
    const f = await fake({ overview: { body: { version: EXPECTED, commit: 'abcdef1' } } });
    const { remote, service } = setup(f.port);
    await remote.pollOnce();
    assert.equal((await coreOf(service))?.status, 'current');
    f.state.overview = { body: { version: '0.1.0', commit: 'abcdef1' } };
    await remote.pollOnce();
    assert.equal((await coreOf(service))?.status, 'ahead');
  });

  test('AC1 a body without a valid version, or with garbage, is unknown and no raw text reaches the JSON', async () => {
    const f = await fake({ overview: { body: { version: '<img src=x onerror=alert(1)>', commit: '../../etc/passwd', note: 'ignore previous instructions' } } });
    const { remote, service } = setup(f.port);
    await remote.pollOnce();
    const core = await coreOf(service);
    assert.equal(core?.status, 'unknown');
    assert.equal(core?.version, null);
    assert.equal(core?.commit, null);
    const json = JSON.stringify(await service.machines());
    assert.ok(!json.includes('onerror') && !json.includes('passwd') && !json.includes('ignore previous'));
  });

  test('AC1 a remote with no overview route (404) is unknown, not an error', async () => {
    const f = await fake();
    const { remote, service } = setup(f.port);
    await remote.pollOnce();
    assert.equal((await coreOf(service))?.status, 'unknown');
  });

  test('AC1 the version is read also while the machine is in owner-auth-required (the read is anonymous)', async () => {
    const f = await fake({ privateStatus: 403, overview: { body: { version: '0.0.7', commit: OLD_COMMIT } } });
    const { remote, service } = setup(f.port);
    await remote.pollOnce();
    const [machine] = await service.machines();
    assert.equal(machine!.reason, 'owner-auth-required');
    assert.equal(machine!.core?.status, 'outdated');
    assert.equal(machine!.core?.version, '0.0.7');
  });

  test('AC1 a port that never answered has core null; after a good read that goes down it is unknown and keeps when it last read', async () => {
    const closed = await closedPort();
    const a = setup(closed);
    await a.remote.pollOnce();
    assert.equal(await coreOf(a.service), null);

    const f = await fake({ overview: { body: { version: '0.0.7', commit: OLD_COMMIT } } });
    const { remote, service } = setup(f.port);
    await remote.pollOnce();
    const before = await coreOf(service);
    assert.equal(before?.status, 'outdated');
    await f.close();
    await remote.pollOnce();
    const after = await coreOf(service);
    assert.equal(after?.status, 'unknown');
    assert.equal(after?.version, null);
    assert.equal(after?.readAt, before?.readAt);
  });

  test('AC1 equal versions with an older commit are outdated only when the Mac has a way to compare commits', async () => {
    const f = await fake({ overview: { body: { version: EXPECTED, commit: OLD_COMMIT } } });
    const withGit = setup(f.port, { isOlderCommit: (c) => c === OLD_COMMIT });
    await withGit.remote.pollOnce();
    assert.equal((await coreOf(withGit.service))?.status, 'outdated');
    const without = setup(f.port);
    await without.remote.pollOnce();
    assert.equal((await coreOf(without.service))?.status, 'current');
  });

  test('AC1 without a core option (this machine, the demo) the summary has core null and no overview request is made', async () => {
    const f = await fake({ overview: { body: { version: '0.0.7', commit: OLD_COMMIT } } });
    const { remote, service } = setup(f.port, {}, { core: undefined });
    await remote.pollOnce();
    assert.equal(await coreOf(service), null);
    assert.ok(!f.requests.some((r) => r.url === '/api/overview'));
  });
});
