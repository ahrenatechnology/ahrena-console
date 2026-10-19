// O encaminhador e o hooks.json do plugin, rodados como o Claude Code rodaria: um processo por hook,
// payload no stdin, `${CLAUDE_PLUGIN_ROOT}` apontando para a pasta do plugin.

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

const dir = mkdtempSync(join(tmpdir(), 'ahrena-hooks-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let logN = 0;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  log: string;
}

/** Roda o comando do hooks.json como o Claude Code: via shell, com o payload no stdin. */
function runHook(event: string, payload: unknown, env: Record<string, string>, opts: { keepStdinOpen?: boolean } = {}): Promise<Run> {
  const command = hooksJson.hooks[event][0].hooks[0].command;
  const logPath = join(dir, `hooks-${logN++}.log`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, AHRENA_CONSOLE_HOOK_LOG: logPath, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      let log = '';
      try {
        log = readFileSync(logPath, 'utf8');
      } catch {
        // sem log: nada falhou
      }
      resolve({ code, stdout, stderr, ms: Date.now() - started, log });
    });
    child.stdin.write(JSON.stringify(payload));
    if (!opts.keepStdinOpen) child.stdin.end();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe('hooks.json do plugin', () => {
  test('registra o encaminhador em todos os eventos, com timeout curto', () => {
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

describe('encaminhador com o núcleo no ar', () => {
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

  test('cada evento chega ao núcleo, sem nada no stdout', async () => {
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

describe('encaminhador com o núcleo fora', () => {
  test('núcleo desligado: sai 0 na hora e registra', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));

    const r = await runHook('PreToolUse', HOOK_PAYLOADS.PreToolUse, { AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}` });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 2000, `demorou ${r.ms} ms`);
    assert.match(r.log, /PreToolUse não enviado a http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED/);
  });

  test('núcleo travado: desiste no timeout e sai 0', async () => {
    const hung = createServer(() => {
      // aceita e nunca responde
    });
    const port = await listen(hung);
    try {
      const r = await runHook('Stop', HOOK_PAYLOADS.Stop, {
        AHRENA_CONSOLE_URL: `http://127.0.0.1:${port}`,
        AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '300',
      });
      assert.equal(r.code, 0);
      assert.ok(r.ms < 2000, `demorou ${r.ms} ms`);
      assert.match(r.log, /Stop não enviado .*TimeoutError/);
    } finally {
      hung.closeAllConnections();
      await new Promise((r) => hung.close(r));
    }
  });

  test('núcleo recusando: sai 0 e registra o status', async () => {
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

  test('stdin que não fecha não prende o hook', async () => {
    const r = await runHook('SessionStart', HOOK_PAYLOADS.SessionStart, { AHRENA_CONSOLE_HOOK_TIMEOUT_MS: '300' }, { keepStdinOpen: true });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 2000, `demorou ${r.ms} ms`);
    assert.match(r.log, /SessionStart não enviado: stdin não fechou a tempo/);
  });
});
