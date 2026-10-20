// One core per installation, on a random port, with the instance registry (decision 0010, #221).
// Every test runs with a fake HOME in a temporary folder and lets the system pick the ports (or uses
// a free one): they never touch 4720, the real ~/.ahrena-console, nor a core they did not start.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquireStartGuard,
  consoleHome,
  defaultDataDir,
  examine,
  instanceId,
  instancesDir,
  isPidAlive,
  listInstances,
  parseInstallation,
  pickInstance,
  readLock,
  removeInstance,
  resolveDataDir,
  resolvePort,
  START_GUARD_FILE_NAME,
  verifyInstance,
  writeInstance,
  type Instance,
  type Lock,
} from '../../src/owner/index.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_CLI = join(ROOT, 'src/api/cli.ts');
const CORE_CLI = join(ROOT, 'src/owner/cli.ts');
const HOOKS_ONLY = ['--sem-historico', '--sem-desktop', '--sem-github', '--no-telemetry'];
const CORE_VARS = ['AHRENA_CONSOLE_PORT', 'AHRENA_CONSOLE_CORE_PORT', 'AHRENA_CONSOLE_DB', 'AHRENA_CONSOLE_DATA_DIR', 'AHRENA_CONSOLE_HOME', 'XDG_DATA_HOME', 'APPDATA'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}

async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}

let home: string;
/** The fake `~/.ahrena-console`: the registry's root and the `dev` data folder. */
let consoleDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-installations-'));
  consoleDir = join(home, '.ahrena-console');
});

afterEach(async () => {
  for (const p of children.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  // The cores `start` left in the background: only those of this fake HOME, which the tests started.
  for (const i of listInstances({ home: consoleDir, clean: false })) if (i.pid !== process.pid && (await verifyInstance(i))) process.kill(i.pid, 'SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of CORE_VARS) delete env[name];
  return { ...env, ...extra };
}

interface Run {
  proc: ChildProcess;
  /** What the process wrote to stderr so far. */
  stderr: () => string;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function run(cli: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: testEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c) => (stdout += c));
  proc.stderr!.on('data', (c) => (stderr += c));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => proc.once('close', (code) => r({ code, stdout, stderr })));
  return { proc, stderr: () => stderr, done };
}

const api = (...args: string[]) => run(API_CLI, [...args, ...HOOKS_ONLY]);

interface StartJson {
  estado: string;
  url: string;
  porta: number;
  pid: number;
  subiu: boolean;
  installation: string;
  dataDir: string;
  instances?: Instance[];
}

async function coreStart(...args: string[]): Promise<StartJson> {
  const r = await run(CORE_CLI, ['start', ...args, '--json', '--', ...HOOKS_ONLY]).done;
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as StartJson;
}

/** The app installation's default folder under the fake HOME. */
function appDir(): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'dev.ahrena.console');
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'dev.ahrena.console');
  return join(home, '.local', 'share', 'dev.ahrena.console');
}

/** Waits for the live lock of a data folder. */
async function liveLock(dir: string): Promise<Lock> {
  let live: Lock | null = null;
  const ok = await until(async () => {
    const ex = await examine(dir);
    if (ex.state === 'alive') live = ex.lock;
    return live !== null;
  });
  assert.ok(ok && live, `no core came up in ${dir}`);
  return live;
}

const entry = (over: Partial<Instance> = {}): Instance => {
  const pid = over.pid ?? process.pid;
  const installation = over.installation ?? 'dev';
  return { id: instanceId(installation, pid), installation, pid, port: 4321, version: '0.0.1', commit: null, dataDir: '/tmp/x', startedAt: '2026-10-20T12:00:00.000Z', ...over };
};

describe('installation, data folder and port', () => {
  test('each installation has its own default folder; --data-dir and AHRENA_CONSOLE_DATA_DIR win', () => {
    const env = { AHRENA_CONSOLE_HOME: '/u/console' };
    assert.equal(consoleHome(env), '/u/console');
    assert.equal(defaultDataDir('dev', env), '/u/console');
    assert.equal(defaultDataDir('mcpb', env), '/u/console/installations/mcpb');
    if (process.platform === 'darwin') assert.equal(defaultDataDir('app', env), join(homedir(), 'Library', 'Application Support', 'dev.ahrena.console'));
    assert.equal(consoleHome({}), join(homedir(), '.ahrena-console'));
    assert.equal(resolveDataDir({ installation: 'app' }, { ...env, AHRENA_CONSOLE_DATA_DIR: '/d/env' }), '/d/env');
    assert.equal(resolveDataDir({ installation: 'app', dataDir: '/d/option' }, { ...env, AHRENA_CONSOLE_DATA_DIR: '/d/env' }), '/d/option');
    assert.equal(resolveDataDir({}, env), '/u/console', 'dev by default');
  });

  test('--installation takes app, dev or mcpb, and dev by default', () => {
    assert.equal(parseInstallation(undefined), 'dev');
    assert.equal(parseInstallation('app'), 'app');
    assert.equal(parseInstallation('mcpb'), 'mcpb');
    assert.throws(() => parseInstallation('desktop'), /--installation: one of app, dev, mcpb/);
  });

  test('the port is 0 unless the option, AHRENA_CONSOLE_CORE_PORT or AHRENA_CONSOLE_PORT forces one', () => {
    assert.equal(resolvePort(undefined, {}), 0);
    assert.equal(resolvePort(undefined, { AHRENA_CONSOLE_PORT: '4720' }), 4720);
    assert.equal(resolvePort(undefined, { AHRENA_CONSOLE_CORE_PORT: '4800', AHRENA_CONSOLE_PORT: '4720' }), 4800);
    assert.equal(resolvePort('4900', { AHRENA_CONSOLE_CORE_PORT: '4800' }), 4900);
    assert.equal(resolvePort('0', { AHRENA_CONSOLE_CORE_PORT: '4800' }), 0);
    assert.throws(() => resolvePort('porta', {}), /--port/);
    assert.throws(() => resolvePort('70000', {}), /--port/);
  });
});

describe('the instance registry', () => {
  test('writes at once, 0600 in a 0700 folder, with only the entry keys (never a token)', () => {
    const e = entry();
    const file = writeInstance({ ...e, token: 'secret-token' } as Instance, { home: consoleDir });
    assert.equal(file, join(consoleDir, 'instances', `${e.id}.json`));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(instancesDir(consoleDir)).mode & 0o777, 0o700);
    assert.equal(statSync(consoleDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(instancesDir(consoleDir)), [`${e.id}.json`], 'no temporary file is left');
    const raw = readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /token|secret/);
    assert.deepEqual(JSON.parse(raw), e);
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['id', 'installation', 'pid', 'port', 'version', 'commit', 'dataDir', 'startedAt']);
  });

  test('lists live entries oldest first; dead-pid and unreadable entries are dropped and deleted', async () => {
    const dead = await deadPid();
    const older = entry({ installation: 'app', startedAt: '2026-10-20T10:00:00.000Z' });
    const newer = entry({ installation: 'dev', startedAt: '2026-10-20T11:00:00.000Z' });
    writeInstance(newer, { home: consoleDir });
    writeInstance(older, { home: consoleDir });
    writeInstance(entry({ installation: 'mcpb', pid: dead }), { home: consoleDir });
    writeFileSync(join(instancesDir(consoleDir), 'dev-99999999.json'), 'not json');
    writeFileSync(join(instancesDir(consoleDir), '.app-1.tmp'), 'half');
    assert.deepEqual(listInstances({ home: consoleDir }), [older, newer]);
    assert.deepEqual(readdirSync(instancesDir(consoleDir)).sort(), ['.app-1.tmp', `${older.id}.json`, `${newer.id}.json`].sort(), 'the dead and unreadable files are gone');
  });

  test('pickInstance: the own installation if live, else the first live one, else null', () => {
    assert.equal(pickInstance({ installation: 'dev', home: consoleDir }), null);
    const app = entry({ installation: 'app', startedAt: '2026-10-20T10:00:00.000Z' });
    writeInstance(app, { home: consoleDir });
    assert.deepEqual(pickInstance({ installation: 'dev', home: consoleDir }), app, 'no dev core: the first live one');
    const dev = entry({ installation: 'dev', startedAt: '2026-10-20T11:00:00.000Z' });
    writeInstance(dev, { home: consoleDir });
    assert.deepEqual(pickInstance({ installation: 'dev', home: consoleDir }), dev);
    assert.deepEqual(pickInstance({ installation: 'mcpb', home: consoleDir }), app);
  });

  test('removeInstance with a pid only deletes the entry that still says that pid', () => {
    const e = entry();
    writeInstance(e, { home: consoleDir });
    assert.equal(removeInstance(e.id, { home: consoleDir, pid: e.pid + 1 }), false);
    assert.equal(removeInstance(e.id, { home: consoleDir, pid: e.pid }), true);
    assert.equal(removeInstance(e.id, { home: consoleDir }), false);
    assert.throws(() => removeInstance('../nucleo', { home: consoleDir }), /not an instance id/);
  });

  test('verifyInstance is false when the port does not answer with that pid', async () => {
    assert.equal(await verifyInstance(entry({ port: await freePort() }), 300), false);
    assert.equal(await verifyInstance(entry({ pid: await deadPid() })), false);
  });
});

describe('the start guard', () => {
  test('a second start waits for the first; a guard left by a dead pid is taken over', async () => {
    const dir = join(home, 'data');
    const first = await acquireStartGuard(dir);
    assert.equal(first.waited, false);
    let second: Awaited<ReturnType<typeof acquireStartGuard>> | null = null;
    const waiting = acquireStartGuard(dir).then((g) => (second = g));
    await sleep(300);
    assert.equal(second, null, 'still waiting');
    first.release();
    await waiting;
    assert.equal(second!.waited, true);
    second!.release();
    assert.ok(!existsSync(join(dir, START_GUARD_FILE_NAME)));

    writeFileSync(join(dir, START_GUARD_FILE_NAME), JSON.stringify({ pid: await deadPid() }));
    const third = await acquireStartGuard(dir, { timeoutMs: 1000 });
    assert.equal(third.waited, false);
    assert.equal(JSON.parse(readFileSync(join(dir, START_GUARD_FILE_NAME), 'utf8')).pid, process.pid);
    third.release();
  });
});

describe('cores per installation', { timeout: 120_000 }, () => {
  test('port 0: start announces the port it got, in --json, in the lock and in the registry', async () => {
    const s = await coreStart();
    assert.equal(s.estado, 'de-pe');
    assert.equal(s.subiu, true);
    assert.ok(Number.isInteger(s.porta) && s.porta > 0, `port ${s.porta}`);
    assert.equal(s.url, `http://127.0.0.1:${s.porta}`);
    assert.equal(s.installation, 'dev');
    assert.equal(s.dataDir, consoleDir);
    const lock = await liveLock(consoleDir);
    assert.equal(lock.port, s.porta);
    assert.ok(existsSync(join(consoleDir, 'nucleo.sqlite')));
    assert.ok(existsSync(join(consoleDir, 'nucleo.log')));
    assert.match(readFileSync(join(consoleDir, 'nucleo.log'), 'utf8'), new RegExp(`listening on port ${s.porta} · installation dev`));

    const [i] = listInstances({ home: consoleDir });
    assert.deepEqual({ ...i, startedAt: '' }, { id: `dev-${s.pid}`, installation: 'dev', pid: s.pid, port: s.porta, version: lock.version, commit: i.commit, dataDir: consoleDir, startedAt: '' });
    assert.equal(i.startedAt, lock.startedAt);
    assert.ok(await verifyInstance(i));
    const raw = readFileSync(join(instancesDir(consoleDir), `${i.id}.json`), 'utf8');
    assert.ok(!raw.includes(lock.token), 'the lock token never goes to the registry');
    assert.equal(statSync(join(instancesDir(consoleDir), `${i.id}.json`)).mode & 0o777, 0o600);
    assert.equal(statSync(instancesDir(consoleDir)).mode & 0o777, 0o700);

    const st = await run(CORE_CLI, ['status', '--json']).done;
    assert.equal(st.code, 0, st.stderr);
    const status = JSON.parse(st.stdout) as StartJson;
    assert.deepEqual(status.instances, [i]);
    assert.ok(!st.stdout.includes(lock.token));
    const text = await run(CORE_CLI, ['status']).done;
    assert.match(text.stdout, new RegExp(`dev-${s.pid} · dev · port ${s.porta} · pid ${s.pid}`));

    const stopped = await run(CORE_CLI, ['stop']).done;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.ok(!isPidAlive(s.pid));
    assert.deepEqual(readdirSync(instancesDir(consoleDir)), [], 'SIGTERM removed the entry');
  });

  test('two installations at once: different ports, databases and entries; neither adopts the other', async () => {
    const dev = await coreStart();
    const app = await coreStart('--installation', 'app');
    assert.equal(app.subiu, true, 'the app does not adopt the dev core');
    assert.notEqual(app.pid, dev.pid);
    assert.notEqual(app.porta, dev.porta);
    assert.equal(app.dataDir, appDir());
    assert.ok(existsSync(join(appDir(), 'nucleo.sqlite')));
    assert.ok(existsSync(join(consoleDir, 'nucleo.sqlite')));
    assert.equal(statSync(appDir()).mode & 0o777, 0o700);
    assert.equal((await liveLock(appDir())).pid, app.pid);
    assert.equal((await liveLock(consoleDir)).pid, dev.pid);
    assert.ok(!existsSync(join(appDir(), 'instances')), 'the registry is per user, not per installation');

    const live = listInstances({ home: consoleDir });
    assert.deepEqual(live.map((i) => i.id).sort(), [`app-${app.pid}`, `dev-${dev.pid}`].sort());
    assert.equal(pickInstance({ installation: 'app', home: consoleDir })?.pid, app.pid);
    assert.equal(pickInstance({ installation: 'dev', home: consoleDir })?.pid, dev.pid);
    assert.equal(pickInstance({ installation: 'mcpb', home: consoleDir })?.pid, live[0].pid);

    // The same installation adopts its own core.
    const again = await coreStart('--installation', 'app');
    assert.equal(again.subiu, false);
    assert.equal(again.pid, app.pid);
    assert.equal(again.porta, app.porta);

    // Each answers on its own port, as itself.
    for (const i of live) assert.ok(await verifyInstance(i), i.id);

    const stopApp = await run(CORE_CLI, ['stop', '--installation', 'app']).done;
    assert.equal(stopApp.code, 0, stopApp.stderr);
    assert.ok(!isPidAlive(app.pid));
    assert.ok(isPidAlive(dev.pid), 'stopping the app core leaves the dev one alone');
    assert.deepEqual(listInstances({ home: consoleDir }).map((i) => i.id), [`dev-${dev.pid}`]);
  });

  test('--data-dir and AHRENA_CONSOLE_DATA_DIR choose the folder; mcpb has its own default', async () => {
    const custom = join(home, 'custom');
    const a = await coreStart('--installation', 'mcpb', '--data-dir', custom);
    assert.equal(a.dataDir, custom);
    assert.ok(existsSync(join(custom, 'nucleo.sqlite')));
    const r = await run(CORE_CLI, ['status', '--installation', 'mcpb', '--json'], { AHRENA_CONSOLE_DATA_DIR: custom }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).pid, a.pid);
    const def = await run(CORE_CLI, ['status', '--installation', 'mcpb', '--json']).done;
    assert.equal(def.code, 1, 'the default mcpb folder has no core');
    assert.equal(JSON.parse(def.stdout).dataDir, join(consoleDir, 'installations', 'mcpb'));
  });

  test('two API starts of one installation at the same time, on port 0, give a single core', async () => {
    const a = api();
    const b = api();
    const t = await liveLock(consoleDir);
    const other = [a, b].find((r) => r.proc.pid !== t.pid)!;
    const s = await other.done;
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`127\\.0\\.0\\.1:${t.port} · versão .* \\(adotado\\)`));
    assert.deepEqual(listInstances({ home: consoleDir }).map((i) => i.pid), [t.pid]);
    assert.ok(!existsSync(join(consoleDir, START_GUARD_FILE_NAME)), 'the start guard is released');
  });

  test('a forced port still works: --port and AHRENA_CONSOLE_CORE_PORT', async () => {
    const port = await freePort();
    api('--port', String(port));
    const t = await liveLock(consoleDir);
    assert.equal(t.port, port);
    assert.equal(listInstances({ home: consoleDir })[0].port, port);

    const envPort = await freePort();
    const r = await run(CORE_CLI, ['start', '--installation', 'app', '--json', '--', ...HOOKS_ONLY], { AHRENA_CONSOLE_CORE_PORT: String(envPort) }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).porta, envPort);
  });

  test('a forced port held by another installation\'s core is never adopted', async () => {
    const port = await freePort();
    const app = await coreStart('--installation', 'app', '--port', String(port));
    const r = await api('--port', String(port)).done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`port ${port} has the core of another installation \\(pid ${app.pid}\\)`));
    assert.equal(readLock(consoleDir), null, 'the dev folder got no lock');
    assert.ok(isPidAlive(app.pid));
  });

  test('the entry goes away on SIGTERM, on SIGINT and when the parent dies; a dead-pid entry is ignored', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const a = api();
      await until(() => listInstances({ home: consoleDir }).length === 1);
      a.proc.kill(signal);
      assert.equal((await a.done).code, 0);
      assert.deepEqual(readdirSync(instancesDir(consoleDir)), [], signal);
    }

    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(parent);
    const a = api('--parent', String(parent.pid));
    assert.ok(await until(() => listInstances({ home: consoleDir }).length === 1));
    parent.kill('SIGKILL');
    assert.equal((await a.done).code, 0);
    assert.deepEqual(readdirSync(instancesDir(consoleDir)), []);

    // A core killed with SIGKILL leaves its entry: readers ignore it and clean it up.
    const k = api();
    assert.ok(await until(() => listInstances({ home: consoleDir }).length === 1));
    k.proc.kill('SIGKILL');
    await k.done;
    assert.equal(readdirSync(instancesDir(consoleDir)).length, 1, 'SIGKILL leaves the file');
    assert.deepEqual(listInstances({ home: consoleDir }), []);
    assert.deepEqual(readdirSync(instancesDir(consoleDir)), []);
  });

  test('--demo and --no-lock cores do not register', async () => {
    for (const option of ['--demo', '--no-lock']) {
      const a = api(option);
      assert.ok(await until(() => /listening on port [1-9]\d* · installation dev/.test(a.stderr())), option);
      assert.deepEqual(listInstances({ home: consoleDir }), [], option);
      assert.equal(readLock(consoleDir), null, option);
      a.proc.kill('SIGTERM');
      await a.done;
    }
  });
});
