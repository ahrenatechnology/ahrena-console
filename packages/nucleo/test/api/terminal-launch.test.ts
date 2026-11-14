// #285: opening a terminal that resumes a session, and focusing the one where it still runs. A fake
// runner records what would run: no terminal opens, no osascript runs (#285/AC-4: nothing from a cwd
// or a tty reaches a shell).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  PLANNING_TOOL_FLAGS,
  TERMINAL_FOCUS_SCRIPT,
  ttyDevice,
  type ProcessRunner,
} from '../../src/api/terminal-launch.ts';
import { executionPrompt } from '../../src/github/work-execution.ts';
import { planningPrompt } from '../../src/github/work-plan.ts';

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

  test('no session: exec claude, a new one', () => {
    assert.equal(commandFileContent('/w/app', null), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude\n`);
    assert.throws(() => commandFileContent('w/a', null));
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

  test('macOS, no session: a new-<uuid>.command running claude; the old new- leftovers go too', async () => {
    const dir = join(root, 'new');
    mkdirSync(dir);
    const old = join(dir, 'new-00000000-0000-4000-8000-000000000000.command');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(0), new Date(0));
    const runner = fakeRunner();
    assert.equal(await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: null, cwd: '/w/app' }), 'opened');
    const file = runner.calls[0]!.args[0]!;
    assert.match(file, /\/new-[0-9a-f-]{36}\.command$/);
    assert.equal(readFileSync(file, 'utf8'), commandFileContent('/w/app', null));
    assert.ok(!readdirSync(dir).includes('new-00000000-0000-4000-8000-000000000000.command'), 'the hour-old file is gone');
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

  test('Linux, no session: claude with no arguments', async () => {
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir: root, platform: 'linux', runner, findExecutable: async () => '/usr/bin/x-terminal-emulator' });
    assert.equal(await open({ sessionId: null, cwd: '/w/app' }), 'opened');
    assert.deepEqual(runner.calls, [{ kind: 'spawn', file: '/usr/bin/x-terminal-emulator', args: ['-e', 'claude'], cwd: '/w/app' }]);
  });

  test('no terminal program, or another platform: unsupported, nothing runs', async () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      const runner = fakeRunner();
      assert.equal(await createTerminalOpener({ dir: root, platform, runner, findExecutable: async () => null })({ sessionId: ID, cwd: '/w/app' }), 'unsupported', platform);
      assert.equal(runner.calls.length, 0);
    }
  });
});

describe('#507/AC-6 a terminal that starts claude with a first prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-open-prompt-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const HOSTILE = ['$(touch HIT1)', '`touch HIT2`', "it's", 'say "hi"; touch HIT3', 'a | b && c', '\\n \\$HOME', 'line one\nline two\n', '*', '--help'].join(' ');

  test('#507/AC-6 macOS: the prompt is its own 0600 file, and the .command only names that file', async () => {
    const dir = join(root, 'mac');
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir, platform: 'darwin', runner });
    assert.equal(await open({ sessionId: null, cwd: '/w/app', prompt: HOSTILE }), 'opened');
    const file = runner.calls[0]!.args[0]!;
    const names = readdirSync(dir);
    const promptName = names.find((n) => /^new-[0-9a-f-]{36}\.prompt$/.test(n));
    assert.ok(promptName, 'a prompt file next to the .command');
    assert.equal(statSync(join(dir, promptName)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, promptName), 'utf8'), HOSTILE);
    const content = readFileSync(file, 'utf8');
    assert.equal(content, commandFileContent('/w/app', null, join(dir, promptName)));
    for (const piece of ['HIT1', 'HIT2', 'HIT3', 'line one', "it's"]) assert.ok(!content.includes(piece), `the .command does not carry ${piece}`);
    assert.match(content, /exec claude "\$prompt"/);
  });

  test('#507/AC-6 macOS: run for real with a hostile prompt, claude gets it as one argument and nothing runs', async () => {
    const dir = join(root, 'real');
    const bin = join(root, 'bin');
    const out = join(root, 'argv.txt');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s' "$#" > '${out}.count'\nprintf '%s' "$1" > '${out}'\n`, { mode: 0o755 });
    const work = join(root, 'work');
    mkdirSync(work);
    const hostile = HOSTILE.replaceAll('HIT', join(root, 'hit'));
    const runner = fakeRunner();
    await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: null, cwd: work, prompt: hostile });
    const file = runner.calls[0]!.args[0]!;
    execFileSync('/bin/sh', [file], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(readFileSync(`${out}.count`, 'utf8'), '1');
    assert.equal(readFileSync(out, 'utf8'), hostile.replace(/\n+$/, ''), 'the shell strips only trailing newlines');
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('hit')), [], 'no command from the prompt ran');
    assert.deepEqual(readdirSync(dir), [], 'the .command and the prompt file removed themselves');
  });

  test('#507/AC-6 a prompt that starts with a dash, holds a NUL, or is too long is refused, nothing is written', async () => {
    const dir = join(root, 'refused');
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir, platform: 'darwin', runner });
    for (const prompt of ['--dangerously-skip-permissions', '-p x', 'a\0b', '', 'x'.repeat(20_001)]) await assert.rejects(open({ sessionId: null, cwd: '/w/app', prompt }), String(prompt).slice(0, 10));
    await assert.rejects(open({ sessionId: ID, cwd: '/w/app', prompt: 'resume with a prompt' }));
    assert.equal(runner.calls.length, 0);
  });

  test('#507/AC-6 Linux: a prompt is never passed through x-terminal-emulator, which may re-parse it: unsupported', async () => {
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir: root, platform: 'linux', runner, findExecutable: async () => '/usr/bin/x-terminal-emulator' });
    assert.equal(await open({ sessionId: null, cwd: '/w/app', prompt: 'plan it' }), 'unsupported');
    assert.equal(runner.calls.length, 0);
  });

  test('the old leftovers of prompt files go too', async () => {
    const dir = join(root, 'old');
    mkdirSync(dir);
    const old = join(dir, 'new-00000000-0000-4000-8000-000000000000.prompt');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(0), new Date(0));
    await createTerminalOpener({ dir, platform: 'darwin', runner: fakeRunner() })({ sessionId: null, cwd: '/w/app', prompt: 'plan it' });
    assert.ok(!readdirSync(dir).includes('new-00000000-0000-4000-8000-000000000000.prompt'));
  });
});

describe('#515 a planning session started from the terminal runs with a tool restriction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-open-515-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const PLAN = planningPrompt({ repo: 'acme/app', number: 1 });
  const ALLOWED = 'Read,Grep,Glob,Skill,Agent,Bash(gh issue view:*),Bash(gh issue list:*),Bash(gh issue create:*),Bash(gh issue edit:*),Bash(gh api:*)';
  const DENIED_FAMILIES = [
    'Edit', 'Write', 'NotebookEdit', 'mcp__*',
    'Bash(git:*)', 'Bash(gh pr:*)', 'Bash(gh stack:*)', 'Bash(gh secret:*)', 'Bash(gh repo:*)', 'Bash(gh release:*)', 'Bash(gh workflow:*)',
    'Bash(gh issue delete:*)', 'Bash(gh issue transfer:*)', 'Bash(gh issue close:*)', 'Bash(gh issue reopen:*)', 'Bash(gh issue lock:*)', 'Bash(gh issue pin:*)', 'Bash(gh issue develop:*)',
    'Bash(gh run:*)', 'Bash(gh variable:*)', 'Bash(gh gist:*)', 'Bash(gh label:*)', 'Bash(gh auth:*)', 'Bash(gh ssh-key:*)', 'Bash(gh extension:*)', 'Bash(gh alias:*)', 'Bash(gh ruleset:*)', 'Bash(gh cache:*)', 'Bash(gh codespace:*)',
  ];
  const DENIED = DENIED_FAMILIES.join(',');

  test('#515/AC-1 the flags are exactly the approved ones, in order', () => {
    assert.deepEqual([...PLANNING_TOOL_FLAGS], ['--permission-mode', 'dontAsk', '--allowedTools', ALLOWED, '--disallowedTools', DENIED]);
  });

  test('#515/AC-1 every denied family is in the deny value, and no MCP server is reachable (mcp__* deny)', () => {
    const denied = PLANNING_TOOL_FLAGS[PLANNING_TOOL_FLAGS.indexOf('--disallowedTools') + 1]!.split(',');
    for (const t of DENIED_FAMILIES) assert.ok(denied.includes(t), t);
    assert.ok(!denied.some((t) => t.startsWith('Bash(git ')), 'all git is one entry, Bash(git:*), not a list of verbs');
    assert.ok(!PLANNING_TOOL_FLAGS.includes('--strict-mcp-config'), 'the documented mcp__* deny is the choice');
  });

  test('#515/AC-1 commandFileContent with the restriction: exact string, each flag single-quoted before the prompt', () => {
    const quoted = PLANNING_TOOL_FLAGS.map((f) => `'${f}'`).join(' ');
    assert.equal(
      commandFileContent('/w/app', null, '/d/new-x.prompt', PLANNING_TOOL_FLAGS),
      `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nprompt=$(cat -- '/d/new-x.prompt') || exit 1\nrm -f -- '/d/new-x.prompt'\nexec claude ${quoted} -- "$prompt"\n`,
    );
    assert.match(quoted, /^'--permission-mode' 'dontAsk' '--allowedTools' 'Read,/);
  });

  test('without the restriction the .command is byte-identical to before', () => {
    assert.equal(commandFileContent('/w/app', null, '/d/new-x.prompt'), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nprompt=$(cat -- '/d/new-x.prompt') || exit 1\nrm -f -- '/d/new-x.prompt'\nexec claude "$prompt"\n`);
    assert.ok(!commandFileContent('/w/app', null, '/d/new-x.prompt').includes(' -- "$prompt"'));
    assert.equal(commandFileContent('/w/app', null, '/d/new-x.prompt', []), commandFileContent('/w/app', null, '/d/new-x.prompt'));
  });

  test('#515/AC-1 the opener, given a planning prompt, writes a .command with the permission mode and the denied list', async () => {
    const dir = join(root, 'plan');
    const runner = fakeRunner();
    assert.equal(await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: null, cwd: '/w/app', prompt: PLAN }), 'opened');
    const content = readFileSync(runner.calls[0]!.args[0]!, 'utf8');
    assert.ok(content.includes("'--permission-mode' 'dontAsk'"));
    assert.ok(content.includes(`'--disallowedTools' '${DENIED}'`));
    assert.match(content, /'--disallowedTools' '[^']*' -- "\$prompt"\n$/);
  });

  test('another prompt (execution, plain) gets no restriction', async () => {
    for (const prompt of [executionPrompt({ repo: 'acme/app', number: 1, steps: [2, 3] }), 'just a prompt']) {
      const dir = join(root, `other-${randomUUID()}`);
      const runner = fakeRunner();
      await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: null, cwd: '/w/app', prompt });
      const content = readFileSync(runner.calls[0]!.args[0]!, 'utf8');
      assert.ok(!content.includes('--permission-mode') && !content.includes('--allowedTools') && !content.includes('--disallowedTools'));
      assert.match(content, /\nexec claude "\$prompt"\n$/);
    }
  });

  test('#515/AC-2 the allowed list keeps reading the issue and creating Plan sub-issues; the denied list blocks edits', () => {
    const allowed = PLANNING_TOOL_FLAGS[PLANNING_TOOL_FLAGS.indexOf('--allowedTools') + 1]!.split(',');
    const denied = PLANNING_TOOL_FLAGS[PLANNING_TOOL_FLAGS.indexOf('--disallowedTools') + 1]!.split(',');
    for (const t of ['Read', 'Skill', 'Agent', 'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue create:*)', 'Bash(gh issue edit:*)', 'Bash(gh api:*)']) assert.ok(allowed.includes(t), t);
    for (const t of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(t), t);
    assert.ok(!allowed.some((t) => denied.includes(t)), 'no tool is both allowed and denied');
  });

  test('#515/AC-1 run for real: claude gets the flags in order, then the planning prompt as the last single argument', async () => {
    const dir = join(root, 'real');
    const bin = join(root, 'bin');
    const out = join(root, 'argv.txt');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s' "$#" > '${out}.count'\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${out}'\n`, { mode: 0o755 });
    const work = join(root, 'work');
    mkdirSync(work);
    const hostile = `${PLAN}\n$(touch ${join(root, 'hit')}) \`touch ${join(root, 'hit2')}\` it's`;
    const runner = fakeRunner();
    await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: null, cwd: work, prompt: hostile });
    execFileSync('/bin/sh', [runner.calls[0]!.args[0]!], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(readFileSync(`${out}.count`, 'utf8'), '8');
    const argv = readFileSync(out, 'utf8').split('\0').slice(0, -1);
    assert.deepEqual(argv.slice(0, 6), [...PLANNING_TOOL_FLAGS]);
    assert.equal(argv[6], '--');
    assert.equal(argv[7], hostile.replace(/\n+$/, ''));
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('hit')), [], 'nothing from the prompt ran');
  });
});

describe('#515 a planning session resumed in the terminal keeps the restriction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-resume-515-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const quoted = PLANNING_TOOL_FLAGS.map((f) => `'${f}'`).join(' ');

  test('#515/AC-1 commandFileContent resuming with the restriction: --resume first, then the quoted flags, nothing after', () => {
    assert.equal(commandFileContent('/w/app', ID, undefined, PLANNING_TOOL_FLAGS), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude --resume ${ID} ${quoted}\n`);
  });

  test('#515/AC-1 macOS: the opener, given planning, writes the flags into the resume .command', async () => {
    const dir = join(root, 'mac');
    const runner = fakeRunner();
    assert.equal(await createTerminalOpener({ dir, platform: 'darwin', runner })({ sessionId: ID, cwd: '/w/app', planning: true }), 'opened');
    assert.equal(readFileSync(runner.calls[0]!.args[0]!, 'utf8'), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude --resume ${ID} ${quoted}\n`);
  });

  test('#515/AC-1 Linux: a planning resume is unsupported and spawns nothing (the emulator may re-parse the flags through a shell, as in #507)', async () => {
    const runner = fakeRunner();
    const open = createTerminalOpener({ dir: join(root, 'lin'), platform: 'linux', runner, findExecutable: async () => '/usr/bin/x-terminal-emulator' });
    assert.equal(await open({ sessionId: ID, cwd: '/w/app', planning: true }), 'unsupported');
    assert.deepEqual(runner.calls, []);
  });

  test('resuming any other session is byte-identical to before', async () => {
    const runner = fakeRunner();
    await createTerminalOpener({ dir: join(root, 'plain'), platform: 'darwin', runner })({ sessionId: ID, cwd: '/w/app' });
    assert.equal(readFileSync(runner.calls[0]!.args[0]!, 'utf8'), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude --resume ${ID}\n`);
    const lin = fakeRunner();
    await createTerminalOpener({ dir: join(root, 'plain2'), platform: 'linux', runner: lin, findExecutable: async () => '/usr/bin/x' })({ sessionId: ID, cwd: '/w/app', planning: false });
    assert.deepEqual(lin.calls[0]!.args, ['-e', 'claude', '--resume', ID]);
  });

  test('planning on a new session without a prompt is refused to carry flags: no flags without a resume or a planning prompt', () => {
    assert.equal(commandFileContent('/w/app', null), `#!/bin/sh\nrm -f -- "$0"\ncd -- '/w/app' || exit 1\nexec claude\n`);
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
