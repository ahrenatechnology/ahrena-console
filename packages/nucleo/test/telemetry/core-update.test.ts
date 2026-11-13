// The Update button's job (issue 462, decision 0022 sections 1, 3, 4, 5 and 6; test plan AC1, AC3 to AC6 and
// Cancel), with a FAKE command in place of ssh (test/telemetry/fake-update-ssh.mjs): real child processes, no
// network, nothing on a real machine. Placeholders only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test } from 'node:test';
import { CoreUpdater, type MachineUpdate, type UpdateLookup } from '../../src/telemetry/core-update.ts';
import type { ConnectionConfig } from '../../src/telemetry/machines-config.ts';
import { phase, result, Scenario, SCRIPT_TEXT, until } from './core-update-fixture.ts';

const scenarios: Scenario[] = [];
afterEach(() => {
  for (const s of scenarios.splice(0)) s.close();
});

function setup(over: { connection?: (s: Scenario) => ConnectionConfig | null; observed?: () => string | null; script?: () => Promise<string> } = {}) {
  const s = new Scenario();
  scenarios.push(s);
  let connection: ConnectionConfig | null | undefined = over.connection ? over.connection(s) : s.connection();
  let fileInvalid = false;
  let skew = 0;
  const events = { updated: [] as string[], changes: 0 };
  let observed: string | null = over.observed ? over.observed() : '0.0.16';
  const u = new CoreUpdater({
    lookup: async (): Promise<UpdateLookup> => (connection === undefined ? { kind: 'unknown' } : fileInvalid ? { kind: 'invalid-file' } : { kind: 'ok', connection }),
    context: () => ({ connection, fileInvalid }),
    appVersion: '0.0.17',
    telemetryVersion: 1,
    observedVersion: () => observed,
    onUpdated: (id) => void events.updated.push(id),
    onChange: () => void (events.changes += 1),
    script: over.script ?? (async () => SCRIPT_TEXT),
    msPerSecond: 20,
    killGraceMs: 100,
    now: () => Date.now() + skew,
  });
  return {
    s,
    u,
    events,
    setConnection: (c: ConnectionConfig | null | undefined) => (connection = c),
    setInvalid: (v: boolean) => (fileInvalid = v),
    setObserved: (v: string | null) => (observed = v),
    skew: (ms: number) => (skew += ms),
    view: () => u.status('ws-exemplo') as MachineUpdate,
  };
}

const CHECK_OK = [{ out: phase('check') }, { out: result(0) }];
const UPDATE_OK = [{ out: phase('check') }, { out: phase('backup') }, { out: phase('swap') }, { out: phase('start') }, { out: phase('verify') }, { out: result(0, { oldCommit: 'abc1234', newCommit: 'def5678' }) }];

async function check(t: ReturnType<typeof setup>, over: Parameters<Scenario['set']>[0] = { steps: CHECK_OK, exit: 0 }) {
  t.s.set(over);
  const r = await t.u.check('ws-exemplo');
  assert.equal(r.kind, 'started');
  await t.u.settled('ws-exemplo');
}

describe('issue 462 the Update button job', () => {
  test('the argv is exactly the declared command plus the closed tail, the script goes on stdin, and --allow-disconnect never appears', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: UPDATE_OK, exit: 0 });
    assert.equal((await t.u.update('ws-exemplo')).kind, 'started');
    await t.u.settled('ws-exemplo');
    const [c, u] = t.s.runs();
    const declared = ['--checkout', '/srv/ahrena-console', '--port', '4720'];
    assert.deepEqual(c!.argv, [...declared, '--ref', 'app-v0.0.17', '--mac-telemetry-version', '1', '--mac-credential-command', 'yes', '--progress', 'json', '--check']);
    assert.deepEqual(u!.argv, [...declared, '--ref', 'app-v0.0.17', '--mac-telemetry-version', '1', '--mac-credential-command', 'yes', '--progress', 'json']);
    assert.equal(c!.script, SCRIPT_TEXT);
    assert.equal(u!.script, SCRIPT_TEXT);
    for (const r of t.s.runs()) for (const bad of ['--allow-disconnect', '--force', '--core-options']) assert.equal(r.argv.includes(bad), false);
  });

  test('a machine without a credential command declares "no" to the script', async () => {
    const t = setup({ connection: (s) => s.connection({ credential: undefined as never }) });
    await check(t);
    assert.equal(t.s.runs()[0]!.argv.at(-4), 'no');
  });

  test('idle -> checking -> ready; the update then runs the phases in order and ends succeeded, dropping the credential through onUpdated', async () => {
    const t = setup();
    assert.equal(t.view().state, 'idle');
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 150 }, { out: result(0) }], exit: 0 });
    const started = await t.u.check('ws-exemplo');
    assert.equal(started.kind, 'started');
    assert.equal(t.view().state, 'checking');
    assert.equal(t.view().canCancel, true);
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'ready');
    assert.equal(t.view().message?.key, 'check-ready');
    assert.ok(t.view().readyUntil);

    const phases: (string | null)[] = [];
    const seen = new CoreUpdaterPhaseWatch(t, phases);
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 60 }, { out: phase('backup') }, { sleep: 60 }, { out: phase('swap') }, { sleep: 60 }, { out: phase('start') }, { sleep: 60 }, { out: phase('verify') }, { sleep: 60 }, { out: result(0, { oldCommit: 'abc1234', newCommit: 'def5678' }) }], exit: 0 });
    assert.equal((await t.u.update('ws-exemplo')).kind, 'started');
    assert.equal(t.view().state, 'running');
    await t.u.settled('ws-exemplo');
    seen.stop();
    assert.deepEqual(phases.filter((p, i) => p !== phases[i - 1] && p !== null), ['check', 'backup', 'swap', 'start', 'verify']);
    const v = t.view();
    assert.equal(v.state, 'succeeded');
    assert.equal(v.exitCode, 0);
    assert.equal(v.oldCommit, 'abc1234');
    assert.equal(v.newCommit, 'def5678');
    assert.equal(v.backupPath, null);
    assert.deepEqual(t.events.updated, ['ws-exemplo']);
  });

  test('POST update without a good check -> check-required; one check pays for one update; a stale or other-command check does not count', async () => {
    const t = setup();
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
    await check(t);
    t.s.set({ steps: UPDATE_OK, exit: 0 });
    t.skew(5 * 60_000 + 1000);
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
    assert.equal(t.view().state, 'idle', 'an expired check is no longer ready');
    t.skew(-(5 * 60_000 + 1000));
    t.s.set({ steps: CHECK_OK, exit: 0 });
    await t.u.check('ws-exemplo');
    await t.u.settled('ws-exemplo');
    // The file changed the command after the check.
    t.setConnection(t.s.connection({ update: { command: [process.execPath, 'x', t.s.file], timeoutSeconds: 60 } }));
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
    t.setConnection(t.s.connection());
    t.s.set({ steps: UPDATE_OK, exit: 0 });
    assert.equal((await t.u.update('ws-exemplo')).kind, 'started');
    await t.u.settled('ws-exemplo');
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' }, 'the check was spent');
  });

  test('two clicks at once run one ssh, also an update beside a running check', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 200 }, { out: result(0) }], exit: 0 });
    const [a, b] = await Promise.all([t.u.check('ws-exemplo'), t.u.check('ws-exemplo')]);
    assert.equal(a.kind, 'started');
    assert.equal(b.kind, 'already-running');
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
    await t.u.settled('ws-exemplo');
    assert.equal(t.s.runs().length, 1);
    t.s.set({ steps: [{ out: phase('check') }, { out: phase('backup') }, { sleep: 200 }, { out: result(0) }], exit: 0 });
    const [c, d] = await Promise.all([t.u.update('ws-exemplo'), t.u.update('ws-exemplo')]);
    assert.equal(c.kind, 'started');
    assert.equal(d.kind, 'already-running');
    assert.equal((await t.u.check('ws-exemplo')).kind, 'already-running', 'a check never starts beside a running update');
    await t.u.settled('ws-exemplo');
    assert.equal(t.s.runs().length, 2);
  });

  test('a refused check (20 to 23, 33) leaves state refused with the right text, no update, and nothing but the check ran', async () => {
    for (const code of [20, 21, 22, 23, 33]) {
      const t = setup();
      await check(t, { steps: [{ out: phase('check') }, { out: result(code) }], exit: code });
      const v = t.view();
      assert.equal(v.state, 'refused', String(code));
      assert.equal(v.exitCode, code);
      assert.equal(v.message?.key, `exit-${code}`);
      assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
      assert.equal(t.s.runs().length, 1);
    }
  });

  test('every exit maps to its state, reason and text; a 41 carries the backup path; the reason must fit the code', async () => {
    const cases: { exit: number; steps: { out: string }[]; state: string; key: string; reason?: string | null; backup?: string | null }[] = [
      { exit: 30, steps: [{ out: result(30, { reason: 'dirty-tree' }) }], state: 'refused', key: 'exit-30-dirty-tree', reason: 'dirty-tree' },
      { exit: 30, steps: [{ out: result(30, { reason: 'unknown-ref' }) }], state: 'refused', key: 'exit-30-unknown-ref', reason: 'unknown-ref' },
      { exit: 30, steps: [{ out: result(30, { reason: 'new-dependencies' }) }], state: 'refused', key: 'exit-30-new-dependencies', reason: 'new-dependencies' },
      { exit: 30, steps: [{ out: result(30, { reason: 'not-a-checkout' }) }], state: 'refused', key: 'exit-30-not-a-checkout', reason: 'not-a-checkout' },
      { exit: 30, steps: [{ out: result(30, { reason: 'process-mismatch' }) }], state: 'refused', key: 'exit-30', reason: null },
      { exit: 31, steps: [{ out: result(31) }], state: 'refused', key: 'exit-31' },
      { exit: 32, steps: [{ out: result(32, { reason: 'data-dir-mismatch' }) }], state: 'refused', key: 'exit-32-data-dir-mismatch', reason: 'data-dir-mismatch' },
      { exit: 32, steps: [{ out: result(32) }], state: 'refused', key: 'exit-32', reason: null },
      { exit: 40, steps: [{ out: phase('rollback') }, { out: result(40, { reason: 'started-failed', backup: '/srv/backups/update-1', oldCommit: 'abc1234', newCommit: 'def5678' }) }], state: 'rolled-back', key: 'exit-40', reason: 'started-failed', backup: '/srv/backups/update-1' },
      { exit: 41, steps: [{ out: phase('rollback') }, { out: result(41, { reason: 'started-failed', backup: '/srv/backups/update-2', oldCommit: 'abc1234' }) }], state: 'rollback-failed', key: 'exit-41', reason: 'started-failed', backup: '/srv/backups/update-2' },
      { exit: 130, steps: [{ out: result(130) }], state: 'canceled', key: 'canceled' },
      { exit: 255, steps: [], state: 'failed', key: 'ssh-unreachable' },
      { exit: 255, steps: [{ out: phase('backup') }, { out: phase('swap') }], state: 'timed-out', key: 'timeout-after-swap' },
      { exit: 127, steps: [], state: 'failed', key: 'node-not-found' },
      { exit: 2, steps: [{ out: result(2) }], state: 'failed', key: 'unknown-exit' },
    ];
    for (const c of cases) {
      const t = setup();
      await check(t);
      // The update run: a scenario of its own.
      t.s.set({ steps: c.steps, exit: c.exit });
      assert.equal((await t.u.update('ws-exemplo')).kind, 'started');
      await t.u.settled('ws-exemplo');
      const v = t.view();
      const label = `${c.exit} ${c.key}`;
      assert.equal(v.state, c.state, label);
      assert.equal(v.message?.key, c.key, label);
      assert.equal(v.exitCode, c.exit, label);
      assert.equal(v.reason, c.reason ?? null, label);
      assert.equal(v.backupPath, c.backup ?? null, label);
      assert.deepEqual(t.events.updated, [], label);
    }
  });

  test('the 41 text names the backup and the old commit; the 40 text keeps "se estava no ar antes"', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: result(41, { reason: 'started-failed', backup: '/srv/backups/update-2', oldCommit: 'abc1234' }) }], exit: 41 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    const text = t.view().message!.text;
    assert.match(text, /O backup está em \/srv\/backups\/update-2 e o commit anterior era abc1234\./);
    const t2 = setup();
    await check(t2);
    t2.s.set({ steps: [{ out: result(40, { oldCommit: 'abc1234' }) }], exit: 40 });
    await t2.u.update('ws-exemplo');
    await t2.u.settled('ws-exemplo');
    assert.match(t2.view().message!.text, /\(abc1234\)/);
    assert.match(t2.view().message!.text, /se estava no ar antes\.$/);
  });

  test('garbage and out-of-schema lines are ignored; the decision is the exit code, not the events; a result that disagrees is not trusted', async () => {
    const t = setup();
    await check(t);
    t.s.set({
      steps: [
        { out: 'not json\n' },
        { out: '{"v":2,"event":"phase","phase":"swap"}\n' },
        { out: '{"v":1,"event":"phase","phase":"nope"}\n' },
        { out: '{"v":1,"event":"phase","phase":"check","extra":1}\n' },
        { out: phase('check') },
        { out: result(0, { backup: 'relative/path' }) },
        { out: result(31, { backup: '/srv/b' }) },
      ],
      exit: 33,
    });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    const v = t.view();
    assert.equal(v.exitCode, 33);
    assert.equal(v.state, 'refused');
    assert.equal(v.phase, 'check');
    assert.equal(v.backupPath, null);
    assert.equal(v.message?.key, 'exit-33');
  });

  test('a phase never moves back: a stray "check" after "swap" does not make the update cancelable', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: phase('swap') }, { out: phase('check') }, { sleep: 400 }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await until(() => t.view().phase === 'swap');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(t.view().phase, 'swap');
    assert.equal(t.view().canCancel, false);
    await t.u.settled('ws-exemplo');
  });

  test('more than 64 KiB of stdout before the swap ends the process group and fails; the check is still an honest "nothing changed"', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: phase('check') }, { big: 70 * 1024 }, { sleep: 5_000 }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    const v = t.view();
    assert.equal(v.state, 'failed');
    assert.equal(v.message?.key, 'output-too-large');
  });

  test('more than 64 KiB after the backup is only drained: ssh is left alone and the exit code decides', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: phase('backup') }, { out: phase('swap') }, { big: 70 * 1024 }, { sleep: 250 }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'succeeded');
  });

  test('a command that cannot start fails with spawn-failed and never reaches the script', async () => {
    const t = setup({ connection: (s) => s.connection({ update: { command: ['/nonexistent/ssh-binary'], timeoutSeconds: 60 } }) });
    t.s.set({ steps: CHECK_OK, exit: 0 });
    await t.u.check('ws-exemplo');
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'failed');
    assert.equal(t.view().message?.key, 'spawn-failed');
  });

  test('without the packaged script the run fails with script-unavailable and nothing is spawned', async () => {
    const t = setup({ script: async () => Promise.reject(new Error('gone')) });
    t.s.set({ steps: CHECK_OK, exit: 0 });
    const r = await t.u.check('ws-exemplo');
    assert.equal(r.kind, 'started');
    assert.equal(t.view().state, 'failed');
    assert.equal(t.view().message?.key, 'script-unavailable');
    assert.equal(t.s.runs().length, 0);
  });

  test('unknown id, invalid file, no update, invalid update: nothing runs', async () => {
    const t = setup();
    t.setConnection(undefined);
    assert.deepEqual(await t.u.check('ws-exemplo'), { kind: 'unknown' });
    assert.equal(t.u.status('ws-exemplo'), null);
    t.setConnection(t.s.connection());
    t.setInvalid(true);
    assert.deepEqual(await t.u.check('ws-exemplo'), { kind: 'refused', reason: 'invalid-file' });
    assert.equal(t.view().problem, 'invalid-file');
    t.setInvalid(false);
    t.setConnection(t.s.connection({ update: undefined as never }));
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'not-configured' });
    assert.equal(t.view().problem, 'missing');
    t.setConnection(t.s.connection({ update: undefined as never, credential: undefined as never }));
    assert.equal(t.view().problem, 'credential-missing');
    t.setConnection(t.s.connection({ update: undefined as never, updateProblem: 'forbidden-flag' }));
    assert.deepEqual(await t.u.check('ws-exemplo'), { kind: 'refused', reason: 'invalid' });
    assert.equal(t.view().problem, 'invalid');
    assert.equal(t.view().invalidReason, 'forbidden-flag');
    assert.match(t.view().message!.text, /^O connection\.update do machines\.json está inválido \(o botão não aceita --allow-disconnect/);
    assert.equal(t.s.runs().length, 0);
  });

  test('a prerelease app version has no tag to install: invalid-version, nothing runs', async () => {
    const t = setup();
    const u = new CoreUpdater({ lookup: async () => ({ kind: 'ok', connection: t.s.connection() }), context: () => ({ connection: t.s.connection(), fileInvalid: false }), appVersion: '0.0.17-dev', telemetryVersion: 1 });
    assert.deepEqual(await u.check('ws-exemplo'), { kind: 'refused', reason: 'invalid-version' });
    assert.equal(t.s.runs().length, 0);
  });

  test('#484/AC-1 only the credential declared: the command is derived, with no setup block; a declared update is the declared source', () => {
    const t = setup({
      connection: (s) =>
        s.connection({
          update: undefined as never,
          credential: { command: ['/usr/bin/ssh', '-T', 'ahrena-tunnel', '/opt/node/bin/node', '/srv/ahrena-console/packages/nucleo/src/owner/cli.ts', 'remote-credential', '--port', '4720'], timeoutSeconds: 20 },
        }),
    });
    const v = t.view();
    assert.equal(v.problem, null);
    assert.equal(v.configured, true);
    assert.equal(v.source, 'derived');
    assert.equal(v.setup.block, null);
    assert.deepEqual(v.command, ['/usr/bin/ssh', '-T', 'ahrena-tunnel', '/opt/node/bin/node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-', '--checkout', '/srv/ahrena-console', '--port', '4720']);
    t.setConnection(t.s.connection());
    assert.equal(t.view().source, 'declared');
    assert.equal(t.view().setup.block, null);
  });
});

describe('issue 462 Cancel, timeout, and what happens after the swap', () => {
  test('Cancel in the check phase ends the group and the state is canceled; the process is gone', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 30_000 }], exit: 0 });
    await t.u.check('ws-exemplo');
    await until(() => t.s.runs().length === 1);
    const r = await t.u.cancel('ws-exemplo');
    assert.equal(r.kind, 'canceled');
    assert.equal(t.view().state, 'canceled');
    assert.equal(t.view().canCancel, false);
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().message?.key, 'canceled');
    assert.equal(t.view().message?.text, 'Cancelado. Nada foi alterado.');
    assert.deepEqual(await t.u.cancel('ws-exemplo'), { kind: 'refused', reason: 'not-running' });
  });

  test('Cancel from the backup on is refused (not-cancelable) and the ssh is not killed', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: phase('backup') }, { sleep: 400 }, { out: phase('swap') }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await until(() => t.view().phase === 'backup');
    assert.equal(t.view().canCancel, false);
    assert.deepEqual(await t.u.cancel('ws-exemplo'), { kind: 'refused', reason: 'not-cancelable' });
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'succeeded', 'the run went to its end');
  });

  test('Cancel of an unknown machine is unknown', async () => {
    const t = setup();
    t.setConnection(undefined);
    assert.deepEqual(await t.u.cancel('ws-exemplo'), { kind: 'unknown' });
  });

  test('a timeout in the check phase ends the group: timed-out, "nothing was changed"', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 30_000 }], exit: 0 });
    await t.u.check('ws-exemplo');
    await until(() => t.view().state === 'timed-out');
    await t.u.settled('ws-exemplo');
    const v = t.view();
    assert.equal(v.message?.key, 'timeout-before-swap');
    assert.equal(v.message?.text, 'A Workstation não respondeu em 30 s. Cancelei antes de trocar qualquer coisa.');
  });

  test('a timeout after the swap does NOT kill ssh: timed-out for now, and the real exit code still decides when it arrives', async () => {
    const t = setup();
    await check(t);
    // Timeout 60 s x 20 ms = 1.2 s.
    t.s.set({ steps: [{ out: phase('backup') }, { out: phase('swap') }, { sleep: 1_700 }, { out: phase('verify') }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await until(() => t.view().state === 'timed-out');
    const pid = await (async () => {
      await until(() => t.s.runs().length === 2);
      return t.s.runs()[1]!.pid;
    })();
    assert.equal(t.view().message?.key, 'timeout-after-swap');
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotThrow(() => process.kill(pid, 0), 'ssh is still alive past the timeout');
    assert.equal(t.u.updating('ws-exemplo'), true, 'still "atualizando"');
    assert.equal(t.view().canCancel, false);
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'succeeded');
    assert.deepEqual(t.events.updated, ['ws-exemplo']);
  });
});

describe('issue 462 review round 1', () => {
  test('Cancel never applies to an update, even in its own check phase', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 400 }, { out: result(0) }], exit: 0 });
    await t.u.update('ws-exemplo');
    await until(() => t.view().phase === 'check');
    assert.equal(t.view().canCancel, false);
    assert.deepEqual(await t.u.cancel('ws-exemplo'), { kind: 'refused', reason: 'not-cancelable' });
    await t.u.settled('ws-exemplo');
    assert.equal(t.view().state, 'succeeded');
  });

  test('a canceled check that still exits 0 is classified by the code', async () => {
    const t = setup();
    t.s.set({ steps: [{ out: phase('check') }, { sleep: 100 }], exit: 0 });
    await t.u.check('ws-exemplo');
    await until(() => t.s.runs().length === 1);
    await t.u.cancel('ws-exemplo');
    await t.u.settled('ws-exemplo');
    assert.ok(['canceled', 'ready'].includes(t.view().state));
  });

  test('a check made with the credential command does not pay for an update without it', async () => {
    const t = setup();
    await check(t);
    t.setConnection(t.s.connection({ credential: undefined as never }));
    assert.deepEqual(await t.u.update('ws-exemplo'), { kind: 'refused', reason: 'check-required' });
    assert.equal(t.view().state, 'idle');
  });
});

describe('issue 462 after exit 0: the credential goes, the machine is read, the banner clears by itself', () => {
  test('confirming while the remote still answers the old version, confirmed once it answers the target', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: UPDATE_OK, exit: 0 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    assert.deepEqual(t.events.updated, ['ws-exemplo']);
    let v = t.view();
    assert.equal(v.state, 'succeeded');
    assert.equal(v.confirmation, 'confirming');
    assert.equal(v.message?.key, 'confirming');
    t.setObserved('0.0.17');
    v = t.view();
    assert.equal(v.confirmation, 'confirmed');
    assert.equal(v.message?.text, 'O núcleo da Workstation foi atualizado para a 0.0.17 e respondeu. A conexão voltou.');
  });

  test('after 2 minutes with the old version the screen says what the remote answered against what was expected', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: UPDATE_OK, exit: 0 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    t.skew(2 * 60_000 + 1000);
    const v = t.view();
    assert.equal(v.confirmation, 'diverged');
    assert.equal(v.message?.text, 'O núcleo respondeu a versão 0.0.16; esperava a 0.0.17. Confira a Workstation pelo terminal, com o comando para copiar.');
  });

  test('a failed update does not drop the credential', async () => {
    const t = setup();
    await check(t);
    t.s.set({ steps: [{ out: result(40) }], exit: 40 });
    await t.u.update('ws-exemplo');
    await t.u.settled('ws-exemplo');
    assert.deepEqual(t.events.updated, []);
  });
});

describe('issue 462 the real script, read from stdin, accepts the closed tail', () => {
  test('--check against a path that is not a checkout exits 30 not-a-checkout with the NDJSON the parser reads', async () => {
    const real = await readFile(new URL('../../../../scripts/remote-core/update-remote-core.mjs', import.meta.url), 'utf8');
    const t = setup({ script: async () => real, connection: (s) => s.connection({ update: { command: [process.execPath, new URL('./fake-update-ssh.mjs', import.meta.url).pathname, s.file, '--checkout', '/nonexistent/ahrena-console', '--port', '4720'], timeoutSeconds: 60 } }) });
    t.s.set({ real: true });
    await t.u.check('ws-exemplo');
    await t.u.settled('ws-exemplo');
    const v = t.view();
    assert.equal(v.exitCode, 30);
    assert.equal(v.reason, 'not-a-checkout');
    assert.equal(v.state, 'refused');
    assert.equal(v.message?.key, 'exit-30-not-a-checkout');
  });
});

/** Samples the phase while an update runs (the phases the screen would draw). */
class CoreUpdaterPhaseWatch {
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(t: { view: () => MachineUpdate }, into: (string | null)[]) {
    this.timer = setInterval(() => into.push(t.view().phase), 10);
  }
  stop(): void {
    clearInterval(this.timer);
  }
}
