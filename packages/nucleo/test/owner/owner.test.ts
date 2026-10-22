// Single-owner core (#86). The process tests start real cores, each with a fake HOME in a temporary
// folder and on a free port: they never touch 4720 nor the real ~/.ahrena-console.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  lockFilePath,
  claimLock,
  liveClients,
  codeCommit,
  compareVersions,
  examine,
  writeLock,
  readLock,
  releaseLock,
  newToken,
  stopCore,
  isPidAlive,
  planStart,
  registerClient,
  probe,
  removeLock,
  watchParent,
  type Lock,
} from '../../src/owner/index.ts';
import { API_VERSION } from '../../src/api/version.ts';

/** The core's version, escaped for a RegExp. */
const VERSION = API_VERSION.replaceAll('.', '\\.');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_CLI = join(ROOT, 'src/api/cli.ts');
const CORE_CLI = join(ROOT, 'src/owner/cli.ts');
const MCP_CLI = join(ROOT, 'src/mcp/cli.ts');
const HOOKS_ONLY = ['--no-history', '--no-desktop', '--no-github'];

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

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}

/** A pid that just died. */
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}

let home: string;
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-owner-'));
  dir = join(home, '.ahrena-console');
});

afterEach(async () => {
  const t = readLock(dir);
  for (const p of children.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  // Only the cores the tests started: a unit test's lock may hold any pid.
  const started = (await examine(dir).catch(() => null))?.state === 'alive';
  if (started && t && t !== 'invalid' && t.pid !== process.pid) process.kill(t.pid, 'SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  proc: ChildProcess;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function envWithoutCoreVars(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of ['AHRENA_CONSOLE_PORT', 'AHRENA_CONSOLE_CORE_PORT', 'AHRENA_CONSOLE_DB', 'AHRENA_CONSOLE_DATA_DIR', 'AHRENA_CONSOLE_HOME']) delete env[name];
  return env;
}

function run(cli: string, args: string[], extra: { env?: NodeJS.ProcessEnv; stdin?: boolean } = {}): Run {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    env: { ...envWithoutCoreVars(), ...extra.env },
    stdio: [extra.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c) => (stdout += c));
  proc.stderr!.on('data', (c) => (stderr += c));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => proc.once('close', (code) => r({ code, stdout, stderr })));
  return { proc, done };
}

const api = (port: number, ...extra: string[]) => run(API_CLI, ['--port', String(port), ...HOOKS_ONLY, ...extra]);
const core = (...args: string[]) => run(CORE_CLI, args);

/** Waits for the lock of a live core and returns it. */
async function liveLock(): Promise<Lock> {
  let live: Lock | null = null;
  const ok = await until(async () => {
    const ex = await examine(dir);
    if (ex.state === 'alive') live = ex.lock;
    return live !== null;
  });
  assert.ok(ok && live, 'the core did not start');
  return live;
}

function idle(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(p);
  return p;
}

describe('lock', () => {
  test('writes at once, with 0600, leaving no temporary file, and reads back', () => {
    const t: Lock = { pid: 123, port: 4799, version: '0.0.1', startedAt: new Date().toISOString(), token: newToken(), parent: null };
    writeLock(t, dir);
    assert.deepEqual(readLock(dir), t);
    assert.equal(statSync(lockFilePath(dir)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(dir), ['nucleo.json']);
    assert.equal(t.token.length, 64);
  });

  test('the file keeps its keys (other installed cores read it)', () => {
    const t: Lock = { pid: 123, port: 4799, version: '0.0.1', startedAt: '2026-10-19T12:00:00.000Z', token: 'abc', parent: 777 };
    writeLock(t, dir);
    assert.deepEqual(JSON.parse(readFileSync(lockFilePath(dir), 'utf8')), { pid: 123, porta: 4799, versao: '0.0.1', inicio: '2026-10-19T12:00:00.000Z', token: 'abc', pai: 777 });
  });

  test('no file is null; a file that is not a lock is invalid', () => {
    assert.equal(readLock(dir), null);
    writeLock({ pid: 0 } as Lock, dir);
    assert.equal(readLock(dir), 'invalid');
  });

  test('only the token holder releases', () => {
    const t: Lock = { pid: 1, port: 1, version: '0.0.1', startedAt: 'x', token: newToken(), parent: null };
    writeLock(t, dir);
    assert.equal(releaseLock('other', dir), false);
    assert.ok(readLock(dir));
    assert.equal(releaseLock(t.token, dir), true);
    assert.equal(readLock(dir), null);
  });

  test("removing another token's lock puts it back in place", () => {
    const t: Lock = { pid: 1, port: 1, version: '0.0.1', startedAt: 'x', token: newToken(), parent: null };
    writeLock(t, dir);
    assert.equal(removeLock('other', dir), false);
    assert.deepEqual(readLock(dir), t);
    assert.deepEqual(readdirSync(dir), ['nucleo.json'], 'no temporary file is left');
    assert.equal(removeLock(null, dir), false, 'null only removes an unreadable lock');
    writeFileSync(lockFilePath(dir), 'lixo');
    assert.equal(removeLock(null, dir), true);
    assert.equal(readLock(dir), null);
  });

  test('a folder that already existed open is closed to 0700', () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeLock({ pid: 1, port: 1, version: '0.0.1', startedAt: 'x', token: newToken(), parent: null }, dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  test('compares versions by number', () => {
    assert.equal(compareVersions('0.0.1', '0.0.2'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('0.0.2-beta.1', '0.0.2'), 0);
  });
});

describe('clients and the parent', () => {
  test('a dead client leaves the list', async () => {
    const dead = await deadPid();
    registerClient(process.pid, dir);
    registerClient(dead, dir);
    assert.deepEqual(liveClients(dir), [process.pid]);
    assert.deepEqual(readdirSync(join(dir, 'clientes')), [String(process.pid)]);
  });

  test('a dead parent with no client notifies; with a live client, it does not', async () => {
    const dead = await deadPid();
    const notices: string[] = [];
    registerClient(process.pid, dir);
    const stop = watchParent({ parent: dead, dir, intervalMs: 20, onGone: (m) => notices.push(m) });
    await sleep(100);
    assert.deepEqual(notices, []);
    rmSync(join(dir, 'clientes'), { recursive: true });
    assert.ok(await until(() => notices.length === 1, 1000));
    await sleep(100);
    assert.equal(notices.length, 1, 'notifies only once');
    stop();
  });
});

describe('the command', () => {
  test('--help shows the English names and none of the old ones', async () => {
    const r = await core('--help').done;
    assert.equal(r.code, 0);
    for (const name of ['start', 'stop', 'status', '--port <n>', '--parent <pid>', '--replace', '--json']) assert.ok(r.stdout.includes(name), name);
    assert.doesNotMatch(r.stdout, /--porta <n>|--pai <pid>|^\s+subir\s/m);
    assert.doesNotMatch(r.stdout, /old names|subir|--porta/);
  });
});

describe('start or adopt', { timeout: 60_000 }, () => {
  test('two starts at the same time give a single core', async () => {
    const port = await freePort();
    const a = api(port);
    const b = api(port);
    const t = await liveLock();
    const alive = [a, b].find((r) => r.proc.pid === t.pid);
    const other = [a, b].find((r) => r.proc.pid !== t.pid)!;
    assert.ok(alive, 'the lock belongs to one of the two');
    const s = await other.done;
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`127\\.0\\.0\\.1:${port} · versão ${VERSION} \\(adotado\\)`));
    assert.doesNotMatch(s.stderr, /atenção/, 'same code, with a lock: adopts without a warning');
    assert.equal(alive.proc.exitCode, null);
  });

  test('three `core start` at the same time: one starts, the others adopt the same pid', async () => {
    const port = await freePort();
    const runs = [1, 2, 3].map(() => core('start', '--port', String(port), '--json', '--', ...HOOKS_ONLY));
    const outputs = await Promise.all(runs.map((r) => r.done));
    const json = outputs.map((s) => {
      assert.equal(s.code, 0, s.stderr);
      return JSON.parse(s.stdout) as { pid: number; started: boolean; port: number };
    });
    assert.equal(new Set(json.map((j) => j.pid)).size, 1, JSON.stringify(json));
    assert.equal(json.filter((j) => j.started).length, 1, JSON.stringify(json));
    assert.ok(json.every((j) => j.port === port));
    const t = await liveLock();
    assert.equal(t.pid, json[0].pid);
    const st = await core('status', '--json').done;
    assert.equal(st.code, 0);
    assert.equal(JSON.parse(st.stdout).state, 'up');
    assert.doesNotMatch(st.stdout, new RegExp(t.token), 'status does not show the token');
    const stopped = await core('stop').done;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.ok(!isPidAlive(t.pid));
    assert.equal(readLock(dir), null);
    assert.equal((await core('status').done).code, 1);
  });

  test('the old Portuguese names are refused (#173, phase 6): subir, parar, --porta, --pai, --substituir', async () => {
    const port = await freePort();
    for (const args of [['subir'], ['parar'], ['start', '--porta', String(port)], ['start', '--pai', String(process.pid)], ['start', '--substituir']]) {
      const r = await core(...args, '--json').done;
      assert.notEqual(r.code, 0, args.join(' '));
    }
    assert.equal(readLock(dir), null, 'nothing started');
  });

  test('start --json is English: state, port, parent, started', async () => {
    const port = await freePort();
    const parent = idle();
    const r = await core('start', '--port', String(port), '--parent', String(parent.pid), '--json', '--', ...HOOKS_ONLY).done;
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.state, j.port, j.parent, j.started], ['up', port, parent.pid, true]);
    assert.ok(!('estado' in j) && !('porta' in j) && !('subiu' in j), r.stdout);
    assert.equal((await liveLock()).parent, parent.pid);
  });

  test('an orphan lock with a dead pid is recovered', async () => {
    const port = await freePort();
    writeLock({ pid: await deadPid(), port, version: '0.0.1', startedAt: 'antes', token: 'velho', parent: null }, dir);
    const a = api(port);
    const t = await liveLock();
    assert.equal(t.pid, a.proc.pid);
    assert.notEqual(t.token, 'velho');
    assert.equal(t.port, port);
  });

  test('an orphan lock with a live pid but a silent port is recovered', async () => {
    const [silent, port] = [await freePort(), await freePort()];
    writeLock({ pid: process.pid, port: silent, version: '0.0.1', startedAt: 'antes', token: 'velho', parent: null }, dir);
    const s = core('start', '--port', String(port), '--json', '--', ...HOOKS_ONLY);
    const r = await s.done;
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.started, true);
    assert.equal(j.port, port);
    assert.notEqual(j.pid, process.pid);
    assert.equal((await liveLock()).token.length, 64);
  });

  test('on exit, the core deletes its own lock', async () => {
    const a = api(await freePort());
    await liveLock();
    a.proc.kill('SIGTERM');
    await a.done;
    assert.equal(readLock(dir), null);
  });
});

describe('version', { timeout: 60_000 }, () => {
  test('older version: replaced without --replace (#220)', async () => {
    const port = await freePort();
    const old = api(port);
    const t = await liveLock();
    writeLock({ ...t, version: '0.0.0' }, dir);

    const fresh = api(port);
    await until(() => old.proc.exitCode !== null || old.proc.signalCode !== null);
    const t2 = await liveLock();
    assert.equal(t2.pid, fresh.proc.pid);
    assert.equal(t2.version, API_VERSION);
    assert.ok(!isPidAlive(t.pid));
  });

  test('older version kept up by a registered client: `start` replaces it and the client stays registered (#220)', async () => {
    const parent = idle();
    const bridge = idle();
    api(await freePort(), '--parent', String(parent.pid));
    const t = await liveLock();
    // What the MCP bridge does: it registers as a client, so the old core ignores "parent gone".
    registerClient(bridge.pid!, dir);
    writeLock({ ...t, version: '0.0.0' }, dir);
    parent.kill('SIGKILL');

    const app = idle();
    const r = await core('start', '--parent', String(app.pid), '--json', '--', ...HOOKS_ONLY).done;
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.started, true);
    assert.equal(j.version, API_VERSION);
    assert.notEqual(j.pid, t.pid);
    assert.match(r.stderr, /replacing the core 0\.0\.0/);
    assert.ok(!isPidAlive(t.pid), 'the old core is gone');
    assert.ok(liveClients(dir).includes(bridge.pid!), 'the bridge is still a client of the new core');
  });

  test('older version that does not give way: start says why and starts nothing (#220)', async () => {
    const port = await freePort();
    // A fake core: answers with its pid once (examine), then with another (the stop check), so
    // stopCore refuses to signal it.
    const fake = spawn(
      process.execPath,
      [
        '-e',
        `let n = 0; require('node:http').createServer((q, s) => s.end(JSON.stringify({ name: 'ahrena-console', version: '0.0.0', pid: n++ ? 1 : process.pid }))).listen(${port}, '127.0.0.1', () => console.log('ok'));`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(fake);
    await new Promise((r) => fake.stdout!.once('data', r));
    writeLock({ pid: fake.pid!, port, version: '0.0.0', startedAt: new Date().toISOString(), token: newToken(), parent: null }, dir);

    const r = await core('start', '--json', '--', ...HOOKS_ONLY).done;
    assert.equal(r.code, 1, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.state, 'stopped');
    assert.match(j.reason, /o núcleo antigo \(versão 0\.0\.0, pid \d+\) não saiu/);
    assert.ok(isPidAlive(fake.pid!), 'nothing signals what is not the core');
  });

  test('a core of the same version or newer is adopted without a warning', async () => {
    const port = await freePort();
    api(port);
    const t = await liveLock();
    writeLock({ ...t, version: '9.0.0' }, dir);
    const r = await api(port, '--replace').done;
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /atenção/);
    assert.match(r.stdout, /versão 9\.0\.0 \(adotado\)/);
  });
});

describe('--parent', { timeout: 60_000 }, () => {
  test('the core exits when the parent dies and deletes the lock', async () => {
    const parent = idle();
    const a = api(await freePort(), '--parent', String(parent.pid));
    const t = await liveLock();
    assert.equal(t.parent, parent.pid);
    parent.kill('SIGKILL');
    const s = await a.done;
    assert.equal(s.code, 0);
    assert.match(s.stderr, /o pai \(pid \d+\) sumiu e não há cliente registrado; saindo/);
    assert.equal(readLock(dir), null);
  });

  test('with another registered client, it stays until the last one is gone (the app\'s call)', async () => {
    const port = await freePort();
    const app = idle();
    const extension = idle();
    const a = api(port, '--parent', String(app.pid));
    await liveLock();
    // What the desktop app runs (apps/desktop/src-tauri/src/core.rs `start_args`).
    const adopted = await run(CORE_CLI, ['start', '--parent', String(extension.pid), '--json']).done;
    assert.equal(JSON.parse(adopted.stdout).started, false);
    assert.deepEqual(liveClients(dir), [extension.pid]);

    app.kill('SIGKILL');
    await sleep(2500);
    assert.equal(a.proc.exitCode, null, 'the extension still needs the core');

    extension.kill('SIGKILL');
    const s = await a.done;
    assert.equal(s.code, 0);
    assert.equal(readLock(dir), null);
  });

  test('without --parent, nobody watches', async () => {
    const a = api(await freePort());
    await liveLock();
    await sleep(1500);
    assert.equal(a.proc.exitCode, null);
  });
});

describe('ownership and code', { timeout: 60_000 }, () => {
  test('/api/overview says the pid and commit of whoever answers', async () => {
    const port = await freePort();
    const a = api(port);
    const t = await liveLock();
    const v = await probe(port);
    assert.equal(v?.pid, a.proc.pid);
    assert.equal(t.pid, a.proc.pid);
    assert.equal(v?.commit, codeCommit());
  });

  test('reused pid: the lock is an orphan and nobody signals the stranger process', async () => {
    const port = await freePort();
    const a = api(port);
    const t = await liveLock();
    const stranger = idle();
    writeLock({ ...t, pid: stranger.pid! }, dir);
    const ex = await examine(dir);
    assert.equal(ex.state, 'orphan');
    assert.match(ex.state === 'orphan' ? ex.reason : '', /é de outro processo \(pid \d+\), não do pid \d+/);

    assert.equal(await stopCore({ ...t, pid: stranger.pid! }, { dir, timeoutMs: 500 }), false);
    const r = await core('stop').done;
    assert.equal(r.code, 0);
    assert.match(r.stdout, /orphan lock deleted/);
    await sleep(200);
    assert.ok(isPidAlive(stranger.pid!), 'the stranger process is still alive');
    assert.equal(a.proc.exitCode, null, 'and so is the real core');
  });

  test('--demo and --no-lock fail if the port already has a core', async () => {
    const port = await freePort();
    api(port);
    await liveLock();
    for (const option of ['--demo', '--no-lock']) {
      const r = await run(API_CLI, ['--port', String(port), ...HOOKS_ONLY, option]).done;
      assert.equal(r.code, 1, option);
      assert.match(r.stderr, /já tem um núcleo \(pid \d+\); a --(demo|no-lock) precisa de uma porta livre/);
      assert.equal(r.stdout, '');
    }
  });

  test('the API creates the core folder with 0700, and closes one that was open', async () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    api(await freePort());
    await liveLock();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  test('another commit of the same version: warns and adopts; an older commit with replace swaps', async () => {
    const port = await freePort();
    const a = api(port);
    const t = await liveLock();
    const mine = { version: t.version, dir };

    const other = await planStart({ ...mine, commit: 'f00dfeed', isOlderCommit: () => false, replace: true });
    assert.equal(other.action, 'adopt');
    assert.match(other.action === 'adopt' ? (other.warning ?? '') : '', /roda o commit \w+, que não é este \(f00dfeed\) nem um ancestral dele/);
    assert.ok(isPidAlive(t.pid), 'other code is never replaced on its own');

    const withoutReplace = await planStart({ ...mine, commit: 'f00dfeed', isOlderCommit: () => true });
    assert.match(withoutReplace.action === 'adopt' ? (withoutReplace.warning ?? '') : '', /mais velho que este \(f00dfeed\).*--replace/);

    const same = await planStart({ ...mine, commit: codeCommit() });
    assert.deepEqual(same.action === 'adopt' && same.warning, null);

    const swap = await planStart({ ...mine, commit: 'f00dfeed', isOlderCommit: () => true, replace: true });
    assert.equal(swap.action, 'start');
    await a.done;
    assert.ok(!isPidAlive(t.pid));
    assert.equal(readLock(dir), null);
  });

  test('the lock is exclusive: with another live core, claiming returns the conflict; an orphan is swapped', async () => {
    const port = await freePort();
    api(port);
    const t = await liveLock();
    const r = await claimLock({ dir, port: 1, version: '0.0.1', parent: null });
    assert.ok('conflict' in r && r.conflict.pid === t.pid);
    assert.deepEqual(readLock(dir), t, 'the live lock stays');

    rmSync(dir, { recursive: true });
    writeLock({ ...t, pid: await deadPid() }, dir);
    const mineLock = await claimLock({ dir, port: 1, version: '0.0.1', parent: null });
    assert.ok(!('conflict' in mineLock) && mineLock.pid === process.pid);
    assert.deepEqual(readLock(dir), mineLock);
    rmSync(lockFilePath(dir));
  });
});

describe('the MCP stdio bridge', { timeout: 60_000 }, () => {
  test('starts the core with --parent on itself, answers through it, and the core exits when it exits', async () => {
    const port = await freePort();
    const bridge = run(MCP_CLI, [], { env: { AHRENA_CONSOLE_PORT: String(port) }, stdin: true });
    const t = await liveLock();
    assert.equal(t.port, port);
    assert.equal(t.parent, bridge.proc.pid, 'the core watches the bridge');

    const send = (m: object) => bridge.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0' } } });
    send({ id: 2, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } });
    bridge.proc.stdin!.end();
    const s = await bridge.done;
    const replies = s.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result?: { isError?: boolean } });
    const call = replies.find((r) => r.id === 2);
    assert.ok(call?.result, s.stdout);
    assert.notEqual(call.result.isError, true, 'the core answered the call');

    assert.ok(await until(() => !isPidAlive(t.pid), 10_000), 'the bridge exited and so did the core');
    assert.equal(readLock(dir), null);
  });

  test('adopts the core that is up and registers as a client', async () => {
    const port = await freePort();
    const app = idle();
    const a = api(port, '--parent', String(app.pid));
    await liveLock();
    const bridge = run(MCP_CLI, [], { env: { AHRENA_CONSOLE_PORT: String(await freePort()) }, stdin: true });
    assert.ok(await until(() => liveClients(dir).includes(bridge.proc.pid!)), 'the bridge is a client');
    app.kill('SIGKILL');
    await sleep(2500);
    assert.equal(a.proc.exitCode, null, 'the bridge still needs the core');
    bridge.proc.stdin!.end();
    await bridge.done;
    assert.equal((await a.done).code, 0);
  });
});
