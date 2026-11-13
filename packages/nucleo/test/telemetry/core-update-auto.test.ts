// The remote core updates itself (issue 484, decision 0024): the command derived from `connection.credential`
// with the declared `connection.update` first, and the automatic run, once per (machine, target), with the
// attempt kept in `core-update-auto.json`. A FAKE command in place of ssh (test/telemetry/fake-update-ssh.mjs):
// real child processes, no network, nothing on a real machine. Placeholders only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { CoreUpdater, fileAutoAttempts, type AutoAttempts, type MachineUpdate, type UpdateLookup } from '../../src/telemetry/core-update.ts';
import type { ConnectionConfig } from '../../src/telemetry/machines-config.ts';
import { phase, result, Scenario, SCRIPT_TEXT, until, type Step } from './core-update-fixture.ts';

const ID = 'ws-exemplo';
const scenarios: Scenario[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of scenarios.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ahrena-core-update-auto-'));
  dirs.push(d);
  return d;
};

interface SetupOptions {
  connection?: (s: Scenario) => ConnectionConfig | null;
  observed?: string | null;
  appVersion?: string;
  autoAttempts?: AutoAttempts;
  scenario?: Scenario;
}

function setup(over: SetupOptions = {}) {
  const s = over.scenario ?? new Scenario();
  if (!over.scenario) scenarios.push(s);
  let connection: ConnectionConfig | null | undefined = over.connection ? over.connection(s) : s.derivedConnection();
  let fileInvalid = false;
  let observed: string | null = over.observed === undefined ? '0.0.16' : over.observed;
  const events = { updated: [] as string[], logs: [] as string[] };
  const u = new CoreUpdater({
    lookup: async (): Promise<UpdateLookup> => (connection === undefined ? { kind: 'unknown' } : fileInvalid ? { kind: 'invalid-file' } : { kind: 'ok', connection }),
    context: () => ({ connection, fileInvalid }),
    appVersion: over.appVersion ?? '0.0.17',
    telemetryVersion: 1,
    observedVersion: () => observed,
    onUpdated: (id) => void events.updated.push(id),
    script: async () => SCRIPT_TEXT,
    msPerSecond: 20,
    killGraceMs: 100,
    log: (m) => void events.logs.push(m),
    ...(over.autoAttempts ? { autoAttempts: over.autoAttempts } : {}),
  });
  return {
    s,
    u,
    events,
    setConnection: (c: ConnectionConfig | null | undefined) => (connection = c),
    setInvalid: (v: boolean) => (fileInvalid = v),
    setObserved: (v: string | null) => (observed = v),
    view: () => u.status(ID) as MachineUpdate,
  };
}

const CHECK_OK: Step[] = [{ out: phase('check') }, { out: result(0) }];
const UPDATE_OK: Step[] = [{ out: phase('check') }, { out: phase('backup') }, { out: phase('swap') }, { out: phase('start') }, { out: phase('verify') }, { out: result(0, { oldCommit: 'abc1234', newCommit: 'def5678' }) }];
const DERIVED = ['/opt/node/bin/node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-', '--checkout', '/srv/ahrena-console', '--port', '4720'];
const TAIL = ['--ref', 'app-v0.0.17', '--mac-telemetry-version', '1', '--mac-credential-command', 'yes', '--progress', 'json'];
const FORBIDDEN = ['--allow-disconnect', '--force', '--core-options'];

/** One automatic attempt that goes to its end: the check, and the update when the check passes. */
async function auto(t: ReturnType<typeof setup>, runs: number) {
  const r = await t.u.considerAuto(ID);
  assert.equal(r?.kind, 'started');
  await until(() => t.s.runs().length === runs);
  await t.u.settled(ID);
  await t.u.settled(ID);
}

/** A manual check then update through the route path (Tentar de novo). */
async function manual(t: ReturnType<typeof setup>) {
  t.s.set({ steps: UPDATE_OK, exit: 0, check: { steps: CHECK_OK, exit: 0 } });
  assert.equal((await t.u.check(ID)).kind, 'started');
  await t.u.settled(ID);
  assert.equal(t.view().state, 'ready');
  assert.equal((await t.u.update(ID)).kind, 'started');
  await t.u.settled(ID);
}

describe('issue 484 the update command derived from the credential', () => {
  test('#484/AC-8 the argv derived from the credential is the SSH prefix, the stdin script run and the closed tail, value by value, for the check and the update', async () => {
    const t = setup();
    const v = t.view();
    assert.equal(v.source, 'derived');
    assert.equal(v.configured, true);
    assert.equal(v.problem, null);
    assert.equal(v.setup.block, null);
    assert.equal(v.timeoutSeconds, 300);
    t.s.set({ steps: UPDATE_OK, exit: 0, check: { steps: CHECK_OK, exit: 0 } });
    assert.equal((await t.u.check(ID)).kind, 'started');
    await t.u.settled(ID);
    assert.equal((await t.u.update(ID)).kind, 'started');
    await t.u.settled(ID);
    const [c, u] = t.s.runs();
    assert.deepEqual(c!.argv, [...DERIVED, ...TAIL, '--check']);
    assert.deepEqual(u!.argv, [...DERIVED, ...TAIL]);
    assert.equal(c!.script, SCRIPT_TEXT);
    assert.equal(u!.script, SCRIPT_TEXT);
    for (const r of t.s.runs()) for (const bad of FORBIDDEN) assert.equal(r.argv.includes(bad), false, bad);
    assert.equal(t.view().state, 'succeeded');
  });

  test('#484/AC-1 a valid declared connection.update wins over the derived command', async () => {
    const t = setup({ connection: (s) => s.connection({ credential: s.derivableCredential() }) });
    assert.equal(t.view().source, 'declared');
    t.s.set({ steps: CHECK_OK, exit: 0 });
    await t.u.check(ID);
    await t.u.settled(ID);
    assert.deepEqual(t.s.runs()[0]!.argv, ['--checkout', '/srv/ahrena-console', '--port', '4720', ...TAIL, '--check']);
  });

  test('#484/AC-1 an invalid declared connection.update never falls back to the derived one: invalid, nothing runs, no automatic run', async () => {
    const t = setup({ connection: (s) => s.derivedConnection({ updateProblem: 'forbidden-flag' }) });
    const v = t.view();
    assert.equal(v.problem, 'invalid');
    assert.equal(v.configured, false);
    assert.equal(v.source, null);
    assert.match(v.setup.block!, /^"update": \{/);
    assert.equal(await t.u.considerAuto(ID), null);
    assert.deepEqual(await t.u.check(ID), { kind: 'refused', reason: 'invalid' });
    assert.equal(t.s.runs().length, 0);
    assert.equal(t.view().auto, null);
  });

  test('#484/AC-1 a credential that does not have the known shape is missing, with the 0024 text', () => {
    const t = setup({ connection: (s) => s.connection({ update: undefined }) });
    const v = t.view();
    assert.equal(v.problem, 'missing');
    assert.equal(v.source, null);
    assert.equal(v.setup.block, null);
    assert.equal(v.message?.text, 'Não deu para montar o comando de atualização a partir do connection.credential. Declare um connection.update no machines.json.');
  });
});

describe('issue 484 the automatic run, once per machine and target', () => {
  test('#484/AC-2 an older remote gets one check then one update with no route call, and never again for that target', async () => {
    const file = join(tempDir(), 'core-update-auto.json');
    const t = setup({ autoAttempts: fileAutoAttempts(file) });
    assert.equal(t.view().auto, null);
    assert.equal(t.view().automatic, false);
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 100 }, { out: result(0) }], exit: 0, check: { steps: [{ out: phase('check') }, { sleep: 100 }, { out: result(0) }], exit: 0 } });
    const r = await t.u.considerAuto(ID);
    assert.equal(r?.kind, 'started');
    assert.equal(t.view().state, 'checking');
    assert.equal(t.view().automatic, true);
    assert.deepEqual(t.view().auto, { target: '0.0.17', state: 'running' });
    assert.ok(t.events.logs.includes(`update (${ID}): check started automatic`), t.events.logs.join('\n'));
    await until(() => t.s.runs().length === 2);
    await t.u.settled(ID);
    const v = t.view();
    assert.equal(v.state, 'succeeded');
    assert.equal(v.kind, 'update');
    assert.equal(v.automatic, true);
    assert.deepEqual(v.auto, { target: '0.0.17', state: 'succeeded' });
    assert.deepEqual(t.events.updated, [ID]);
    assert.deepEqual(t.s.runs()[0]!.argv, [...DERIVED, ...TAIL, '--check']);
    assert.deepEqual(t.s.runs()[1]!.argv, [...DERIVED, ...TAIL]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { [ID]: '0.0.17' });

    // The remote still answers the old version: no second attempt, from this núcleo or a new one reading the file.
    assert.equal(await t.u.considerAuto(ID), null);
    assert.equal(await t.u.considerAuto(ID), null);
    const again = setup({ scenario: t.s, autoAttempts: fileAutoAttempts(file) });
    assert.equal(await again.u.considerAuto(ID), null);
    assert.deepEqual(again.view().auto, { target: '0.0.17', state: 'failed' }, 'after a restart a spent attempt reads failed, without the job');
    assert.equal(t.s.runs().length, 2);

    // A new target arms it again.
    const next = setup({ scenario: t.s, appVersion: '0.0.18', autoAttempts: fileAutoAttempts(file) });
    assert.equal(next.view().auto, null);
    await auto(next, 4);
    assert.deepEqual(next.view().auto, { target: '0.0.18', state: 'succeeded' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { [ID]: '0.0.18' });
  });

  test('#484/AC-2 it does not fire for an equal, newer, unknown or garbage remote version', async () => {
    for (const observed of ['0.0.17', '0.0.18', '0.1.0', null, 'garbage']) {
      const t = setup({ observed });
      t.s.set({ steps: CHECK_OK, exit: 0 });
      assert.equal(await t.u.considerAuto(ID), null, String(observed));
      assert.equal(t.view().auto, null);
      assert.equal(t.s.runs().length, 0);
    }
  });

  test('#484/AC-2 it does not fire without a credential, with an invalid file, or for a prerelease app', async () => {
    const declaredOnly = setup({ connection: (s) => s.connection({ credential: undefined }) });
    assert.equal(await declaredOnly.u.considerAuto(ID), null);
    const invalid = setup();
    invalid.setInvalid(true);
    assert.equal(await invalid.u.considerAuto(ID), null);
    const prerelease = setup({ appVersion: '0.0.17-dev' });
    assert.equal(await prerelease.u.considerAuto(ID), null);
    const unknown = setup();
    unknown.setConnection(undefined);
    assert.equal(await unknown.u.considerAuto(ID), null);
    for (const t of [declaredOnly, invalid, prerelease, unknown]) assert.equal(t.s.runs().length, 0);
  });

  test('#484/AC-2 it does not fire while a job of the machine runs, and the attempt is not spent', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 200 }, { out: result(0) }], exit: 0 });
    assert.equal((await t.u.check(ID)).kind, 'started');
    assert.equal(await t.u.considerAuto(ID), null);
    await t.u.settled(ID);
    assert.equal(t.s.runs().length, 1);
    assert.equal(t.view().auto, null);
    assert.equal(t.view().automatic, false);
  });

  test('#484/AC-2 two reads at once start one attempt', async () => {
    const t = setup();
    t.s.set({ steps: [], exit: 21 });
    const [a, b] = await Promise.all([t.u.considerAuto(ID), t.u.considerAuto(ID)]);
    assert.equal([a, b].filter((r) => r?.kind === 'started').length, 1);
    await t.u.settled(ID);
    assert.equal(t.s.runs().length, 1);
  });
});

describe('issue 484 no loop: a refused or failed attempt is not repeated by itself', () => {
  test('#484/AC-3 a check that exits 21, 22 or 30 ends the attempt: no update, auto failed, a later read runs nothing', async () => {
    const cases: { exit: number; steps: Step[]; key: string }[] = [
      { exit: 21, steps: [{ out: phase('check') }, { out: result(21) }], key: 'exit-21' },
      { exit: 22, steps: [{ out: phase('check') }, { out: result(22) }], key: 'exit-22' },
      { exit: 30, steps: [{ out: phase('check') }, { out: result(30, { reason: 'dirty-tree' }) }], key: 'exit-30-dirty-tree' },
    ];
    for (const c of cases) {
      const t = setup();
      t.s.set({ steps: c.steps, exit: c.exit });
      await auto(t, 1);
      await new Promise((r) => setTimeout(r, 50));
      const v = t.view();
      assert.equal(t.s.runs().length, 1, String(c.exit));
      assert.equal(v.state, 'refused');
      assert.equal(v.kind, 'check');
      assert.equal(v.automatic, true);
      assert.equal(v.message?.key, c.key);
      assert.deepEqual(v.auto, { target: '0.0.17', state: 'failed' });
      assert.equal(await t.u.considerAuto(ID), null);
      assert.equal(t.s.runs().length, 1);
    }
  });

  test('#484/AC-3 an update that exits 40 after a good automatic check: two runs, auto failed, no second attempt; Tentar de novo still runs', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('backup') }, { out: phase('rollback') }, { out: result(40, { reason: 'started-failed', oldCommit: 'abc1234' }) }], exit: 40, check: { steps: CHECK_OK, exit: 0 } });
    await auto(t, 2);
    const v = t.view();
    assert.equal(v.state, 'rolled-back');
    assert.equal(v.automatic, true);
    assert.deepEqual(v.auto, { target: '0.0.17', state: 'failed' });
    assert.deepEqual(t.events.updated, []);
    assert.equal(await t.u.considerAuto(ID), null);
    assert.equal(t.s.runs().length, 2);

    await manual(t);
    assert.equal(t.s.runs().length, 4);
    assert.equal(t.view().state, 'succeeded');
    assert.equal(t.view().automatic, false);
    assert.deepEqual(t.view().auto, { target: '0.0.17', state: 'failed' }, 'the automatic attempt stays spent');
  });

  test('#484/AC-3 a manual check that exits 22 spends the automatic attempt', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { out: result(22) }], exit: 22 });
    await t.u.check(ID);
    await t.u.settled(ID);
    assert.equal(t.view().automatic, false);
    assert.deepEqual(t.view().auto, { target: '0.0.17', state: 'failed' });
    assert.equal(await t.u.considerAuto(ID), null);
    assert.equal(t.s.runs().length, 1);
  });

  test('#484/AC-3 a manual update spends the automatic attempt when it begins', async () => {
    const t = setup();
    await manual(t);
    assert.deepEqual(t.view().auto, { target: '0.0.17', state: 'failed' });
    assert.equal(await t.u.considerAuto(ID), null);
    assert.equal(t.s.runs().length, 2);
  });

  test('#484/AC-3 a manual check that passes does not spend the attempt', async () => {
    const t = setup();
    t.s.set({ steps: CHECK_OK, exit: 0 });
    await t.u.check(ID);
    await t.u.settled(ID);
    assert.equal(t.view().auto, null);
  });
});

describe('issue 484 the file of spent attempts', () => {
  test('#484/AC-2 round trip: what one store spends, another reading the same file sees', () => {
    const file = join(tempDir(), 'core-update-auto.json');
    const a = fileAutoAttempts(file);
    assert.equal(a.spent(ID), null);
    a.spend(ID, '0.0.17');
    a.spend('ws-outra', '0.0.16');
    assert.equal(a.spent(ID), '0.0.17');
    const b = fileAutoAttempts(file);
    assert.equal(b.spent(ID), '0.0.17');
    assert.equal(b.spent('ws-outra'), '0.0.16');
    b.spend(ID, '0.0.18');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { [ID]: '0.0.18', 'ws-outra': '0.0.16' });
  });

  test('#484/AC-2 an absent file is empty with no log; a malformed one is empty with one log line; bad entries are dropped', () => {
    const dir = tempDir();
    const logs: string[] = [];
    assert.equal(fileAutoAttempts(join(dir, 'absent.json'), (m) => void logs.push(m)).spent(ID), null);
    assert.equal(logs.length, 0);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const b = fileAutoAttempts(bad, (m) => void logs.push(m));
    assert.equal(b.spent(ID), null);
    assert.equal(b.spent(ID), null);
    assert.equal(logs.length, 1);
    const mixed = join(dir, 'mixed.json');
    writeFileSync(mixed, JSON.stringify({ [ID]: '0.0.17', a: 17, b: '0.0.17-dev', c: 'x', d: null }));
    const m = fileAutoAttempts(mixed);
    assert.equal(m.spent(ID), '0.0.17');
    for (const k of ['a', 'b', 'c', 'd']) assert.equal(m.spent(k), null, k);
    writeFileSync(join(dir, 'array.json'), '["0.0.17"]');
    assert.equal(fileAutoAttempts(join(dir, 'array.json')).spent('0'), null);
  });

  test('#484/AC-2 an id like __proto__ is a plain key and pollutes nothing', () => {
    const file = join(tempDir(), 'core-update-auto.json');
    writeFileSync(file, '{"__proto__": "0.0.17", "constructor": "0.0.16"}');
    const a = fileAutoAttempts(file);
    assert.equal(a.spent('__proto__'), '0.0.17');
    assert.equal(a.spent('toString'), null);
    assert.equal(a.spent('hasOwnProperty'), null);
    a.spend('__proto__', '0.0.18');
    assert.equal(a.spent('__proto__'), '0.0.18');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(fileAutoAttempts(file).spent('__proto__'), '0.0.18');
    assert.equal(fileAutoAttempts(file).spent('constructor'), '0.0.16');
  });

  test('#484/AC-2 the file is written with mode 0600; a failed write logs and keeps the value in memory', () => {
    const dir = tempDir();
    const file = join(dir, 'core-update-auto.json');
    fileAutoAttempts(file).spend(ID, '0.0.17');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A plain file where the folder should be: neither read nor write can reach the path.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const logs: string[] = [];
    const nowhere = fileAutoAttempts(join(blocker, 'core-update-auto.json'), (m) => void logs.push(m));
    assert.equal(nowhere.spent(ID), null);
    const afterRead = logs.length;
    nowhere.spend(ID, '0.0.17');
    assert.equal(nowhere.spent(ID), '0.0.17');
    assert.equal(logs.length, afterRead + 1);
  });
});
