// The MCP stdio bridge finds its core through the instance registry (decision 0010, item 5; #221).
// Every test runs with a fake HOME in a temporary folder. The cores in the registry are fakes (an
// HTTP server on port 0 that answers `/api/overview` with the pid of an idle child and `/mcp` with
// its own name), except where the bridge has to start a real one. Nothing touches 4720, the real
// ~/.ahrena-console, nor a core the test did not start.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { instanceId, isPidAlive, listInstances, readLock, removeInstance, verifyInstance, writeInstance, type Installation, type Instance } from '../../src/owner/index.ts';
import { chooseInstance, shouldStartOwn } from '../../src/mcp/target.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MCP_CLI = join(ROOT, 'src/mcp/cli.ts');
const CORE_CLI = join(ROOT, 'src/owner/cli.ts');
const HOOKS_ONLY = ['--sem-historico', '--sem-desktop', '--sem-github', '--no-telemetry'];
const CORE_VARS = ['AHRENA_CONSOLE_PORT', 'AHRENA_CONSOLE_CORE_PORT', 'AHRENA_CONSOLE_DB', 'AHRENA_CONSOLE_DATA_DIR', 'AHRENA_CONSOLE_HOME', 'XDG_DATA_HOME', 'APPDATA'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(step);
  }
  return cond();
}

let home: string;
let consoleDir: string;
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-bridge-'));
  consoleDir = join(home, '.ahrena-console');
});

afterEach(async () => {
  for (const p of children.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  for (const s of servers.splice(0)) s.closeAllConnections(), s.close();
  // Real cores the bridge started under this fake HOME: only those, checked by pid and port.
  for (const i of listInstances({ home: consoleDir, clean: false })) if (i.pid !== process.pid && (await verifyInstance(i))) process.kill(i.pid, 'SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function idle(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(p);
  return p;
}

async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}

/** A fake core: answers `/api/overview` with `pid` and every `tools/call` with `name`. */
async function fakeCore(name: string, pid: number): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/overview') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'ahrena-console', version: '0.0.1', pid, commit: null }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = JSON.parse(body) as { id?: number; method: string };
      if (m.id === undefined) return void res.writeHead(202).end();
      const result = m.method === 'tools/call' ? { content: [{ type: 'text', text: name }] } : {};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, server };
}

let clock = Date.parse('2026-10-20T12:00:00.000Z');

/** A registry entry for a fake core of `installation`, started after the previous ones. */
async function register(installation: Installation, o: { pid?: number; name?: string } = {}): Promise<Instance & { server: Server }> {
  const pid = o.pid ?? idle().pid!;
  const { port, server } = await fakeCore(o.name ?? installation, pid);
  clock += 1000;
  const entry: Instance = {
    id: instanceId(installation, pid),
    installation,
    pid,
    port,
    version: '0.0.1',
    commit: null,
    dataDir: join(home, 'data', installation),
    startedAt: new Date(clock).toISOString(),
  };
  writeInstance(entry, { home: consoleDir });
  return { ...entry, server };
}

interface Bridge {
  proc: ChildProcess;
  /** `tools/call` of `fleet_overview`: the text of the answer (the fake core's name), or the error. */
  call: () => Promise<{ text: string; isError: boolean; structured: boolean }>;
  stderr: () => string;
  close: () => Promise<void>;
}

function bridge(...args: string[]): Bridge {
  return bridgeWith({}, ...args);
}

function bridgeWith(extra: NodeJS.ProcessEnv, ...args: string[]): Bridge {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of CORE_VARS) delete env[name];
  Object.assign(env, extra);
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MCP_CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(proc);
  let buffer = '';
  let stderr = '';
  const waiting = new Map<number, (r: { result?: { content?: { text: string }[]; isError?: boolean; structuredContent?: unknown } }) => void>();
  proc.stdout!.on('data', (c) => {
    buffer += c;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const r = JSON.parse(line) as { id: number };
      waiting.get(r.id)?.(r);
      waiting.delete(r.id);
    }
  });
  proc.stderr!.on('data', (c) => (stderr += c));
  let id = 0;
  return {
    proc,
    stderr: () => stderr,
    call: async () => {
      const n = ++id;
      const answer = new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>((r) => waiting.set(n, r));
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } })}\n`);
      const r = await answer;
      return { text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError === true, structured: r.result?.structuredContent !== undefined };
    },
    close: async () => {
      proc.stdin!.end();
      await new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('close', r)));
    },
  };
}

describe('the bridge rule, as functions', () => {
  const entry = (installation: Installation, pid: number): Instance => ({
    id: instanceId(installation, pid),
    installation,
    pid,
    port: 50_000 + pid,
    version: '0.0.1',
    commit: null,
    dataDir: '/d',
    startedAt: new Date(pid * 1000).toISOString(),
  });
  const live = [entry('app', 1), entry('dev', 2), entry('dev', 3)];

  test('own installation first (the oldest), else the oldest of any', () => {
    assert.deepEqual(chooseInstance(live, 'dev'), { instance: live[1], own: true });
    assert.deepEqual(chooseInstance(live, 'mcpb'), { instance: live[0], own: false });
    assert.deepEqual(chooseInstance(live, 'dev', new Set([live[1].id])), { instance: live[2], own: true });
    assert.deepEqual(chooseInstance([], 'dev'), { instance: null, own: false });
  });

  test('mcpb starts its own when none of its installation is live; dev and app only when none at all', () => {
    assert.equal(shouldStartOwn('mcpb', [entry('app', 1)]), true);
    assert.equal(shouldStartOwn('mcpb', [entry('mcpb', 1)]), false);
    assert.equal(shouldStartOwn('dev', [entry('app', 1)]), false);
    assert.equal(shouldStartOwn('app', [entry('dev', 1)]), false);
    assert.equal(shouldStartOwn('dev', []), true);
    assert.equal(shouldStartOwn('app', []), true);
  });
});

describe('the MCP stdio bridge and the instance registry', { timeout: 90_000 }, () => {
  test('picks the core of its own installation, even when another one is older', async () => {
    await register('app');
    await register('dev');
    await register('mcpb');
    for (const installation of ['dev', 'mcpb', 'app'] as const) {
      const b = bridge('--installation', installation, '--no-start');
      assert.equal((await b.call()).text, installation);
      await b.close();
    }
  });

  test('without a core of its installation, dev uses the oldest live one and starts none', async () => {
    await register('app');
    await register('mcpb');
    const b = bridge(); // dev by default, starting allowed
    assert.equal((await b.call()).text, 'app');
    await sleep(1500);
    assert.equal((await b.call()).text, 'app');
    assert.deepEqual(listInstances({ home: consoleDir }).map((i) => i.installation).sort(), ['app', 'mcpb'], 'no dev core was started');
    assert.equal(readLock(consoleDir), null);
    await b.close();
  });

  test('ignores an entry whose pid is dead, even if its port still answers', async () => {
    const stale = await register('dev', { pid: await deadPid(), name: 'stale' });
    await register('app');
    const b = bridge('--no-start');
    assert.equal((await b.call()).text, 'app');
    assert.equal(existsSync(join(consoleDir, 'instances', `${stale.id}.json`)), false, 'the dead entry was deleted');
    await b.close();
  });

  test('skips an entry whose port answers with another pid (a reused pid)', async () => {
    const other = idle().pid!;
    const { port } = await fakeCore('impostor', other);
    const pid = idle().pid!;
    writeInstance({ id: instanceId('dev', pid), installation: 'dev', pid, port, version: '0.0.1', commit: null, dataDir: join(home, 'x'), startedAt: new Date(0).toISOString() }, { home: consoleDir });
    await register('app');
    const b = bridge('--no-start');
    assert.equal((await b.call()).text, 'app');
    await b.close();
  });

  test('mcpb starts its own core on a random port, with --parent on the bridge, and it exits with the bridge', async () => {
    await register('app');
    const b = bridge('--installation', 'mcpb');
    let own: Instance | undefined;
    assert.ok(
      await until(() => {
        own = listInstances({ home: consoleDir }).find((i) => i.installation === 'mcpb');
        return own !== undefined;
      }),
      `the bridge started an mcpb core\n${b.stderr()}`,
    );
    assert.notEqual(own!.port, 4720);
    const lock = readLock(join(consoleDir, 'installations', 'mcpb'));
    assert.ok(lock && lock !== 'invalid');
    assert.equal(lock.parent, b.proc.pid, 'the core watches the bridge');
    const r = await b.call();
    assert.notEqual(r.text, 'app', 'answered by its own core');
    assert.equal(r.isError, false, r.text);
    assert.equal(r.structured, true);
    await b.close();
    assert.ok(await until(() => !isPidAlive(own!.pid)), 'the core exited with the bridge');
  });

  test('follows a core that restarted on another port', async () => {
    const first = await register('dev', { name: 'first' });
    const b = bridge('--no-start');
    assert.equal((await b.call()).text, 'first');
    // The core goes away (its pid dies, its port closes) and comes back with another pid and port.
    first.server.closeAllConnections();
    await new Promise((r) => first.server.close(r));
    process.kill(first.pid, 'SIGKILL');
    await until(() => !isPidAlive(first.pid));
    await register('dev', { name: 'second' });
    assert.equal((await b.call()).text, 'second');
    await b.close();
  });

  test('a core that stops answering is skipped in the same request, before its entry is cleaned', async () => {
    const first = await register('dev', { name: 'first' });
    const b = bridge('--no-start');
    assert.equal((await b.call()).text, 'first');
    // The port closes but the pid still lives (a core hung on exit): the entry stays in the registry.
    first.server.closeAllConnections();
    await new Promise((r) => first.server.close(r));
    await register('dev', { name: 'second' });
    assert.equal((await b.call()).text, 'second');
    await b.close();
  });

  test('dev with no core live starts its own, on the port AHRENA_CONSOLE_CORE_PORT forces', async () => {
    const port = await freePort();
    const b = bridgeWith({ AHRENA_CONSOLE_CORE_PORT: String(port) });
    let own: Instance | undefined;
    assert.ok(
      await until(() => {
        own = listInstances({ home: consoleDir }).find((i) => i.installation === 'dev');
        return own !== undefined;
      }),
      `the bridge started a dev core\n${b.stderr()}`,
    );
    assert.equal(own!.port, port);
    const r = await b.call();
    assert.equal(r.isError, false, r.text);
    assert.equal(r.structured, true);
    await b.close();
    assert.ok(await until(() => !isPidAlive(own!.pid)), 'the core exited with the bridge');
  });

  test('a live core that does not answer is not a reason for dev to start a second one', async () => {
    const hung = await register('app');
    hung.server.closeAllConnections();
    await new Promise((r) => hung.server.close(r));
    const b = bridge();
    const r = await b.call();
    assert.equal(r.isError, true);
    await sleep(1500);
    assert.deepEqual(listInstances({ home: consoleDir }).map((i) => i.installation), ['app'], 'no dev core was started');
    assert.equal(readLock(consoleDir), null);
    await b.close();
  });

  test('a core of its installation that is only in the lock (not in the registry) comes before another installation', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const name of CORE_VARS) delete env[name];
    const start = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CORE_CLI, 'start', '--installation', 'mcpb', '--json', '--', ...HOOKS_ONLY], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    start.stdout!.on('data', (c) => (out += c));
    await new Promise((r) => start.once('close', r));
    const legacy = JSON.parse(out) as { pid: number; porta: number };
    try {
      // As a core from before #221: up, with its lock, but without a registry entry.
      assert.ok(removeInstance(instanceId('mcpb', legacy.pid), { home: consoleDir }));
      await register('app');
      const b = bridge('--installation', 'mcpb');
      assert.ok(await until(async () => (await b.call()).text !== 'app'), `the bridge adopted the core of the lock\n${b.stderr()}`);
      const r = await b.call();
      assert.equal(r.isError, false, r.text);
      assert.equal(r.structured, true);
      await b.close();
    } finally {
      if (isPidAlive(legacy.pid)) process.kill(legacy.pid, 'SIGKILL');
    }
  });

  test('with no core and --no-start, the call says how to start one', async () => {
    const b = bridge('--no-start');
    const r = await b.call();
    assert.equal(r.isError, true);
    assert.match(r.text, /npm run core -- start/);
    await b.close();
  });

  test('--port talks only to that port: no registry, no start', async () => {
    await register('dev');
    const forced = await fakeCore('forced', idle().pid!);
    const b = bridge('--port', String(forced.port));
    assert.equal((await b.call()).text, 'forced');
    await b.close();
    assert.equal(readLock(consoleDir), null);
  });
});
