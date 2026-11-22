// The memory runner: fixed argv, no shell, closed stdin, bounded stdout, timeout, one at a time (#727).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeSpawn, turn } from './mocks/fake-child.ts';
import { createMemoryRunner, memoryEnv } from './runner.ts';

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

  test('#727/AC-1 each command has its own fixed argv, with the data dir the core fixed', async () => {
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
        ['--data-dir', DATA_DIR, 'status'],
      ],
    );
  });

  test('#727/AC-2 the child environment is the core environment without AI_MEMORY_AUTH_TOKEN and AHRENA_CONSOLE_*', async () => {
    const { runner, calls } = runnerWith({
      env: { PATH: '/usr/bin', AI_MEMORY_AUTH_TOKEN: FAKE_TOKEN, AHRENA_CONSOLE_CORE_PORT: '1234', AHRENA_CONSOLE_DATA_DIR: '/x', OTHER: 'kept' },
    });
    const pending = runner.run('version');
    await turn();
    const env = calls[0]!.options.env!;
    assert.deepEqual(env, { PATH: '/usr/bin', OTHER: 'kept' });
    calls[0]!.child.finish(0, 'ai-memory 3.5.1');
    await pending;
  });

  test('#727/AC-2 memoryEnv drops the token whatever the case of its name', () => {
    const env = memoryEnv({ ai_memory_auth_token: FAKE_TOKEN, AI_MEMORY_AUTH_TOKEN: FAKE_TOKEN, KEEP: '1' });
    assert.deepEqual(env, { KEEP: '1' });
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
    const { runner, calls, signals } = runnerWith({ maxStdoutBytes: 10 });
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
    const { runner, calls, lines } = logged({ maxStdoutBytes: 10 });
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
