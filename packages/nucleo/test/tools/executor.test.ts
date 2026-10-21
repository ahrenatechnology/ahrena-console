// #280 layer 2: the executor with a fake spawn and a fake service: nothing real ever runs. The queue
// (one at a time, FIFO), step 2 only after step 1 exits 0, the admin refusal before any spawn, the
// timeout and Cancel to the process group, the verify phase, the masking (job, tools.log) and the
// `tools` change on each transition.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { MCP_CHANGE_TYPES } from '../../src/changes/mcp.ts';
import { maskSecrets, publishToolsChanges, ToolsExecutor, type ToolsHost } from '../../src/tools/executor.ts';
import type { ActionPlanResult, ToolActionView, ToolsOverview } from '../../src/tools/service.ts';
import { fakeSpawn, type SpawnCall } from './doubles.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-tools-executor-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const action = (steps: string[][], o: Partial<ToolActionView> = {}): ToolActionView => ({
  id: 'update',
  runnable: true,
  admin: false,
  blockedReason: null,
  steps,
  timeoutSeconds: 600,
  targetVersion: '2.83.1',
  planDigest: '0123456789abcdef',
  ...o,
});

function fakeHost(plans: Record<string, ToolActionView>, o: { installed?: Record<string, string>; realpaths?: Record<string, string> } = {}) {
  const verified: string[] = [];
  let invalidated = 0;
  const host: ToolsHost = {
    overview: async (machine) => (machine === 'local' ? ({ version: 1, jobs: { current: null, queue: [], recent: [] } } as unknown as ToolsOverview) : null),
    check: async () => null,
    actionPlan: async (machine, toolId, actionId): Promise<ActionPlanResult> => {
      if (machine !== 'local') return { kind: 'unknown-machine' };
      const a = plans[`${toolId} ${actionId}`];
      if (!a) return { kind: 'unknown' };
      return { kind: 'plan', toolId, actionId: a.id, label: `Atualizar ${toolId}`, action: a };
    },
    verify: async (_m, toolId) => {
      verified.push(toolId);
      return o.installed?.[toolId] ?? null;
    },
    invalidate: () => void invalidated++,
    processEnv: async () => ({ PATH: '/opt/homebrew/bin:/usr/bin', NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' }),
    resolveExecutable: async (name) => (name.startsWith('/') ? { path: name, realPath: o.realpaths?.[name] ?? name } : { path: `/opt/homebrew/bin/${name}`, realPath: o.realpaths?.[name] ?? `/opt/homebrew/bin/${name}` }),
  };
  return { host, verified, invalidated: () => invalidated };
}

function boot(plans: Record<string, ToolActionView>, script?: (call: SpawnCall) => void, o: Parameters<typeof fakeHost>[1] & { maxLogBytes?: number } = {}) {
  const { host, verified, invalidated } = fakeHost(plans, o);
  const sp = fakeSpawn(script);
  const changes: string[] = [];
  const logFile = join(dir, `tools-${++n}.log`);
  const executor = new ToolsExecutor({
    service: host,
    logFile,
    spawn: sp.spawn,
    killGroup: sp.killGroup,
    cwd: '/Users/exemplo',
    msPerSecond: 1000,
    killGraceMs: 5000,
    ...(o.maxLogBytes ? { maxLogBytes: o.maxLogBytes } : {}),
    onChange: (m) => changes.push(`${m}:${executor.jobs(m).current?.state ?? '-'}`),
    log: () => {},
  });
  return { executor, sp, changes, verified, invalidated, logFile };
}

const exitWith = (code: number, lines: string[] = []) => (call: SpawnCall) => {
  for (const l of lines) call.child.out(`${l}\n`);
  call.child.exit(code);
};

describe('#280 ToolsExecutor', () => {
  test('a job: spawn without shell, detached, home, the tools env; verify records the new version; succeeded', async () => {
    const { executor, sp, verified } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]) }, exitWith(0, ['==> Upgrading gh']), { installed: { gh: '2.83.1' } });
    const r = await executor.act('local', 'gh', 'update', '0123456789abcdef');
    assert.equal(r.kind, 'queued');
    await executor.idle('local');
    assert.equal(sp.calls.length, 1);
    const c = sp.calls[0]!;
    assert.equal(c.command, '/opt/homebrew/bin/brew');
    assert.deepEqual(c.args, ['upgrade', 'gh']);
    assert.equal(c.options.shell, false);
    assert.equal(c.options.detached, true);
    assert.deepEqual(c.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(c.options.cwd, '/Users/exemplo');
    assert.equal((c.options.env as NodeJS.ProcessEnv).NONINTERACTIVE, '1');
    const job = executor.jobs('local').recent[0]!;
    assert.deepEqual(Object.keys(job), ['id', 'toolId', 'actionId', 'label', 'machine', 'state', 'steps', 'step', 'phase', 'startedAt', 'endedAt', 'exitCode', 'timeoutSeconds', 'targetVersion', 'output', 'logFile']);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.exitCode, 0);
    assert.equal(job.phase, 'verifying');
    assert.deepEqual(verified, ['gh']);
    assert.deepEqual(job.output, ['$ brew upgrade gh', '==> Upgrading gh', 'Versão instalada agora: 2.83.1']);
    assert.equal(executor.jobs('local').current, null);
  });

  test('start/stop: no version probe, the probe cache is dropped', async () => {
    const { executor, verified, invalidated } = boot({ 'container-colima stop': action([['colima', 'stop']], { id: 'stop', targetVersion: null }) }, exitWith(0));
    await executor.act('local', 'container-colima', 'stop', '0123456789abcdef');
    await executor.idle('local');
    assert.deepEqual(verified, []);
    assert.equal(invalidated(), 1);
    assert.equal(executor.jobs('local').recent[0]!.state, 'succeeded');
  });

  test('queue: two actions run one after the other, never overlapping', async () => {
    const { executor, sp } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]), 'jq update': action([['brew', 'upgrade', 'jq']]) });
    await executor.act('local', 'gh', 'update', '0123456789abcdef');
    const second = await executor.act('local', 'jq', 'update', '0123456789abcdef');
    assert.equal(second.kind === 'queued' && second.job.state, 'queued');
    await new Promise((r) => setImmediate(r));
    assert.equal(sp.calls.length, 1, 'the second waits');
    assert.equal(executor.jobs('local').queue.length, 1);
    sp.calls[0]!.child.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sp.calls.length, 2);
    assert.deepEqual(sp.calls[1]!.args, ['upgrade', 'jq']);
    sp.calls[1]!.child.exit(0);
    await executor.idle('local');
    assert.equal(sp.maxActive(), 1);
    assert.deepEqual(executor.jobs('local').recent.map((j) => [j.toolId, j.state]), [['jq', 'succeeded'], ['gh', 'succeeded']]);
  });

  test('the same tool and action already queued gets that job back', async () => {
    const { executor, sp } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]) });
    const a = await executor.act('local', 'gh', 'update', '0123456789abcdef');
    const b = await executor.act('local', 'gh', 'update', '0123456789abcdef');
    assert.ok(a.kind === 'queued' && b.kind === 'queued');
    assert.equal(a.job.id, b.job.id);
    await new Promise((r) => setImmediate(r));
    sp.calls[0]!.child.exit(0);
    await executor.idle('local');
    assert.equal(sp.calls.length, 1);
  });

  test('step 2 runs only when step 1 exits 0', async () => {
    const steps = [['claude', 'mcp', 'remove', 'playwright'], ['claude', 'mcp', 'add', 'playwright']];
    const failing = boot({ 'x update': action(steps) }, exitWith(1, ['erro']));
    await failing.executor.act('local', 'x', 'update', '0123456789abcdef');
    await failing.executor.idle('local');
    assert.equal(failing.sp.calls.length, 1);
    const job = failing.executor.jobs('local').recent[0]!;
    assert.deepEqual([job.state, job.exitCode, job.step], ['failed', 1, 0]);
    assert.deepEqual(failing.verified, []);

    const ok = boot({ 'x update': action(steps) }, exitWith(0));
    await ok.executor.act('local', 'x', 'update', '0123456789abcdef');
    await ok.executor.idle('local');
    assert.equal(ok.sp.calls.length, 2);
    assert.equal(ok.executor.jobs('local').recent[0]!.step, 1);
  });

  test('an admin plan is refused: failed, nothing spawned', async () => {
    const { executor, sp } = boot({ 'aws update': action([['sudo', 'installer', '-pkg', 'AWSCLIV2.pkg', '-target', '/']], { admin: true }) });
    // A plan the service marks runnable by mistake still never spawns.
    await executor.act('local', 'aws', 'update', '0123456789abcdef');
    await executor.idle('local');
    assert.equal(sp.calls.length, 0);
    const job = executor.jobs('local').recent[0]!;
    assert.equal(job.state, 'failed');
    assert.match(job.output[0]!, /^Recusado: este passo pede administrador/);
  });

  for (const exe of ['sudo', 'doas', 'pkexec', 'su', 'runas', 'osascript']) {
    for (const argv0 of [exe, `/usr/bin/${exe}`]) {
      test(`an unmarked step whose argv[0] is ${argv0} is refused, nothing spawned`, async () => {
        const { executor, sp } = boot({ 'x update': action([['brew', 'upgrade', 'x'], [argv0, 'rm', '-rf', '/tmp/x']]) });
        await executor.act('local', 'x', 'update', '0123456789abcdef');
        await executor.idle('local');
        assert.equal(sp.calls.length, 0, 'not even step 1');
        assert.equal(executor.jobs('local').recent[0]!.state, 'failed');
      });
    }
  }

  test('an argv[0] whose realpath is sudo is refused too', async () => {
    const { executor, sp } = boot({ 'x update': action([['/opt/homebrew/bin/helper', 'go']]) }, undefined, { realpaths: { '/opt/homebrew/bin/helper': '/usr/bin/sudo' } });
    await executor.act('local', 'x', 'update', '0123456789abcdef');
    await executor.idle('local');
    assert.equal(sp.calls.length, 0);
  });

  test('digest mismatch: stale with the new plan; a blocked plan: blocked; nothing queued', async () => {
    const { executor, sp } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]), 'go update': action([['brew', 'upgrade', 'go']], { runnable: false, blockedReason: 'offline' }) });
    const stale = await executor.act('local', 'gh', 'update', 'ffffffffffffffff');
    assert.equal(stale.kind, 'stale');
    assert.equal(stale.kind === 'stale' && stale.plan.planDigest, '0123456789abcdef');
    assert.equal((await executor.act('local', 'go', 'update', '0123456789abcdef')).kind, 'blocked');
    assert.equal((await executor.act('local', 'nope', 'update', '0123456789abcdef')).kind, 'unknown');
    assert.equal((await executor.act('ws-exemplo', 'gh', 'update', '0123456789abcdef')).kind, 'unknown-machine');
    assert.equal(sp.calls.length, 0);
    assert.deepEqual(executor.jobs('local'), { current: null, queue: [], recent: [] });
  });

  test('timeout: SIGTERM to the group, SIGKILL 5 s later; timed-out; the next job runs', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { executor, sp } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']], { timeoutSeconds: 30 }), 'jq update': action([['brew', 'upgrade', 'jq']]) });
      await executor.act('local', 'gh', 'update', '0123456789abcdef');
      await executor.act('local', 'jq', 'update', '0123456789abcdef');
      await flush();
      assert.equal(sp.calls.length, 1);
      mock.timers.tick(29_999);
      assert.deepEqual(sp.kills, []);
      mock.timers.tick(1);
      const pid = sp.calls[0]!.child.pid;
      assert.deepEqual(sp.kills, [{ pid, signal: 'SIGTERM' }]);
      assert.equal(executor.jobs('local').current!.state, 'timed-out');
      mock.timers.tick(4_999);
      assert.equal(sp.kills.length, 1);
      mock.timers.tick(1);
      assert.deepEqual(sp.kills, [{ pid, signal: 'SIGTERM' }, { pid, signal: 'SIGKILL' }]);
      await flush();
      assert.equal(sp.calls.length, 2, 'the queue goes on');
      const gh = executor.jobs('local').recent[0]!;
      assert.deepEqual([gh.toolId, gh.state, gh.exitCode], ['gh', 'timed-out', null]);
      assert.match(gh.output.at(-1)!, /tempo limite \(30 s\)/);
      sp.calls[1]!.child.exit(0);
      await flush();
    } finally {
      mock.timers.reset();
    }
  });

  test('cancel: the running job gets SIGTERM to its group and is canceled; a queued one leaves the queue; an ended one is ended', async () => {
    const { executor, sp } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]), 'jq update': action([['brew', 'upgrade', 'jq']]) });
    const a = await executor.act('local', 'gh', 'update', '0123456789abcdef');
    const b = await executor.act('local', 'jq', 'update', '0123456789abcdef');
    assert.ok(a.kind === 'queued' && b.kind === 'queued');
    await new Promise((r) => setImmediate(r));
    const queued = executor.cancel(b.job.id);
    assert.equal(queued.kind === 'canceled' && queued.job.state, 'canceled');
    const running = executor.cancel(a.job.id);
    assert.equal(running.kind === 'canceled' && running.job.state, 'canceled');
    assert.deepEqual(sp.kills.map((k) => k.signal), ['SIGTERM']);
    sp.calls[0]!.child.exit(null, 'SIGTERM');
    await executor.idle('local');
    assert.equal(sp.calls.length, 1, 'the canceled queued job never ran');
    assert.equal(executor.cancel(a.job.id).kind, 'ended');
    assert.equal(executor.cancel('aaaaaaaaaaaa').kind, 'unknown');
    assert.deepEqual(executor.jobs('local').recent.map((j) => [j.toolId, j.state]), [['gh', 'canceled'], ['jq', 'canceled']]);
  });

  test('masking: the URL credential and token= never reach the job nor tools.log, which is 0600', async () => {
    const lines = ['fetching https://user:s3cr3t@exemplo.dev/pkg.tgz?token=abc&x=1', 'Authorization: Bearer abc.def', 'export API_KEY=zzz9'];
    const { executor, logFile } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]) }, (call) => {
      call.child.err(lines.join('\n'));
      call.child.exit(0);
    });
    await executor.act('local', 'gh', 'update', '0123456789abcdef');
    await executor.idle('local');
    const out = executor.jobs('local').recent[0]!.output.join('\n');
    const log = readFileSync(logFile, 'utf8');
    for (const text of [out, log, JSON.stringify(executor.jobs('local'))]) {
      for (const secret of ['s3cr3t', 'user:', 'abc', 'zzz9']) assert.equal(text.includes(secret), false, `${secret} leaked`);
      assert.match(text, /https:\/\/\*\*\*@exemplo\.dev\/pkg\.tgz\?token=\*\*\*&x=1/);
    }
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
    assert.match(log.split('\n')[0]!, /^\S+ local job [a-f0-9]{12} start update gh$/);
    assert.match(log.trimEnd().split('\n').at(-1)!, /^\S+ local job [a-f0-9]{12} end succeeded exit 0 after \d+ s$/);
  });

  test('maskSecrets', () => {
    assert.equal(maskSecrets('git clone https://ghp_x@github.example/a.git'), 'git clone https://***@github.example/a.git');
    assert.equal(maskSecrets('password: hunter2'), 'password: ***');
    assert.equal(maskSecrets('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: ***');
    assert.equal(maskSecrets('Authorization: abc'), 'Authorization: ***');
    assert.equal(maskSecrets('--client-secret=xyz other'), '--client-secret=*** other');
    assert.equal(maskSecrets('"apiKey": "k-123"'), '"apiKey": "***"');
    assert.equal(maskSecrets('==> Upgrading gh 2.81.0 -> 2.83.1'), '==> Upgrading gh 2.81.0 -> 2.83.1');
  });

  test('tools.log rotates to tools.log.1 past the limit; the last 200 lines stay on the job', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `linha ${i}`);
    const { executor, logFile } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]) }, exitWith(0, lines), { maxLogBytes: 100 });
    writeFileSync(logFile, 'x'.repeat(200), { mode: 0o600 });
    await executor.act('local', 'gh', 'update', '0123456789abcdef');
    await executor.idle('local');
    assert.equal(readFileSync(`${logFile}.1`, 'utf8'), 'x'.repeat(200));
    assert.equal(statSync(`${logFile}.1`).mode & 0o777, 0o600);
    assert.match(readFileSync(logFile, 'utf8'), /linha 249/);
    const out = executor.jobs('local').recent[0]!.output;
    assert.equal(out.length, 200);
    assert.equal(out.at(-1), 'A sonda não leu a versão instalada depois da ação.');
    assert.equal(out.includes('linha 249'), true);
    assert.equal(out.includes('$ brew upgrade gh'), false, 'the oldest lines left');
  });

  test('a `tools` change keyed by the machine on each transition; MCP does not expose the type', async () => {
    const { executor, sp, changes } = boot({ 'gh update': action([['brew', 'upgrade', 'gh']]) });
    await executor.act('local', 'gh', 'update', '0123456789abcdef');
    await new Promise((r) => setImmediate(r));
    sp.calls[0]!.child.exit(0);
    await executor.idle('local');
    await new Promise((r) => setImmediate(r));
    // queued (nothing current yet), running, verifying, ended (current cleared)
    assert.deepEqual(changes, ['local:-', 'local:running', 'local:running', 'local:-']);

    const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
    const start = cursor.current;
    publishToolsChanges(cursor)('local');
    const all = await cursor.wait(start, { timeoutMs: 0 });
    assert.deepEqual(all.changes.map((c) => [c.type, c.key, c.sessionId, c.accountId]), [['tools', 'local', null, null]]);
    assert.equal((MCP_CHANGE_TYPES as readonly string[]).includes('tools'), false);
  });
});

/** Lets the promise chains and setImmediate callbacks run (setTimeout is mocked in the timer test). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}
