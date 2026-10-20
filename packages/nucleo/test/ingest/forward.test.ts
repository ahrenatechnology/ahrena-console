// The plugin's forwarder and hooks.json, run as Claude Code would: one process per hook, the payload
// on stdin, `${CLAUDE_PLUGIN_ROOT}` pointing at the plugin folder.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { HOOK_EVENTS, startHookReceiver, type HookReceiver } from '../../src/ingest/hooks/index.ts';
import { HOOK_NAMES, HOOK_PAYLOADS } from './hook-payloads.ts';

const PLUGIN_ROOT = fileURLToPath(new URL('../../src/ingest/hooks/plugin', import.meta.url));
const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
};

/**
 * The forwarder's deadline in the tests that are not about the deadline. The 800 ms default counts from
 * the script's load on the real clock, and on a loaded machine booting `fetch` and reaching the core take
 * longer: the hook gave up with TimeoutError and the test failed for reasons unrelated to the deadline
 * (#165). With a generous deadline, these tests no longer depend on the clock.
 */
const SLACK_MS = 30_000;
/** Safety net: a hook that does not exit even with the slack is a bug, and the test fails instead of hanging. */
const GUARD_MS = 2 * SLACK_MS;

const dir = mkdtempSync(join(tmpdir(), 'ahrena-hooks-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let logN = 0;
/**
 * The default console home of every run: empty, so no test ever reaches a core of the machine through
 * the real registry. The fan-out tests pass their own.
 */
const EMPTY_HOME = join(dir, 'empty-home');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  log: string;
}

/** O ambiente de quem roda os testes, sem a conta, a pasta de configuração e o SSH dele. */
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_|SSH_)/.test(k)),
);

/** Roda o comando do hooks.json como o Claude Code: via shell, com o payload no stdin. */
function runHook(event: string, payload: unknown, env: Record<string, string>, opts: { keepStdinOpen?: boolean } = {}): Promise<Run> {
  const command = hooksJson.hooks[event][0].hooks[0].command;
  const logPath = join(dir, `hooks-${logN++}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...cleanEnv,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        AHRENA_CONSOLE_HOOK_LOG: logPath,
        AHRENA_CONSOLE_HOOK_TIMEOUT_MS: String(SLACK_MS),
        AHRENA_CONSOLE_HOME: EMPTY_HOME,
        ...env,
      },
    });
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${event}: the hook did not exit in ${GUARD_MS} ms`));
    }, GUARD_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(guard);
      let log = '';
      try {
        log = readFileSync(logPath, 'utf8');
      } catch {
        // sem log: nada falhou
      }
      resolve({ code, stdout, stderr, log });
    });
    child.stdin.write(JSON.stringify(payload));
    if (!opts.keepStdinOpen) child.stdin.end();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe("the plugin's hooks.json", () => {
  test('registers the forwarder on every event, with a short timeout', () => {
    assert.deepEqual(Object.keys(hooksJson.hooks).sort(), [...HOOK_EVENTS].sort());
    for (const [event, groups] of Object.entries(hooksJson.hooks)) {
      const [hook] = groups[0].hooks;
      assert.equal(hook.type, 'command', event);
      assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/forward\.mjs/);
      assert.ok(hook.timeout > 0 && hook.timeout <= 5, `${event}: timeout ${hook.timeout}s`);
      if (event.endsWith('ToolUse')) assert.equal(groups[0].matcher, '*');
    }
  });
});

describe('forwarder with the core up', () => {
  let store: SqliteStorage;
  let receiver: HookReceiver;
  beforeEach(async () => {
    store = openSqliteStorage({ path: ':memory:' });
    receiver = await startHookReceiver({ storage: store, port: 0, log: () => {} });
  });
  afterEach(async () => {
    await receiver.close();
    await store.close();
  });

  test('each event reaches the core, with nothing on stdout', async () => {
    for (const name of HOOK_NAMES) {
      const r = await runHook(name, HOOK_PAYLOADS[name], { AHRENA_CONSOLE_URL: receiver.url });
      assert.equal(r.code, 0, name);
      assert.equal(r.stdout, '', `${name} não pode escrever no stdout`);
      assert.equal(r.log, '', `${name}: ${r.log}`);
    }
    const events = (await store.listEvents('sess-hooks-1')).items;
    assert.deepEqual(events.map((e) => e.type), HOOK_NAMES);
    assert.ok(events.every((e) => e.id.startsWith('hook:')));
  });
});

describe('forwarder with the core away', () => {
  test('core down: exits 0 without waiting for the deadline and logs', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));

    const r = await runHook('PreToolUse', HOOK_PAYLOADS.PreToolUse, { AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}` });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    // ECONNREFUSED, not TimeoutError, proves it gave up on the refusal, without waiting SLACK_MS.
    assert.match(r.log, /PreToolUse não enviado a http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED/);
  });

  test('core hung: gives up on the timeout and exits 0', async () => {
    let arrived = 0;
    const hung = createServer(() => {
      arrived++; // aceita e nunca responde
    });
    const port = await listen(hung);
    try {
      // O prazo cobre leitura e envio. O stdin já está escrito e fechado quando o script carrega, então
      // a leitura leva poucos milissegundos; 1 s deixa margem para ela e ainda vence no envio.
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, {
        AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}`,
        AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '1000',
      });
      // Exiting while the server is still silent already proves it gave up: without a deadline, fetch
      // would wait forever and runHook would hit GUARD_MS.
      assert.equal(r.code, 0);
      assert.equal(arrived, 1, `o pedido não chegou ao núcleo: ${r.log}`);
      assert.match(r.log, /Stop não enviado .*TimeoutError/);
    } finally {
      hung.closeAllConnections();
      await new Promise((r) => hung.close(r));
    }
  });

  test('core refusing: exits 0 and logs the status', async () => {
    const angry = createServer((_req, res) => {
      res.writeHead(500);
      res.end('quebrado');
    });
    const port = await listen(angry);
    try {
      const r = await runHook('Notification', HOOK_PAYLOADS.Notification, { AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}` });
      assert.equal(r.code, 0);
      assert.match(r.log, new RegExp(`Notification recusado pelo núcleo http://127\\.0\\.0\\.1:${port}: HTTP 500 quebrado`));
    } finally {
      await new Promise((r) => angry.close(r));
    }
  });

  test('core off the machine: refuses without sending anything', async () => {
    for (const url of ['http://192.0.2.10:4720', 'http://127.0.0.1.example.test:4720', 'file:///tmp/x', 'não é url']) {
      const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, { AHRENA_CONSOLE_URL: url });
      assert.equal(r.code, 0, url);
      assert.equal(r.stdout, '', url);
      assert.match(r.log, /SessionStart não enviado: AHRENA_CONSOLE_URL precisa ser 127\.0\.0\.1, localhost ou ::1/, url);
    }
  });

  test('::1 counts as a local core', async () => {
    let hits = 0;
    const v6 = createServer((_req, res) => {
      hits++;
      res.writeHead(202);
      res.end('{}');
    });
    const port = await new Promise<number>((resolve) => v6.listen(0, '::1', () => resolve((v6.address() as AddressInfo).port)));
    try {
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_URL: `http://[::1]:${port}` });
      assert.equal(r.log, '');
      assert.equal(hits, 1);
    } finally {
      await new Promise((r) => v6.close(r));
    }
  });

  test('stdin that never closes does not hold the hook', async () => {
    // Com o stdin aberto, só o prazo encerra a leitura; sair já prova que ele valeu.
    const r = await runHook(
      'SessionStart',
      HOOK_PAYLOADS.SessionStart,
      { AHRENA_CONSOLE_URL: 'http://127.0.0.1:9', AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '300' },
      { keepStdinOpen: true },
    );
    assert.equal(r.code, 0);
    assert.match(r.log, /SessionStart não enviado: stdin não fechou a tempo/);
  });
});

describe("forwarder sends the environment's folder and account", () => {
  const ACCOUNT = '00000000-0000-4000-8000-00000000000a';
  const ORG = '00000000-0000-4000-8000-000000000001';

  async function capture(env: Record<string, string>): Promise<Record<string, unknown>> {
    let received = '';
    const server = createServer((req, res) => {
      req.on('data', (c) => (received += c));
      req.on('end', () => {
        res.writeHead(202);
        res.end('{}');
      });
    });
    const port = await listen(server);
    try {
      const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, { AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}`, ...env });
      assert.equal(r.code, 0);
      assert.equal(r.log, '');
    } finally {
      await new Promise((r) => server.close(r));
    }
    return JSON.parse(received) as Record<string, unknown>;
  }

  test('only the three variables, in their own field, and the payload intact', async () => {
    const body = await capture({
      CLAUDE_CONFIG_DIR: '/cfg/sintetica',
      CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT,
      CLAUDE_CODE_ORGANIZATION_UUID: ORG,
      CLAUDE_CODE_USER_EMAIL: 'pessoa@example.test',
      CLAUDE_CODE_OAUTH_TOKEN: 'token-sintetico',
      ANTHROPIC_API_KEY: 'chave-sintetica',
    });
    const { ahrena_console: context, ...payload } = body;
    assert.deepEqual(payload, HOOK_PAYLOADS.SessionStart);
    assert.deepEqual(context, {
      env: { CLAUDE_CONFIG_DIR: '/cfg/sintetica', CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT, CLAUDE_CODE_ORGANIZATION_UUID: ORG },
    });
    assert.doesNotMatch(JSON.stringify(body), /chave-sintetica|token-sintetico|example\.test/);
  });

  test('over SSH, only the ssh mark, never the value of SSH_CONNECTION', async () => {
    const body = await capture({ SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22' });
    assert.deepEqual(body.ahrena_console, { env: { ssh: true } });
    assert.doesNotMatch(JSON.stringify(body), /192\.0\.2/);
  });

  test('end to end, the session reaches the core with the account', async () => {
    const store = openSqliteStorage({ path: ':memory:' });
    const receiver = await startHookReceiver({ storage: store, port: 0, log: () => {} });
    try {
      const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, {
        AHRENA_CONSOLE_URL: receiver.url,
        CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT,
        CLAUDE_CODE_ORGANIZATION_UUID: ORG,
      });
      assert.equal(r.log, '');
      const s = await store.getSession('sess-hooks-1');
      assert.equal(s?.accountId, `${ACCOUNT}/${ORG}`);
      assert.equal(s?.accountSource, 'env');
    } finally {
      await receiver.close();
      await store.close();
    }
  });
});

describe('forwarder fans out to every live core in the registry (decision 0010, item 4)', () => {
  interface Hit {
    deliveryId: string | undefined;
    host: string | undefined;
    body: string;
  }
  interface FakeCore {
    port: number;
    hits: Hit[];
    close(): Promise<void>;
  }

  /** A core that answers 202 to every hook, or that accepts and never answers (`hang`). */
  async function fakeCore(o: { hang?: boolean } = {}): Promise<FakeCore> {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ deliveryId: req.headers['x-ahrena-delivery-id'] as string | undefined, host: req.headers.host, body });
        if (o.hang) return;
        res.writeHead(202);
        res.end('{}');
      });
    });
    const port = await listen(server);
    return {
      port,
      hits,
      close: async () => {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      },
    };
  }

  let homeN = 0;
  /** A fresh console home, with an empty `instances` folder. */
  function newHome(): string {
    const home = join(dir, `home-${homeN++}`);
    mkdirSync(join(home, 'instances'), { recursive: true });
    return home;
  }

  /** Writes a registry entry the way the core does: `<id>.json` with the `Instance` fields. */
  function register(home: string, installation: string, pid: number, port: number, file = `${installation}-${pid}.json`): void {
    const entry = { id: `${installation}-${pid}`, installation, pid, port, version: '0.0.0', commit: null, dataDir: home, startedAt: new Date().toISOString() };
    writeFileSync(join(home, 'instances', file), JSON.stringify(entry));
  }

  /** The pid of a process that has already exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    assert.ok(child.pid);
    return child.pid;
  }

  const live = process.pid;

  test('two live cores both get the event, as one delivery with the same body', async () => {
    const a = await fakeCore();
    const b = await fakeCore();
    try {
      const home = newHome();
      register(home, 'dev', live, a.port);
      register(home, 'app', live, b.port);
      const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, { AHRENA_CONSOLE_HOME: home });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.log, '');
      assert.equal(a.hits.length, 1);
      assert.equal(b.hits.length, 1);
      assert.match(a.hits[0].deliveryId ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(a.hits[0].deliveryId, b.hits[0].deliveryId);
      assert.equal(a.hits[0].body, b.hits[0].body);
      assert.equal(a.hits[0].host, `127.0.0.1:${a.port}`);
      assert.equal(b.hits[0].host, `127.0.0.1:${b.port}`);
      const { ahrena_console: _context, ...payload } = JSON.parse(a.hits[0].body) as Record<string, unknown>;
      assert.deepEqual(payload, HOOK_PAYLOADS.SessionStart);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('end to end, the event lands in the database of both cores', async () => {
    const stores = [openSqliteStorage({ path: ':memory:' }), openSqliteStorage({ path: ':memory:' })];
    const receivers = await Promise.all(stores.map((storage) => startHookReceiver({ storage, port: 0, log: () => {} })));
    try {
      const home = newHome();
      register(home, 'dev', live, Number(new URL(receivers[0].url).port));
      register(home, 'app', live, Number(new URL(receivers[1].url).port));
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_HOME: home });
      assert.equal(r.log, '');
      for (const store of stores) assert.deepEqual((await store.listEvents('sess-hooks-1')).items.map((e) => e.type), ['Stop']);
    } finally {
      await Promise.all(receivers.map((rc) => rc.close()));
      await Promise.all(stores.map((s) => s.close()));
    }
  });

  test('dead-pid, malformed and foreign files are skipped and left in place', async () => {
    const core = await fakeCore();
    const decoy = await fakeCore();
    try {
      const home = newHome();
      const instances = join(home, 'instances');
      register(home, 'dev', live, core.port);
      register(home, 'app', await deadPid(), decoy.port);
      writeFileSync(join(instances, 'mcpb-7.json'), '{ not json');
      writeFileSync(join(instances, 'mcpb-8.json'), JSON.stringify({ id: 'mcpb-8', installation: 'mcpb', pid: live, port: 0 }));
      register(home, 'dev', live, decoy.port, 'notes.json');
      register(home, 'dev', live, decoy.port, `app-${live}.json`); // its id says dev
      register(home, 'dev', live, decoy.port, '.dev-1.json.tmp');
      mkdirSync(join(instances, 'dev-9.json'));
      const before = readdirSync(instances).sort();

      const r = await runHook('PostToolUse', HOOK_PAYLOADS.PostToolUse, { AHRENA_CONSOLE_HOME: home });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.log, '');
      assert.equal(core.hits.length, 1);
      assert.equal(decoy.hits.length, 0);
      assert.deepEqual(readdirSync(instances).sort(), before, 'the hook never deletes registry files');
    } finally {
      await core.close();
      await decoy.close();
    }
  });

  test('AHRENA_CONSOLE_URL or AHRENA_CONSOLE_PORT sends to that core only', async () => {
    const a = await fakeCore();
    const b = await fakeCore();
    const forced = await fakeCore();
    try {
      const home = newHome();
      register(home, 'dev', live, a.port);
      register(home, 'app', live, b.port);
      const byUrl = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_HOME: home, AHRENA_CONSOLE_URL: `http://127.0.0.1:${forced.port}/` });
      assert.equal(byUrl.log, '');
      assert.deepEqual([forced.hits.length, a.hits.length, b.hits.length], [1, 0, 0]);
      const byPort = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_HOME: home, AHRENA_CONSOLE_PORT: String(forced.port) });
      assert.equal(byPort.log, '');
      assert.deepEqual([forced.hits.length, a.hits.length, b.hits.length], [2, 0, 0]);
    } finally {
      await a.close();
      await b.close();
      await forced.close();
    }
  });

  test('no live core: exits 0 at once, with no request, no stdout and no log line', async () => {
    const decoy = await fakeCore();
    try {
      const home = newHome();
      register(home, 'dev', await deadPid(), decoy.port);
      for (const env of [{ AHRENA_CONSOLE_HOME: home }, {}, { AHRENA_CONSOLE_HOME: join(dir, 'no-such-home') }]) {
        const started = Date.now();
        const r = await runHook('UserPromptSubmit', HOOK_PAYLOADS.UserPromptSubmit, env);
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '');
        assert.equal(r.log, '');
        // Far below SLACK_MS: it did not wait for a deadline.
        assert.ok(Date.now() - started < SLACK_MS / 3, `took ${Date.now() - started} ms`);
      }
      assert.equal(decoy.hits.length, 0);
    } finally {
      await decoy.close();
    }
  });

  test('without AHRENA_CONSOLE_HOME, the registry is ~/.ahrena-console/instances', async () => {
    const core = await fakeCore();
    try {
      const fakeHomeDir = join(dir, `user-${homeN++}`);
      const home = join(fakeHomeDir, '.ahrena-console');
      mkdirSync(join(home, 'instances'), { recursive: true });
      register(home, 'dev', live, core.port);
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_HOME: '', HOME: fakeHomeDir });
      assert.equal(r.log, '');
      assert.equal(core.hits.length, 1);
    } finally {
      await core.close();
    }
  });

  test('a hung core does not hold the others, and the deadline still holds', async () => {
    const hung = await fakeCore({ hang: true });
    const ok = await fakeCore();
    try {
      const home = newHome();
      register(home, 'dev', live, hung.port);
      register(home, 'app', live, ok.port);
      const started = Date.now();
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, { AHRENA_CONSOLE_HOME: home, AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '1000' });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.ok(Date.now() - started < SLACK_MS / 3, `took ${Date.now() - started} ms`);
      assert.equal(ok.hits.length, 1);
      assert.equal(hung.hits.length, 1, `the request did not reach the hung core: ${r.log}`);
      assert.equal(ok.hits[0].deliveryId, hung.hits[0].deliveryId);
      assert.match(r.log, new RegExp(`Stop não enviado a http://127\\.0\\.0\\.1:${hung.port}: TimeoutError`));
      assert.doesNotMatch(r.log, new RegExp(`:${ok.port}\\b`));
    } finally {
      await hung.close();
      await ok.close();
    }
  });
});
