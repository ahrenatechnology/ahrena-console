// The reconnect runner (#244, decision 0012 section 3) with a FAKE command: a tiny node script written
// to a temporary folder, which exits 0, exits 1, sleeps past a short timeout, ignores SIGTERM, prints
// lines or leaves a child running in the background (a tunnel). No real tunnel, host or provider. The time unit is shortened (1 "second" = 20 ms) so the
// timeout tests run fast; the rules are the same. A command that must finish on its own gets the
// longest timeout (900 = 18 s here), so a loaded runner never turns it into a timeout.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { ReconnectConfig } from '../../src/telemetry/machines-config.ts';
import { INVALID_MACHINES_FILE, reconnectEnv, ReconnectRunner, type ReconnectRunnerOptions } from '../../src/telemetry/reconnect.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-reconnect-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const SCRIPT = join(dir, 'fake-connect.mjs');
writeFileSync(
  SCRIPT,
  `const [mode, arg] = process.argv.slice(2);
if (mode === 'ok') { console.log('line-out-one'); console.error('line-err-two'); process.stdout.write('no-newline-tail'); }
if (mode === 'fail') { console.log('about to fail'); process.exitCode = 1; }
if (mode === 'sleep') setTimeout(() => {}, 60_000);
if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000); }
if (mode === 'env') { const fs = await import('node:fs'); fs.writeFileSync(arg, JSON.stringify({ keys: Object.keys(process.env), cwd: process.cwd(), stdinTty: process.stdin.isTTY ?? null })); }
if (mode === 'marker') { const fs = await import('node:fs'); fs.writeFileSync(arg, 'ran'); }
if (mode === 'chatty') { for (let i = 0; i < 200; i++) console.log('chatty line ' + i); }
if (mode === 'background') {
  const { spawn } = await import('node:child_process');
  // Inherits stdout and stderr, stays in the group, outlives the script: like a tunnel left running.
  const c = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => console.log('bg-tick'), 30)", arg], { stdio: 'inherit' });
  c.unref();
  await new Promise((r) => setTimeout(r, 150));
}
`,
);

const fake = (mode: string, ...args: string[]): ReconnectConfig => ({ command: [process.execPath, SCRIPT, mode, ...args], timeoutSeconds: 900 });

let n = 0;
function runner(configs: Record<string, ReconnectConfig | null | typeof INVALID_MACHINES_FILE>, over: Partial<ReconnectRunnerOptions> = {}) {
  const logFile = join(dir, `reconnect-${++n}.log`);
  const succeeded: string[] = [];
  const changes: string[] = [];
  const logs: string[] = [];
  const r = new ReconnectRunner({
    logFile,
    lookup: async (id) => (id in configs ? configs[id]! : undefined),
    onSucceeded: (id) => succeeded.push(id),
    onChange: (id) => changes.push(id),
    msPerSecond: 20,
    killGraceMs: 150,
    log: (m) => logs.push(m),
    ...over,
  });
  return { r, logFile, succeeded, changes, logs, configs };
}

describe('#244 the reconnect runner', () => {
  test('#244 exit 0: succeeded, exit code 0, the machine is read at once, and the change is published', async () => {
    const { r, succeeded, changes, configs } = runner({ 'ws-exemplo': fake('ok') });
    const started = await r.start('ws-exemplo', 'ui');
    assert.equal(started.kind, 'started');
    if (started.kind !== 'started') return;
    assert.equal(started.status.state, 'running');
    assert.equal(started.status.startedBy, 'ui');
    assert.equal(started.status.configured, true);
    await r.exited('ws-exemplo');
    const s = r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig);
    assert.equal(s.state, 'succeeded');
    assert.equal(s.exitCode, 0);
    assert.ok(s.startedAt && s.endedAt);
    assert.deepEqual(succeeded, ['ws-exemplo']);
    assert.ok(changes.length >= 2);
    assert.ok(changes.every((c) => c === 'ws-exemplo'));
  });

  test('#244 the output goes only to reconnect.log through its file descriptor, with a header and a footer from the core; mode 0600; never in the status', async () => {
    const { r, logFile, logs, configs } = runner({ 'ws-exemplo': fake('ok') });
    await r.start('ws-exemplo', 'local');
    await r.exited('ws-exemplo');
    const lines = readFileSync(logFile, 'utf8').split('\n');
    assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z ws-exemplo start \(local\)$/);
    assert.ok(lines.includes('line-out-one'), 'stdout as written, no prefix');
    assert.ok(lines.includes('line-err-two'), 'stderr into the same file');
    assert.ok(lines.some((l) => l.startsWith('no-newline-tail')));
    assert.match(lines.at(-2)!, /^\d{4}-\d\d-\d\dT[\d:.]+Z ws-exemplo end succeeded exit 0 after \d+ s$/);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
    const status = JSON.stringify(r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig));
    assert.doesNotMatch(status, /line-out-one|line-err-two|no-newline-tail/);
    assert.doesNotMatch(logs.join('\n'), /line-out-one|line-err-two|no-newline-tail/);
    assert.ok(logs.some((l) => /^reconnect \(ws-exemplo\): started/.test(l)));
    assert.ok(logs.some((l) => /^reconnect \(ws-exemplo\): succeeded/.test(l)));
  });

  test('#244 a child left in the background keeps running and writing to reconnect.log after the script exits; the core holds no pipe', async () => {
    const pidFile = join(dir, 'bg.pid');
    const { r, logFile } = runner({ 'ws-exemplo': fake('background', pidFile) });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    assert.equal(r.status('ws-exemplo', null).state, 'succeeded');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      const before = statSync(logFile).size;
      await new Promise((res) => setTimeout(res, 200));
      // Still alive (signal 0 throws if not) and still writing to the file, with nobody in the core reading.
      process.kill(pid, 0);
      assert.ok(statSync(logFile).size > before);
      assert.match(readFileSync(logFile, 'utf8'), /^bg-tick$/m);
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  test('#244 an unwritable reconnect.log: one console log line, the command still runs with its output discarded', async () => {
    const { r, logs } = runner({ 'ws-exemplo': fake('chatty') }, { logFile: join(SCRIPT, 'cannot', 'reconnect.log') });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    assert.equal(r.status('ws-exemplo', null).state, 'succeeded');
    assert.equal(logs.filter((l) => /could not (open|write)/.test(l)).length, 1);
    assert.match(logs.find((l) => /could not open/.test(l))!, /the output is discarded$/);
    assert.doesNotMatch(logs.join('\n'), /chatty line/);
  });

  test('#244 while machines.json is invalid nothing runs, even with a command in the last good reading', async () => {
    const marker = join(dir, 'invalid-file-marker');
    const { r } = runner({ 'ws-exemplo': INVALID_MACHINES_FILE });
    assert.deepEqual(await r.start('ws-exemplo', 'ui'), { kind: 'invalid-file' });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await r.cancel('ws-exemplo'), { kind: 'not-running' });
  });

  test('#244 exit 1: failed with the exit code, the machine is not read', async () => {
    const { r, succeeded, configs } = runner({ 'ws-exemplo': fake('fail') });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    const s = r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig);
    assert.equal(s.state, 'failed');
    assert.equal(s.exitCode, 1);
    assert.deepEqual(succeeded, []);
  });

  test('#244 past the timeout: timed-out, the process group is ended', async () => {
    const { r, configs } = runner({ 'ws-exemplo': { ...fake('sleep'), timeoutSeconds: 10 } });
    const t0 = Date.now();
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    assert.ok(Date.now() - t0 >= 190, 'not before the timeout');
    assert.equal(r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig).state, 'timed-out');
  });

  test('#244 a process that ignores SIGTERM gets SIGKILL after the grace', async () => {
    // 20 "seconds" of 100 ms: time for node to start and ignore SIGTERM before the timeout.
    const { r, configs } = runner({ 'ws-exemplo': { ...fake('stubborn'), timeoutSeconds: 20 } }, { msPerSecond: 100 });
    const t0 = Date.now();
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    assert.ok(Date.now() - t0 >= 2_150, 'timeout plus the grace');
    const s = r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig);
    assert.equal(s.state, 'timed-out');
    assert.equal(s.exitCode, null);
  });

  test('#244 one at a time: a second start returns the running one and spawns nothing', async () => {
    let spawned = 0;
    const { r } = runner(
      { 'ws-exemplo': { ...fake('sleep'), timeoutSeconds: 900 } },
      { onSpawn: () => spawned++ },
    );
    const [a, b] = await Promise.all([r.start('ws-exemplo', 'ui'), r.start('ws-exemplo', 'local')]);
    const c = await r.start('ws-exemplo', 'local');
    assert.equal(a.kind, 'started');
    assert.equal(b.kind, 'already-running');
    assert.equal(c.kind, 'already-running');
    if (c.kind === 'already-running') assert.equal(c.status.startedBy, 'ui');
    assert.equal(spawned, 1);
    await r.cancel('ws-exemplo');
    await r.exited('ws-exemplo');
  });

  test('#244 cancel: canceled at once, the process ends, and nothing runs when there is nothing to cancel', async () => {
    const { r, configs } = runner({ 'ws-exemplo': { ...fake('sleep'), timeoutSeconds: 900 } });
    assert.deepEqual(await r.cancel('ws-exemplo'), { kind: 'not-running' });
    await r.start('ws-exemplo', 'ui');
    const c = await r.cancel('ws-exemplo');
    assert.equal(c.kind, 'canceled');
    if (c.kind === 'canceled') assert.equal(c.status.state, 'canceled');
    await r.exited('ws-exemplo');
    assert.equal(r.status('ws-exemplo', configs['ws-exemplo'] as ReconnectConfig).state, 'canceled');
    assert.deepEqual(await r.cancel('nao-existe'), { kind: 'unknown' });
  });

  test('#244 the command sees the environment without AHRENA_CONSOLE_* and the old names, runs in the home folder, stdin closed', async () => {
    const out = join(dir, 'env.json');
    const env = { ...process.env, AHRENA_CONSOLE_PORT: '1', AHRENA_CONSOLE_DATA_DIR: '/x', AHRENA_NUCLEO_PORTA: '2', AHRENA_DADOS_DIR: '/y', AHRENA_NODE: '/z', EXAMPLE_KEEP: 'yes' };
    const { r } = runner({ 'ws-exemplo': fake('env', out) }, { env: reconnectEnv(env) });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { keys: string[]; cwd: string; stdinTty: boolean | null };
    assert.deepEqual(seen.keys.filter((k) => k.startsWith('AHRENA')), []);
    assert.ok(seen.keys.includes('EXAMPLE_KEEP'));
    assert.equal(seen.cwd, homedir());
    assert.notEqual(seen.stdinTty, true);
  });

  test('#244 reconnectEnv drops every AHRENA_CONSOLE_* and the legacy names, keeps the rest', () => {
    const env = reconnectEnv({
      PATH: '/usr/bin',
      HOME: '/home/example',
      AHRENA_CONSOLE_CORE_PORT: '1',
      AHRENA_CONSOLE_ANYTHING_NEW: '1',
      AHRENA_NUCLEO_DIR: '1',
      AHRENA_NUCLEO_PORTA: '1',
      AHRENA_NUCLEO_ENTRY: '1',
      AHRENA_DADOS_DIR: '1',
      AHRENA_NODE: '1',
      AHRENA_ORIGEM: '1',
      AHRENA_ABRIR_MENU: '1',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/example' });
  });

  test('#244 a command that does not exist: failed, exit code null, logged without the output', async () => {
    const { r, logs } = runner({ 'ws-exemplo': { command: [join(dir, 'does-not-exist')], timeoutSeconds: 10 } });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    const s = r.status('ws-exemplo', { command: [join(dir, 'does-not-exist')], timeoutSeconds: 10 });
    assert.equal(s.state, 'failed');
    assert.equal(s.exitCode, null);
    assert.ok(logs.some((l) => /reconnect \(ws-exemplo\): could not start \(ENOENT\)/.test(l)));
  });

  test('#244 the freshest config decides: unknown machine, no command, or a command removed from the file does not run', async () => {
    const marker = join(dir, 'should-not-exist');
    const configs: Record<string, ReconnectConfig | null> = { 'ws-exemplo': fake('marker', marker), 'ws-dois': null };
    const { r } = runner(configs);
    assert.deepEqual(await r.start('nao-existe', 'ui'), { kind: 'unknown' });
    assert.deepEqual(await r.start('ws-dois', 'ui'), { kind: 'not-configured' });
    configs['ws-exemplo'] = null; // the user removed the command after the screen drew the button
    assert.deepEqual(await r.start('ws-exemplo', 'ui'), { kind: 'not-configured' });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(existsSync(marker), false);
  });

  test('#244 the status of a machine never run is idle, with the configured command and timeout', () => {
    const { r } = runner({});
    assert.deepEqual(r.status('ws-exemplo', { command: ['/opt/example/connect.sh'], timeoutSeconds: 60 }), {
      configured: true,
      command: ['/opt/example/connect.sh'],
      timeoutSeconds: 60,
      state: 'idle',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      startedBy: null,
      logFile: r.logFile,
    });
    assert.deepEqual(r.status('ws-exemplo', null), {
      configured: false,
      command: null,
      timeoutSeconds: null,
      state: 'idle',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      startedBy: null,
      logFile: r.logFile,
    });
  });

  test('#244 reconnect.log is rotated when it passes the size limit', async () => {
    const { r, logFile } = runner({ 'ws-exemplo': fake('ok') }, { maxLogBytes: 64 });
    writeFileSync(logFile, 'x'.repeat(100), { mode: 0o600 });
    await r.start('ws-exemplo', 'ui');
    await r.exited('ws-exemplo');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(statSync(logFile).size < 1024);
    assert.ok(existsSync(`${logFile}.1`));
    assert.equal(statSync(`${logFile}.1`).mode & 0o777, 0o600);
  });
});
