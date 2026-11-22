/*
 * The CPU governor's commands (#723, #720): the argv each change runs, and what each outcome of the tool means. A double of
 * the exec stands where `execFile` stands, so no real `renice` or `taskpolicy` runs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMachineControl, outcomeOf, type Exec, type ExecResult } from './system.ts';
import type { RegisteredSession, SessionTree } from '../../diagnosis/attribution.ts';

const START = 'Sat Nov 21 22:00:00 2026';
const PS_TREE = [`  100     1  1.0 ${START} claude --resume abc`, `  101   100  2.0 ${START} node /work/x.js`, `  200     1  0.0 ${START} /Applications/Claude.app/Contents/MacOS/Claude`].join('\n');
const PS_NICE = ['  100   0 /Users/x/Library/Application Support/Claude/claude-code/2.1.326/h/claude.app/Contents/MacOS/claude', '  101   0 /usr/local/bin/node', '  200   0 /Applications/Claude.app/Contents/MacOS/Claude'].join('\n');

function setup(answers: Record<string, ExecResult> = {}, platform: 'darwin' | 'linux' = 'darwin') {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    return answers[key] ?? { ok: true, stdout: '' };
  };
  const registry: RegisteredSession[] = [{ pid: 100, sessionId: 's1', cwd: null, procStart: START }];
  const control = createMachineControl({ exec, platform, registered: async () => registry, startCheck: async () => (entry, real) => entry.procStart === real.start });
  return { calls, control };
}

const PS_TREE_CMD = 'ps -axo pid=,ppid=,pcpu=,lstart=,args=';
const PS_NICE_CMD = 'ps -axo pid=,nice=,comm=';

describe('#720/AC-5 only renice and taskpolicy, fixed argv, no shell, no sudo', () => {
  test('#720/AC-3 Given renice, Then the argv is the absolute `renice 10 -p <pid>`', async () => {
    const { calls, control } = setup();
    await control.renice(101);
    assert.deepEqual(calls, [['renice', '10', '-p', '101']]);
  });

  test('#720/AC-4 Given background and foreground, Then the argv is `taskpolicy -b -p <pid>` and `taskpolicy -B -p <pid>`', async () => {
    const { calls, control } = setup();
    await control.background(101);
    await control.foreground(101);
    assert.deepEqual(calls, [['taskpolicy', '-b', '-p', '101'], ['taskpolicy', '-B', '-p', '101']]);
  });

  test('#720/AC-4 Given a machine that is not darwin, Then taskpolicy is never run', async () => {
    const { calls, control } = setup({}, 'linux');
    assert.equal(await control.background(101), 'failed');
    assert.equal(await control.foreground(101), 'failed');
    assert.deepEqual(calls, []);
  });

  test('#720/AC-5 Given any pid that is not a positive integer, Then no command runs', async () => {
    const { calls, control } = setup();
    for (const pid of [0, -1, 1.5, Number.NaN, 1e12]) assert.equal(await control.renice(pid), 'failed');
    assert.deepEqual(calls, []);
  });

  test('#720/AC-5 Given any change, Then no command is sudo and none goes through a shell', async () => {
    const { calls, control } = setup();
    await control.renice(101);
    await control.background(101);
    await control.foreground(101);
    for (const [file] of calls) assert.ok(file === 'renice' || file === 'taskpolicy', file);
  });
});

describe('#720/AC-5 the outcome of a tool, never its text', () => {
  test('#720/AC-5 Given permission denied, no such process or any other failure, Then the outcome is denied, gone or failed', () => {
    assert.equal(outcomeOf('renice: failed to set priority for 101 (process ID): Operation not permitted'), 'denied');
    assert.equal(outcomeOf('renice: failed to set priority for 101 (process ID): Permission denied'), 'denied');
    assert.equal(outcomeOf('renice: failed to get priority for 101 (process ID): No such process'), 'gone');
    assert.equal(outcomeOf('something else'), 'failed');
  });

  test('#720/AC-5 Given exec reporting denied, Then renice answers denied', async () => {
    const { control } = setup({ 'renice 10 -p 101': { ok: false, outcome: 'denied' } });
    assert.equal(await control.renice(101), 'denied');
  });
});

describe('#720/AC-3 the sample: session trees from the attribution, the nice of each pid', () => {
  test('#720/AC-3 Given the machine, Then the trees hold only the descendants of a registered session and the nice map every pid', async () => {
    const { control } = setup({ [PS_TREE_CMD]: { ok: true, stdout: PS_TREE }, [PS_NICE_CMD]: { ok: true, stdout: PS_NICE } });
    const observation = await control.sample();
    const trees: readonly SessionTree[] = observation!.trees;
    assert.deepEqual(trees.map((t) => [t.sessionId, t.processes.map((p) => p.pid)]), [['s1', [100, 101]]]);
    assert.equal(observation!.nice.get(101), 0);
  });

  test('#720/AC-5 Given ps comm with a path that holds spaces, Then the executable is the rest of the line and the nice is read before it', async () => {
    const { control } = setup({ [PS_TREE_CMD]: { ok: true, stdout: PS_TREE }, [PS_NICE_CMD]: { ok: true, stdout: PS_NICE } });
    const observation = await control.sample();
    assert.equal(observation!.executables.get(100), '/Users/x/Library/Application Support/Claude/claude-code/2.1.326/h/claude.app/Contents/MacOS/claude');
    assert.equal(observation!.executables.get(101), '/usr/local/bin/node');
    assert.equal(observation!.nice.get(100), 0);
    assert.equal(observation!.nice.size, 3);
  });

  test('#720/AC-3 Given ps that answers nothing, Then there is no observation', async () => {
    const { control } = setup({ [PS_TREE_CMD]: { ok: false, outcome: 'failed' } });
    assert.equal(await control.sample(), null);
  });

  test('#720/AC-5 Given a pid, Then inspect answers its current start from `ps -o lstart= -p <pid>`, or null when gone', async () => {
    const { calls, control } = setup({ 'ps -o lstart= -p 101': { ok: true, stdout: ` ${START}\n` }, 'ps -o lstart= -p 102': { ok: false, outcome: 'failed' } });
    assert.deepEqual(await control.inspect(101), { start: START });
    assert.equal(await control.inspect(102), null);
    assert.deepEqual(calls[0], ['ps', '-o', 'lstart=', '-p', '101']);
  });
});

describe('#720/AC-3 on Linux the real executable of each registered root is read from /proc, not from comm', () => {
  const CONFIG = '/home/someone/.claude';
  const IMAGE = `${CONFIG}/remote/ccd-cli/2.1.326-3eec682dec28`;
  const linux = (readImage: (pid: number) => Promise<string | null>, platform: 'darwin' | 'linux' = 'linux', realpath?: (path: string) => Promise<string>) => {
    const exec: Exec = async (file, args) => {
      const key = [file, ...args].join(' ');
      if (key === PS_TREE_CMD) return { ok: true, stdout: PS_TREE };
      if (key === PS_NICE_CMD) return { ok: true, stdout: ['  100   0 2.1.326-3eec682', '  101   0 node', '  200   0 claude-desktop'].join('\n') };
      return { ok: true, stdout: '' };
    };
    const registry: RegisteredSession[] = [{ pid: 100, sessionId: 's1', cwd: null, procStart: START, configDir: CONFIG }];
    return createMachineControl({ exec, platform, registered: async () => registry, startCheck: async () => (entry, real) => entry.procStart === real.start, readImage, realpath });
  };

  test('#720/AC-3 Given a Linux root registered in a config folder, Then its origin carries that folder and the executable read for its pid', async () => {
    const asked: number[] = [];
    const observation = await linux(async (pid) => (asked.push(pid), IMAGE)).sample();
    assert.deepEqual(observation!.origins.get(100), { configDir: CONFIG, image: IMAGE });
    assert.deepEqual(asked, [100]);
  });

  test('#720/AC-5 Given an executable that cannot be read, Then the origin has the folder and no image', async () => {
    const observation = await linux(async () => null).sample();
    assert.deepEqual(observation!.origins.get(100), { configDir: CONFIG });
  });

  test('#720/AC-5 Given a Mac, Then no executable is read from /proc', async () => {
    let read = 0;
    const observation = await linux(async () => (read++, IMAGE), 'darwin').sample();
    assert.equal(read, 0);
    assert.deepEqual(observation!.origins.get(100), { configDir: CONFIG });
  });

  test('#720/AC-3 Given a config folder that is a symlink, Then the origin carries its real path, the one /proc/<pid>/exe resolves under', async () => {
    const REAL = '/data/claude-home';
    const observation = await linux(async () => `${REAL}/remote/ccd-cli/2.1.326-3eec682dec28`, 'linux', async (path) => (path === CONFIG ? REAL : path)).sample();
    assert.deepEqual(observation!.origins.get(100), { configDir: REAL, image: `${REAL}/remote/ccd-cli/2.1.326-3eec682dec28` });
  });

  test('#720/AC-5 Given a config folder whose real path cannot be read, Then the origin keeps the raw path', async () => {
    const observation = await linux(async () => IMAGE, 'linux', async () => { throw new Error('ENOENT'); }).sample();
    assert.deepEqual(observation!.origins.get(100), { configDir: CONFIG, image: IMAGE });
  });

  test('#720/AC-5 Given a pid claimed from two config folders, Then it has no origin', async () => {
    const exec: Exec = async (file, args) => {
      const key = [file, ...args].join(' ');
      return key === PS_TREE_CMD ? { ok: true, stdout: PS_TREE } : key === PS_NICE_CMD ? { ok: true, stdout: PS_NICE } : { ok: true, stdout: '' };
    };
    const registry: RegisteredSession[] = [
      { pid: 100, sessionId: 's1', cwd: null, procStart: START, configDir: CONFIG },
      { pid: 100, sessionId: 's1', cwd: null, procStart: START, configDir: '/home/someone/.claude-work' },
    ];
    const control = createMachineControl({ exec, platform: 'linux', registered: async () => registry, startCheck: async () => (entry, real) => entry.procStart === real.start, readImage: async () => IMAGE });
    assert.equal((await control.sample())!.origins.has(100), false);
  });
});
