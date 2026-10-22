// #285: opening a terminal that resumes a session, and focusing the one where it still runs. A fake
// runner records what would run: no terminal opens, no osascript runs (#285/AC-4: nothing from a cwd
// or a tty reaches a shell).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  commandFileContent,
  createTerminalFocuser,
  createTerminalOpener,
  ITERM_FOCUS_SCRIPT,
  parsePsLine,
  TERMINAL_FOCUS_SCRIPT,
  ttyDevice,
  type ProcessRunner,
} from '../../src/api/terminal-launch.ts';

const ID = '0f8c1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

interface Call {
  kind: 'run' | 'spawn';
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function fakeRunner(answer: (file: string, args: readonly string[]) => string = () => ''): ProcessRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push({ kind: 'run', file, args, env: opts?.env });
      return answer(file, args);
    },
    spawnDetached: async (file, args, opts) => void calls.push({ kind: 'spawn', file, args, cwd: opts?.cwd }),
  };
}

describe('the .command file (#285/AC-4)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-cmd-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('shebang, self-removal, the quoted cd and exec claude --resume', () => {
    assert.equal(commandFileContent('/w/app', ID), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude --resume ${ID}\n`);
  });

  test('a folder with a quote, $(…), backticks and spaces: sh changes into exactly it and runs nothing else', () => {
    const cwd = join(root, "it's $(touch pwned1) `touch pwned2` a  b");
    mkdirSync(cwd);
    // The file with `claude` swapped for `pwd`, run by a real sh: it prints the folder and creates nothing.
    const file = join(root, 'probe.sh');
    writeFileSync(file, commandFileContent(cwd, ID).replace(`exec claude --resume ${ID}`, 'pwd -P'));
    const out = execFileSync('/bin/sh', [file], { cwd: root, encoding: 'utf8' });
    assert.equal(out.trim(), execFileSync('/bin/sh', ['-c', 'cd -- "$1" && pwd -P', 'sh', cwd], { encoding: 'utf8' }).trim());
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('pwned')), [], 'no command ran');
    assert.ok(!readdirSync(root).includes('probe.sh'), 'the file removed itself');
  });

  test('a folder with a line break, a relative folder or a bad id is refused', () => {
    assert.throws(() => commandFileContent('/w/a\nb', ID));
    assert.throws(() => commandFileContent('w/a', ID));
    assert.throws(() => commandFileContent('/w/a', `${ID}; touch x`));
  });
});

describe('createTerminalOpener', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-open-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('macOS: a 0700 file in a 0700 folder, then `open <file>`; the old leftovers go', async () => {
    const dir = join(root, 'resume');
    mkdirSync(dir, { mode: 0o755 });
    const old = join(dir, 'resume-00000000-0000-4000-8000-000000000000.command');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(0), new Date(0));
    const unrelated = join(dir, 'keep.txt');
    writeFileSync(unrelated, 'x');
    utimesSync(unrelated, new Date(0), new Date(0));
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir, platform: 'darwin', runner, now: () => Date.now() });
    assert.equal(await open({ sessionId: ID, cwd: '/w/app' }), 'opened');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(runner.calls.length, 1);
    const [call] = runner.calls;
    assert.equal(call!.file, 'open');
    assert.equal(call!.args.length, 1);
    const file = call!.args[0]!;
    assert.match(file, /\/resume-[0-9a-f-]{36}\.command$/);
    assert.equal(statSync(file).mode & 0o777, 0o700);
    assert.equal(readFileSync(file, 'utf8'), commandFileContent('/w/app', ID));
    assert.ok(!readdirSync(dir).includes('resume-00000000-0000-4000-8000-000000000000.command'), 'the hour-old file is gone');
    assert.ok(readdirSync(dir).includes('keep.txt'), 'only our own files are removed');
    // Two calls, two files: the name is unique.
    await open({ sessionId: ID, cwd: '/w/app' });
    assert.notEqual(runner.calls[1]!.args[0], file);
  });

  test('macOS: a folder that is a link is refused', async () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    const link = join(root, 'linked');
    symlinkSync(target, link);
    const runner = fakeRunner();
    await assert.rejects(createTerminalOpener({ dir: link, platform: 'darwin', runner })({ sessionId: ID, cwd: '/w/app' }));
    assert.equal(runner.calls.length, 0);
  });

  test('Linux: x-terminal-emulator in the folder, the id as its own argument', async () => {
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir: root, platform: 'linux', runner, findExecutable: async (n) => (n === 'x-terminal-emulator' ? '/usr/bin/x-terminal-emulator' : null) });
    assert.equal(await open({ sessionId: ID, cwd: "/w/it's" }), 'opened');
    assert.deepEqual(runner.calls, [{ kind: 'spawn', file: '/usr/bin/x-terminal-emulator', args: ['-e', 'claude', '--resume', ID], cwd: "/w/it's" }]);
  });

  test('no terminal program, or another platform: unsupported, nothing runs', async () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      const runner = fakeRunner();
      assert.equal(await createTerminalOpener({ dir: root, platform, runner, findExecutable: async () => null })({ sessionId: ID, cwd: '/w/app' }), 'unsupported', platform);
      assert.equal(runner.calls.length, 0);
    }
  });
});

describe('createTerminalFocuser', () => {
  const proc = { pid: 4242, sessionId: ID, cwd: '/w/app', procStart: 'Tue Oct 20 04:00:34 2026' };

  test('ttyDevice: only ttys<digits>', () => {
    assert.equal(ttyDevice('ttys003'), '/dev/ttys003');
    for (const bad of ['??', '', 'ttys', 'tty003', 'ttys003 ', 'ttys003; x', '../ttys003', 'ttys0\n03', 'console', null]) assert.equal(ttyDevice(bad), null, String(bad));
  });

  test('parsePsLine: the tty and the start, whitespace collapsed', () => {
    assert.deepEqual(parsePsLine('ttys003  Tue Oct  2 04:00:34 2026   \n'), { tty: 'ttys003', start: 'Tue Oct 2 04:00:34 2026' });
    assert.deepEqual(parsePsLine(''), { tty: null, start: null });
  });

  test('macOS: ps in UTC, then osascript with the fixed script and the device as its only argument', async () => {
    const runner = fakeRunner((file) => (file === 'ps' ? 'ttys003  Tue Oct 20 04:00:34 2026\n' : 'Terminal\n'));
    assert.equal(await createTerminalFocuser({ platform: 'darwin', runner })(proc), 'focused');
    assert.deepEqual(runner.calls[0]!.args, ['-o', 'tty=', '-o', 'lstart=', '-p', '4242']);
    assert.equal(runner.calls[0]!.env?.TZ, 'UTC');
    assert.deepEqual(runner.calls[1], { kind: 'run', file: 'osascript', args: ['-e', TERMINAL_FOCUS_SCRIPT, '/dev/ttys003'], env: undefined });
    assert.equal(runner.calls.length, 2);
  });

  test('not in Terminal: tries iTerm2; in neither: not-found', async () => {
    const answers = ['', 'iTerm2'];
    const runner = fakeRunner((file) => (file === 'ps' ? 'ttys003 Tue Oct 20 04:00:34 2026' : answers.shift()!));
    assert.equal(await createTerminalFocuser({ platform: 'darwin', runner })(proc), 'focused');
    assert.equal(runner.calls[2]!.args[1], ITERM_FOCUS_SCRIPT);
    const none = fakeRunner((file) => (file === 'ps' ? 'ttys003 Tue Oct 20 04:00:34 2026' : ''));
    assert.equal(await createTerminalFocuser({ platform: 'darwin', runner: none })(proc), 'not-found');
  });

  test('a tty that is not ttys<digits> never reaches osascript', async () => {
    for (const tty of ['??', 'console', 'ttys003;x']) {
      const runner = fakeRunner((file) => (file === 'ps' ? `${tty} Tue Oct 20 04:00:34 2026` : 'Terminal'));
      assert.equal(await createTerminalFocuser({ platform: 'darwin', runner })(proc), 'not-found', tty);
      assert.ok(!runner.calls.some((c) => c.file === 'osascript'), tty);
    }
  });

  test('a recycled pid (another start) is not the session: stale', async () => {
    const runner = fakeRunner((file) => (file === 'ps' ? 'ttys003 Wed Oct 21 09:00:00 2026' : 'Terminal'));
    assert.equal(await createTerminalFocuser({ platform: 'darwin', runner })(proc), 'stale');
    assert.ok(!runner.calls.some((c) => c.file === 'osascript'));
  });

  test('ps exiting with 1 (no such process): stale; another platform: not-found; nothing else runs', async () => {
    const gone = Object.assign(new Error('Command failed: ps'), { code: 1 });
    const failing: ProcessRunner = { run: async () => Promise.reject(gone), spawnDetached: async () => undefined };
    assert.equal(await createTerminalFocuser({ platform: 'darwin', runner: failing })(proc), 'stale');
    const runner = fakeRunner();
    assert.equal(await createTerminalFocuser({ platform: 'linux', runner })(proc), 'not-found');
    assert.equal(runner.calls.length, 0);
  });

  test('ps failing for another reason (timeout, spawn error, signal): not-found, so a running session is never resumed', async () => {
    const failures = [
      Object.assign(new Error('timed out'), { killed: true, code: null, signal: 'SIGTERM' }),
      Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }),
      Object.assign(new Error('spawn ps EAGAIN'), { code: 'EAGAIN' }),
      new Error('no code at all'),
    ];
    for (const failure of failures) {
      const runner: ProcessRunner = { run: async () => Promise.reject(failure), spawnDetached: async () => undefined };
      assert.equal(await createTerminalFocuser({ platform: 'darwin', runner })(proc), 'not-found', failure.message);
    }
  });
});
