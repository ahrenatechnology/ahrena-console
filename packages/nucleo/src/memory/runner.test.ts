// The memory runner: fixed argv, no shell, closed stdin, bounded stdout, timeout, one at a time (#727).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeSpawn, turn } from './mocks/fake-child.ts';
import { registeredAccountFolder } from '../tools/embedded-ai-memory.ts';
import { createMemoryRunner } from './runner.ts';

const BINARY = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const DATA_DIR = '/Users/someone/.ahrena-console/ai-memory';
const FAKE_TOKEN = 'fake-token-0000-not-real';

function runnerWith(extra: Partial<Parameters<typeof createMemoryRunner>[0]> = {}) {
  const doubles = fakeSpawn();
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const runner = createMemoryRunner({
    binaryPath: BINARY,
    dataDir: DATA_DIR,
    spawn: doubles.spawn,
    killGroup: (pid, signal) => signals.push({ pid, signal }),
    env: { PATH: '/usr/bin', HOME: '/Users/someone' },
    ...extra,
  });
  return { runner, calls: doubles.calls, signals };
}

describe('memory runner (#727/AC-1, #727/AC-2)', () => {
  test('#727/AC-1 the version command runs the embedded binary by absolute path with a fixed argv, no shell and a closed stdin', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('version');
    await turn();
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, BINARY);
    assert.deepEqual(call.args, ['--data-dir', DATA_DIR, '--version']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    call.child.finish(0, 'ai-memory 3.5.1\n');
    assert.deepEqual(await pending, { kind: 'ok', stdout: 'ai-memory 3.5.1\n' });
  });

  test('#727/AC-1 each command has its own fixed argv, with an injected data dir (tests only)', async () => {
    const { runner, calls } = runnerWith();
    for (const command of ['version', 'setup-plan', 'status'] as const) {
      const pending = runner.run(command);
      await turn();
      calls.at(-1)!.child.finish(0, '{}');
      await pending;
    }
    assert.deepEqual(
      calls.map((c) => c.args),
      [
        ['--data-dir', DATA_DIR, '--version'],
        ['--data-dir', DATA_DIR, 'setup', '--plan', '--json', '--agent', 'claude-code'],
        ['--data-dir', DATA_DIR, 'status', '--json'],
      ],
    );
  });

  test('#719/AC-10 with no injected data dir the argv carries no --data-dir, so ai-memory uses its default folder (#735)', async () => {
    const { runner, calls } = runnerWith({ dataDir: undefined });
    for (const command of ['version', 'setup-plan', 'status'] as const) {
      const pending = runner.run(command);
      await turn();
      calls.at(-1)!.child.finish(0, '{}');
      await pending;
    }
    assert.deepEqual(
      calls.map((c) => c.args),
      [['--version'], ['setup', '--plan', '--json', '--agent', 'claude-code'], ['status', '--json']],
    );
  });

  const CREDENTIALS: Record<string, string> = {
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    ANTHROPIC_AUTH_TOKEN: 'fake-anthropic-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token',
    GH_TOKEN: 'fake-gh-token',
    GITHUB_TOKEN: 'fake-github-token',
    AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    AWS_ACCESS_KEY_ID: 'fake-aws-id',
    AI_MEMORY_AUTH_TOKEN: FAKE_TOKEN,
    AI_MEMORY_DATA_DIR: '/x/other',
    AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1',
    AHRENA_CONSOLE_CORE_PORT: '1234',
    AHRENA_CONSOLE_DATA_DIR: '/x',
    OTHER: 'dropped',
  };
  const KEPT: Record<string, string> = {
    PATH: '/usr/bin',
    HOME: '/Users/someone',
    TMPDIR: '/tmp/x',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    USER: 'someone',
  };

  test('#727/AC-2 the child environment is built from an allowlist: no credential and no AI_MEMORY_* or AHRENA_CONSOLE_* reaches it', async () => {
    const { runner, calls } = runnerWith({ env: { ...KEPT, ...CREDENTIALS } });
    const pending = runner.run('version');
    await turn();
    const env = calls[0]!.options.env!;
    for (const key of Object.keys(CREDENTIALS)) assert.equal(key in env, false, `${key} must not reach the child`);
    assert.deepEqual(env, KEPT);
    calls[0]!.child.finish(0, 'ai-memory 3.5.1');
    await pending;
  });

  test('#727/AC-1 an embedded path of null reports unavailable and spawns nothing', async () => {
    const { runner, calls } = runnerWith({ binaryPath: null });
    assert.equal(runner.available, false);
    assert.deepEqual(await runner.run('version'), { kind: 'unavailable' });
    assert.equal(calls.length, 0);
  });

  test('#727/AC-2 a data dir that is not absolute is refused when the runner is built', () => {
    assert.throws(() => createMemoryRunner({ binaryPath: BINARY, dataDir: 'relative/dir' }), /absolute/);
    assert.throws(() => createMemoryRunner({ binaryPath: 'ai-memory', dataDir: DATA_DIR }), /absolute/);
  });

  test('#727/AC-1 only stdout is read: a stderr with a token-looking string appears in no result', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.finish(0, 'ai-memory 3.5.1\n', `warn: AI_MEMORY_AUTH_TOKEN=${FAKE_TOKEN}\n`);
    const result = await pending;
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
    assert.deepEqual(result, { kind: 'ok', stdout: 'ai-memory 3.5.1\n' });
  });

  test('#727/AC-1 a non-zero exit is reported as its code, with no stdout or stderr', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('status');
    await turn();
    calls[0]!.child.finish(1, 'partial', `error ${FAKE_TOKEN}`);
    assert.deepEqual(await pending, { kind: 'exit', code: 1 });
  });

  test('#727/AC-1 stdout past its bound ends the call and kills the group', async () => {
    const { runner, calls, signals } = runnerWith({ maxStdoutBytes: 10, killGraceMs: 20 });
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.stdout.write('x'.repeat(50));
    await turn();
    calls[0]!.child.emit('close', null, 'SIGTERM');
    assert.deepEqual(await pending, { kind: 'failed', reason: 'output-too-large' });
    assert.deepEqual(signals[0], { pid: 4242, signal: 'SIGTERM' });
  });

  test('#727/AC-1 a spawn that throws is a failed call, not an exception', async () => {
    const runner = createMemoryRunner({
      binaryPath: BINARY,
      dataDir: DATA_DIR,
      spawn: () => {
        throw Object.assign(new Error(`boom ${FAKE_TOKEN}`), { code: 'EACCES' });
      },
    });
    const result = await runner.run('version');
    assert.deepEqual(result, { kind: 'failed', reason: 'spawn' });
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  test('#727/AC-1 a child error event is a failed call', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.emit('error', new Error(`ENOENT ${FAKE_TOKEN}`));
    assert.deepEqual(await pending, { kind: 'failed', reason: 'spawn' });
  });

  test('#727/AC-1 a second call waits for the first: one at a time', async () => {
    const { runner, calls } = runnerWith();
    const first = runner.run('version');
    const second = runner.run('status');
    await turn();
    assert.equal(calls.length, 1, 'the second call must not spawn while the first runs');
    calls[0]!.child.finish(0, 'ai-memory 3.5.1');
    await first;
    await turn();
    assert.equal(calls.length, 2);
    calls[1]!.child.finish(0, '');
    assert.deepEqual(await second, { kind: 'ok', stdout: '' });
  });

  test('#727/AC-1 a failed call does not block the queue', async () => {
    const { runner, calls } = runnerWith();
    const first = runner.run('version');
    const second = runner.run('version');
    await turn();
    calls[0]!.child.emit('error', new Error('x'));
    await first;
    await turn();
    assert.equal(calls.length, 2);
    calls[1]!.child.finish(0, 'ai-memory 3.5.1');
    assert.equal((await second).kind, 'ok');
  });
});

describe('memory runner timeout (#727/AC-1)', () => {
  test('#727/AC-1 past its timeout the group gets SIGTERM, and SIGKILL after the grace period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls, signals } = runnerWith({ timeoutMs: 1_000, killGraceMs: 500 });
    const pending = runner.run('version');
    await turn();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(999);
    assert.deepEqual(signals, []);
    t.mock.timers.tick(1);
    assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }]);
    t.mock.timers.tick(499);
    assert.equal(signals.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(signals, [
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(await pending, { kind: 'timeout' });
  });

  test('#727/AC-1 a child that closes after SIGTERM ends the call as a timeout and SIGKILL still reaches the group after the grace', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls, signals } = runnerWith({ timeoutMs: 1_000, killGraceMs: 500 });
    const pending = runner.run('version');
    await turn();
    t.mock.timers.tick(1_000);
    calls[0]!.child.emit('close', null, 'SIGTERM');
    assert.deepEqual(await pending, { kind: 'timeout' });
    assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }]);
    t.mock.timers.tick(499);
    assert.equal(signals.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(signals, [
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
  });

  test('#727/AC-1 a call that ends in time clears its timer: no signal is sent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls, signals } = runnerWith({ timeoutMs: 1_000 });
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.finish(0, 'ai-memory 3.5.1');
    await pending;
    t.mock.timers.tick(10_000);
    assert.deepEqual(signals, []);
  });
});

describe('memory runner log (#727, OBS-1)', () => {
  function logged(extra: Partial<Parameters<typeof createMemoryRunner>[0]> = {}) {
    const lines: string[] = [];
    const setup = runnerWith({ log: (message) => lines.push(message), ...extra });
    return { ...setup, lines };
  }

  test('#727 a spawn that throws logs the command and the reason, never the error text', async () => {
    const lines: string[] = [];
    const runner = createMemoryRunner({
      binaryPath: BINARY,
      dataDir: DATA_DIR,
      log: (message) => lines.push(message),
      spawn: () => {
        throw new Error(`boom ${FAKE_TOKEN} ${DATA_DIR}`);
      },
    });
    await runner.run('status');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /status/);
    assert.match(lines[0]!, /spawn/);
    assert.equal(lines.join('\n').includes(FAKE_TOKEN), false);
    assert.equal(lines.join('\n').includes(DATA_DIR), false);
  });

  test('#727 a child error event logs the command and the reason, never the error text', async () => {
    const { runner, calls, lines } = logged();
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.stderr.write(`stderr ${FAKE_TOKEN}`);
    calls[0]!.child.emit('error', new Error(`ENOENT ${FAKE_TOKEN}`));
    await pending;
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /version/);
    assert.equal(lines.join('\n').includes(FAKE_TOKEN), false);
  });

  test('#727 a timeout logs the command and the kind', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls, lines } = logged({ timeoutMs: 1_000, killGraceMs: 500 });
    const pending = runner.run('setup-plan');
    await turn();
    t.mock.timers.tick(1_000);
    calls[0]!.child.emit('close', null, 'SIGTERM');
    await pending;
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /setup-plan/);
    assert.match(lines[0]!, /timeout/);
  });

  test('#727 output past the bound logs the command and the reason, with no stdout or stderr', async () => {
    const { runner, calls, lines } = logged({ maxStdoutBytes: 10, killGraceMs: 20 });
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.stderr.write(`stderr ${FAKE_TOKEN}`);
    calls[0]!.child.stdout.write(`x${FAKE_TOKEN}`.repeat(10));
    await turn();
    calls[0]!.child.emit('close', null, 'SIGTERM');
    await pending;
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /output-too-large/);
    assert.equal(lines.join('\n').includes(FAKE_TOKEN), false);
  });

  test('#727 a successful call logs nothing', async () => {
    const { runner, calls, lines } = logged();
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.finish(0, 'ai-memory 3.5.1', `stderr ${FAKE_TOKEN}`);
    await pending;
    assert.deepEqual(lines, []);
  });
});

describe('memory runner exit log (#727)', () => {
  function logged() {
    const lines: string[] = [];
    const setup = runnerWith({ log: (message) => lines.push(message) });
    return { ...setup, lines };
  }

  for (const command of ['version', 'setup-plan', 'status'] as const) {
    test(`#727 a non-zero exit of ${command} logs the command and the code, never stdout, stderr or the data dir`, async () => {
      const { runner, calls, lines } = logged();
      const pending = runner.run(command);
      await turn();
      calls[0]!.child.finish(3, `out ${FAKE_TOKEN}`, `err ${FAKE_TOKEN} ${DATA_DIR}`);
      await pending;
      assert.deepEqual(lines, [`memory: ${command} exit 3`]);
    });
  }

  test('#727 an exit with no code logs the command and "signal"', async () => {
    const { runner, calls, lines } = logged();
    const pending = runner.run('version');
    await turn();
    calls[0]!.child.finish(null);
    await pending;
    assert.deepEqual(lines, ['memory: version exit signal']);
  });
});

describe('memory runner close (#727, decision 0014: one at a time, in a queue)', () => {
  test('#727 a queued call after close spawns nothing and resolves as failed closed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls } = runnerWith({ killGraceMs: 500 });
    const running = runner.run('version');
    const queued = runner.run('status');
    await turn();
    assert.equal(calls.length, 1);
    const closing = runner.close();
    calls[0]!.child.emit('close', null, 'SIGTERM');
    assert.deepEqual(await queued, { kind: 'failed', reason: 'closed' });
    await running;
    t.mock.timers.tick(500);
    await closing;
    assert.equal(calls.length, 1);
  });

  test('#727 the running call gets SIGTERM and then SIGKILL on its group, and resolves', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { runner, calls, signals } = runnerWith({ killGraceMs: 500 });
    const running = runner.run('version');
    await turn();
    const closing = runner.close();
    assert.deepEqual(signals, [{ pid: 4242, signal: 'SIGTERM' }]);
    t.mock.timers.tick(500);
    assert.deepEqual(signals, [
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
    assert.deepEqual(await running, { kind: 'failed', reason: 'closed' });
    await closing;
    assert.equal(calls.length, 1);
  });

  test('#727 a call after close spawns nothing', async () => {
    const { runner, calls } = runnerWith();
    await runner.close();
    assert.deepEqual(await runner.run('version'), { kind: 'failed', reason: 'closed' });
    assert.equal(calls.length, 0);
  });
});

describe('memory runner, handoffs and recent (#733/AC-2, #733/AC-3)', () => {
  const NOT_FOUND = (project: string) => `Error: 404 project '${project}' not found in workspace 'default'\n`;

  test('#733/AC-2 handoffs and recent run with fixed words, the default workspace, the project and --json', async () => {
    const { runner, calls } = runnerWith();
    for (const command of ['handoffs', 'recent'] as const) {
      const pending = runner.run(command, 'my-app_1.2');
      await turn();
      calls.at(-1)!.child.finish(0, '[]');
      assert.deepEqual(await pending, { kind: 'ok', stdout: '[]' });
    }
    assert.deepEqual(
      calls.map((c) => c.args),
      [
        ['--data-dir', DATA_DIR, 'handoffs', '--workspace', 'default', '--project', 'my-app_1.2', '--json'],
        ['--data-dir', DATA_DIR, 'recent', '--workspace', 'default', '--project', 'my-app_1.2', '--json'],
      ],
    );
    assert.equal(calls[0]!.options.shell, false);
  });

  for (const bad of ['', '-rf', '--global', 'a b', 'a/b', '../x', 'a\nb', 'a;b', "a'b", '$(x)', 'é', 'a'.repeat(129), '.hidden', '_x']) {
    test(`#733/AC-2 the project ${JSON.stringify(bad)} is refused without spawning, and never logged`, async () => {
      const lines: string[] = [];
      const { runner, calls } = runnerWith({ log: (m) => lines.push(m) });
      assert.deepEqual(await runner.run('handoffs', bad), { kind: 'failed', reason: 'invalid-project' });
      assert.deepEqual(await runner.run('recent', bad), { kind: 'failed', reason: 'invalid-project' });
      assert.equal(calls.length, 0);
      assert.deepEqual(lines, ['memory: handoffs failed invalid-project', 'memory: recent failed invalid-project']);
    });
  }

  test('#733/AC-2 a project of 128 characters is accepted', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('recent', 'a'.repeat(128));
    await turn();
    assert.equal(calls.length, 1);
    calls[0]!.child.finish(0, '[]');
    await pending;
  });

  test('#733/AC-2 a missing project for handoffs is refused without spawning', async () => {
    const { runner, calls } = runnerWith();
    assert.deepEqual(await (runner.run as (c: string) => Promise<unknown>)('handoffs'), { kind: 'failed', reason: 'invalid-project' });
    assert.equal(calls.length, 0);
  });

  for (const command of ['handoffs', 'recent'] as const) {
    test(`#733/AC-2 a ${command} exit 1 whose stderr says the project is not found is the kind not-found, with no text`, async () => {
      const lines: string[] = [];
      const { runner, calls } = runnerWith({ log: (m) => lines.push(m) });
      const pending = runner.run(command, 'app');
      await turn();
      calls[0]!.child.finish(1, '', NOT_FOUND('app'));
      assert.deepEqual(await pending, { kind: 'not-found' });
      assert.deepEqual(lines, [`memory: ${command} not-found`]);
    });
  }

  test('#733/AC-2 the same exit with any other stderr is an exit, not a not-found', async () => {
    const { runner, calls } = runnerWith();
    for (const stderr of ['', 'connection refused', NOT_FOUND('other'), "project 'app' not found in workspace 'work'", "project 'app' not found"]) {
      const pending = runner.run('handoffs', 'app');
      await turn();
      calls.at(-1)!.child.finish(1, '', stderr);
      assert.deepEqual(await pending, { kind: 'exit', code: 1 });
    }
  });

  test('#733/AC-2 the not-found text on a status or a version call is an exit: only handoffs and recent look', async () => {
    const { runner, calls } = runnerWith();
    for (const command of ['status', 'version'] as const) {
      const pending = runner.run(command);
      await turn();
      calls.at(-1)!.child.finish(1, '', NOT_FOUND('app'));
      assert.deepEqual(await pending, { kind: 'exit', code: 1 });
    }
  });

  test('#733/AC-2 a not-found text on a call that exits 0 is an ok, and on a signal is an exit with no code', async () => {
    const { runner, calls } = runnerWith();
    const zero = runner.run('handoffs', 'app');
    await turn();
    calls[0]!.child.finish(0, '[]', NOT_FOUND('app'));
    assert.deepEqual(await zero, { kind: 'ok', stdout: '[]' });
    const signal = runner.run('handoffs', 'app');
    await turn();
    calls[1]!.child.finish(null, '', NOT_FOUND('app'));
    assert.deepEqual(await signal, { kind: 'exit', code: null });
  });

  test('#733/AC-2 only the first 4 KiB of stderr is looked at', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('handoffs', 'app');
    await turn();
    calls[0]!.child.finish(1, '', `${'x'.repeat(4096)}${NOT_FOUND('app')}`);
    assert.deepEqual(await pending, { kind: 'exit', code: 1 });
  });

  test('#733/AC-2 the project in the not-found pattern is matched as text, never as a pattern', async () => {
    const { runner, calls } = runnerWith();
    const pending = runner.run('handoffs', 'a.b');
    await turn();
    calls[0]!.child.finish(1, '', NOT_FOUND('aXb'));
    assert.deepEqual(await pending, { kind: 'exit', code: 1 });
  });

  test('#733/AC-2 a stderr carrying a planted token reaches no log line and no result, found or not', async () => {
    const lines: string[] = [];
    const { runner, calls } = runnerWith({ log: (m) => lines.push(m) });
    const results: unknown[] = [];
    for (const stderr of [`boom ${FAKE_TOKEN}`, `${NOT_FOUND('app')}${FAKE_TOKEN}`]) {
      const pending = runner.run('recent', 'app');
      await turn();
      calls.at(-1)!.child.finish(1, '', stderr);
      results.push(await pending);
    }
    assert.equal(JSON.stringify([results, lines]).includes(FAKE_TOKEN), false);
    assert.deepEqual(results, [{ kind: 'exit', code: 1 }, { kind: 'not-found' }]);
  });
});

describe('#740/AC-1 #740/AC-7 the setup plan of one registered account folder', () => {
  const FOLDER = '/Users/someone/.claude-work';
  const folder = registeredAccountFolder(FOLDER, [FOLDER], () => true)!;

  test('#740/AC-1 Given a registered folder, When its plan is read, Then the fixed argv runs with CLAUDE_CONFIG_DIR set to it and no other variable beyond the allowlist', async () => {
    const { runner, calls } = runnerWith({ env: { PATH: '/usr/bin', HOME: '/Users/someone', GH_TOKEN: FAKE_TOKEN, CLAUDE_CONFIG_DIR: '/Users/evil/.claude' } });
    const pending = runner.runSetupPlanFor(folder);
    await turn();
    const call = calls[0]!;
    assert.equal(call.command, BINARY);
    assert.deepEqual(call.args, ['--data-dir', DATA_DIR, 'setup', '--plan', '--json', '--agent', 'claude-code']);
    assert.deepEqual(call.options.env, { PATH: '/usr/bin', HOME: '/Users/someone', CLAUDE_CONFIG_DIR: FOLDER });
    assert.equal(call.options.shell, false);
    call.child.finish(0, '{}');
    assert.deepEqual(await pending, { kind: 'ok', stdout: '{}' });
  });

  test('#740/AC-1 Given a plain read after a folder read, Then the plain one carries no CLAUDE_CONFIG_DIR', async () => {
    const { runner, calls } = runnerWith({ env: { PATH: '/usr/bin' } });
    const first = runner.runSetupPlanFor(folder);
    await turn();
    calls[0]!.child.finish(0, '{}');
    await first;
    const second = runner.run('setup-plan');
    await turn();
    assert.equal('CLAUDE_CONFIG_DIR' in (calls[1]!.options.env ?? {}), false);
    calls[1]!.child.finish(0, '{}');
    await second;
  });

  test('#740/AC-1 Given no binary, Then nothing is spawned', async () => {
    const { runner, calls } = runnerWith({ binaryPath: null });
    assert.deepEqual(await runner.runSetupPlanFor(folder), { kind: 'unavailable' });
    assert.equal(calls.length, 0);
  });
});
