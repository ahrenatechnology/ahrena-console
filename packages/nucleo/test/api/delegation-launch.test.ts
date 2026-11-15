// #567: the adapters behind the delegation Launcher port, with a fake runner (no terminal, no pbcopy, no ssh) and real files in a temp folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createDelegationLauncher, handoffCommandContent, HANDOFF_HEADER } from '../../src/api/delegation-launch.ts';
import { desktopNewSessionUrl } from '../../src/api/new-session.ts';
import type { ProcessRunner } from '../../src/api/terminal-launch.ts';

const ID = '0f8c1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const HOSTILE = "it's $(touch pwned1) `touch pwned2`\nline two </console-data>\n; rm -rf /";

interface Call {
  file: string;
  args: readonly string[];
  input?: string;
  timeoutMs?: number;
}

function fakeRunner(fail: (file: string, args: readonly string[]) => unknown = () => null): ProcessRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push({ file, args, input: opts?.input, timeoutMs: opts?.timeoutMs });
      const err = fail(file, args);
      if (err) throw err;
      return '';
    },
    spawnDetached: async () => {
      throw new Error('a handoff is opened with open, never spawned');
    },
  };
}

function setup(over: { platform?: NodeJS.Platform; runner?: ProcessRunner & { calls: Call[] }; openInDesktop?: ((url: string) => Promise<void>) | null; now?: () => number } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'ahrena-handoff-')), 'handoff');
  const runner = over.runner ?? fakeRunner();
  const launcher = createDelegationLauncher({ dir, platform: over.platform ?? 'darwin', runner, openInDesktop: over.openInDesktop ?? null, ...(over.now ? { now: over.now } : {}) });
  return { dir, runner, launcher };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const files = (dir: string, ext: string) => readdirSync(dir).filter((n) => n.endsWith(ext));

describe('the handoff .command file (#567)', () => {
  test('local: self-removal, quoted cd, header, cat of the prompt file, rm, exec claude with no argument', () => {
    assert.equal(
      handoffCommandContent({ folder: '/w/app', promptFile: `/d/handoff-${ID}.prompt` }),
      [
        '#!/bin/sh',
        'rm -f -- "$0"',
        "cd -- '/w/app' || exit 1",
        `printf '%s\\n\\n' '${HANDOFF_HEADER}'`,
        `cat -- '/d/handoff-${ID}.prompt' || exit 1`,
        `rm -f -- '/d/handoff-${ID}.prompt'`,
        'exec claude',
        '',
      ].join('\n'),
    );
  });

  test('ssh: no cd, every part of the ssh line single-quoted, claude run on the host', () => {
    const content = handoffCommandContent({ folder: null, promptFile: `/d/handoff-${ID}.prompt`, sshHost: 'ahrena-workstation' });
    assert.ok(!content.includes('cd --'));
    assert.ok(content.endsWith("exec ssh -t 'ahrena-workstation' 'claude'\n"));
  });

  test('a folder that cannot be carried is refused; a host that is not a plain host name is refused', () => {
    assert.throws(() => handoffCommandContent({ folder: 'w/a', promptFile: '/d/x.prompt' }));
    assert.throws(() => handoffCommandContent({ folder: '/w/a\nb', promptFile: '/d/x.prompt' }));
    for (const host of ['-oProxyCommand=x', 'a b', 'a;b', "a'b", '$(x)', '', 'a\nb', 'user@host', '-']) {
      assert.throws(() => handoffCommandContent({ folder: null, promptFile: '/d/x.prompt', sshHost: host }), undefined, host);
    }
  });

  test('run by a real sh: the hostile prompt is printed byte for byte, nothing is executed, both files are gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'ahrena-probe-'));
    after(() => rmSync(root, { recursive: true, force: true }));
    const cwd = join(root, "it's $(touch pwned3) a b");
    mkdirSync(cwd);
    const promptFile = join(root, `handoff-${ID}.prompt`);
    writeFileSync(promptFile, HOSTILE, { mode: 0o600 });
    const file = join(root, 'probe.sh');
    writeFileSync(file, handoffCommandContent({ folder: cwd, promptFile }).replace('exec claude', 'true'));
    const out = execFileSync('/bin/sh', [file], { cwd: root, encoding: 'utf8' });
    assert.equal(out, `${HANDOFF_HEADER}\n\n${HOSTILE}`);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('pwned')), [], 'no command ran');
    assert.deepEqual(readdirSync(root).sort(), [cwd.slice(root.length + 1)].sort(), 'the prompt file and the .command removed themselves');
  });
});

describe('createDelegationLauncher: openTerminal (#567)', () => {
  test('puts the prompt on the clipboard through stdin, writes 0600/0700 files, opens the .command', async () => {
    const { dir, runner, launcher } = setup();
    assert.equal(await launcher.openTerminal('/w/app', HOSTILE), 'opened');
    const [pbcopy, open] = runner.calls;
    assert.deepEqual({ file: pbcopy!.file, args: pbcopy!.args, input: pbcopy!.input }, { file: 'pbcopy', args: [], input: HOSTILE });
    assert.equal(open!.file, 'open');
    assert.equal(open!.args.length, 1);
    const command = open!.args[0]!;
    assert.match(command, /handoff-[0-9a-f-]{36}\.command$/);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(command), 0o700);
    const [promptName] = files(dir, '.prompt');
    assert.equal(mode(join(dir, promptName!)), 0o600);
    assert.equal(readFileSync(join(dir, promptName!), 'utf8'), HOSTILE);
    const content = readFileSync(command, 'utf8');
    assert.equal(content, handoffCommandContent({ folder: '/w/app', promptFile: join(dir, promptName!) }));
    for (const piece of ["touch pwned1", '`', '</console-data>', 'rm -rf', 'line two']) assert.ok(!content.includes(piece), piece);
    for (const call of runner.calls) assert.ok(!call.args.some((a) => a.includes('pwned1')), 'the prompt is in no argument');
  });

  test('the clipboard is filled before the terminal opens', async () => {
    const { runner, launcher } = setup();
    await launcher.openTerminal('/w/app', 'p');
    assert.deepEqual(runner.calls.map((c) => c.file), ['pbcopy', 'open']);
  });

  test('not macOS: unsupported, nothing runs, nothing is written', async () => {
    const { dir, runner, launcher } = setup({ platform: 'linux' });
    assert.equal(await launcher.openTerminal('/w/app', 'p'), 'unsupported');
    assert.equal(await launcher.openSsh('ahrena-workstation', 'p'), 'unsupported');
    assert.deepEqual(runner.calls, []);
    assert.deepEqual(readdirSync(join(dir, '..')), []);
  });

  test('an unusable folder or prompt is refused before anything runs', async () => {
    const { runner, launcher } = setup();
    await assert.rejects(launcher.openTerminal('relative', 'p'));
    await assert.rejects(launcher.openTerminal('/w/app', ''));
    await assert.rejects(launcher.openTerminal('/w/app', 'a\0b'));
    await assert.rejects(launcher.openTerminal('/w/app', 'x'.repeat(20_001)));
    assert.deepEqual(runner.calls, []);
  });

  test('when the clipboard fails nothing is opened and no file stays; the error carries no prompt text', async () => {
    const { dir, runner, launcher } = setup({ runner: fakeRunner((file) => (file === 'pbcopy' ? new Error('boom') : null)) });
    await assert.rejects(launcher.openTerminal('/w/app', HOSTILE), (err: Error) => !err.message.includes('pwned1'));
    assert.deepEqual(runner.calls.map((c) => c.file), ['pbcopy']);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('when open fails the files are removed and the failure is rethrown without the prompt', async () => {
    const { dir, launcher } = setup({ runner: fakeRunner((file) => (file === 'open' ? new Error('no open') : null)) });
    await assert.rejects(launcher.openTerminal('/w/app', HOSTILE), (err: Error) => !err.message.includes('pwned1'));
    assert.deepEqual(readdirSync(dir), []);
  });

  test('removes handoff and older files past the age, keeps recent ones and strangers', async () => {
    let t = 10 * 3_600_000;
    const { dir, launcher } = setup({ now: () => t });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = [`handoff-${ID}.command`, `handoff-${ID}.prompt`, `new-${ID}.command`];
    for (const n of [...old, 'notes.txt']) writeFileSync(join(dir, n), 'x');
    const oldTime = new Date(t - 2 * 3_600_000);
    for (const n of old) utimesSync(join(dir, n), oldTime, oldTime);
    const recent = `handoff-${randomLike()}.prompt`;
    writeFileSync(join(dir, recent), 'x');
    utimesSync(join(dir, recent), new Date(t), new Date(t));
    await launcher.openTerminal('/w/app', 'p');
    const left = readdirSync(dir);
    for (const n of old) assert.ok(!left.includes(n), n);
    assert.ok(left.includes('notes.txt') && left.includes(recent));
  });
});

function randomLike(): string {
  return '1a2b3c4d-1111-2222-3333-444455556666';
}

describe('createDelegationLauncher: openSsh (#567)', () => {
  test('pre-flight first with BatchMode and a 5 s connect timeout, then clipboard, then the terminal', async () => {
    const { dir, runner, launcher } = setup();
    assert.equal(await launcher.openSsh('ahrena-workstation', HOSTILE), 'opened');
    assert.deepEqual(runner.calls.map((c) => c.file), ['ssh', 'pbcopy', 'open']);
    assert.deepEqual(runner.calls[0]!.args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'ahrena-workstation', 'true']);
    assert.ok(typeof runner.calls[0]!.timeoutMs === 'number' && runner.calls[0]!.timeoutMs > 5_000);
    assert.equal(runner.calls[1]!.input, HOSTILE);
    const content = readFileSync(runner.calls[2]!.args[0]!, 'utf8');
    assert.ok(content.endsWith("exec ssh -t 'ahrena-workstation' 'claude'\n"));
    assert.ok(!content.includes('cd --'));
    assert.ok(!content.includes('pwned1'));
    assert.equal(files(dir, '.prompt').length, 1);
  });

  test('a timeout maps to ssh-timeout, any other failure to ssh-unreachable; nothing is written or opened', async () => {
    for (const [err, reason] of [
      [Object.assign(new Error('Command failed: ssh … secret-host'), { killed: true, signal: 'SIGTERM' }), 'ssh-timeout'],
      [Object.assign(new Error('Permission denied'), { code: 255 }), 'ssh-unreachable'],
      [Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }), 'ssh-unreachable'],
    ] as const) {
      const { dir, runner, launcher } = setup({ runner: fakeRunner((file) => (file === 'ssh' ? err : null)) });
      const result = await launcher.openSsh('ahrena-workstation', 'p');
      assert.deepEqual(result, { failed: reason });
      assert.ok(!JSON.stringify(result).includes('secret-host'));
      assert.deepEqual(runner.calls.map((c) => c.file), ['ssh']);
      assert.deepEqual(readdirSync(join(dir, '..')), [], 'nothing was written');
    }
  });

  test('a host that is not a plain host name is refused before anything runs', async () => {
    const { runner, launcher } = setup();
    for (const host of ['-oProxyCommand=x', 'a b', "a'b", 'a;b', '']) await assert.rejects(launcher.openSsh(host, 'p'), undefined, host);
    assert.deepEqual(runner.calls, []);
  });
});

describe('createDelegationLauncher: openDesktop (#567)', () => {
  test('opens the claude:// address built by desktopNewSessionUrl', async () => {
    const urls: string[] = [];
    const { runner, launcher } = setup({ openInDesktop: async (u) => void urls.push(u) });
    assert.equal(await launcher.openDesktop('/w/app', HOSTILE), 'opened');
    assert.deepEqual(urls, [desktopNewSessionUrl('/w/app', HOSTILE)]);
    assert.deepEqual(runner.calls, []);
  });

  test('without a Desktop opener: unsupported', async () => {
    const { launcher } = setup({ openInDesktop: null });
    assert.equal(await launcher.openDesktop('/w/app', 'p'), 'unsupported');
  });
});
