// The plugin's forwarder and hooks.json, run as Claude Code would: one process per hook, the payload
// on stdin, `${CLAUDE_PLUGIN_ROOT}` pointing at the plugin folder.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      assert.match(r.log, /Notification recusado pelo núcleo: HTTP 500 quebrado/);
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
    const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, { AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '300' }, { keepStdinOpen: true });
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
