// Contract of `wait_for_changes` with the official MCP client (@modelcontextprotocol/sdk, the same
// devDependency as test/mcp/sdk-contract.test.ts): it validates each `structuredContent` against the
// `outputSchema` and fails the call if a field is extra or missing. Over HTTP (/mcp) and over stdio (the
// Desktop bridge), with synthetic data and a wait that only the change wakes up.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import { createMcpServer } from '../../src/mcp/index.ts';
import { ChangeCursor, withChanges, waitForChanges, WAIT_FOR_CHANGES, type WaitForChangesOutput } from '../../src/changes/index.ts';
import { c1, c2, seed } from '../mcp/helpers.ts';
import { session } from '../fixtures.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.ts');

describe('wait_for_changes with the official client', () => {
  let sqlite: SqliteStorage;
  let storage: SqliteStorage;
  let changes: ChangeCursor;
  let api: LocalApi;
  before(async () => {
    sqlite = openSqliteStorage({ path: ':memory:' });
    await seed(sqlite);
    changes = new ChangeCursor({ minIntervalMs: 0, batchMs: 0 });
    storage = withChanges(sqlite, changes);
    const accounts = new Accounts({ storage, file: null });
    const { server } = createMcpServer({ storage, accounts });
    server.register(waitForChanges({ changes, accounts }));
    api = await startLocalApi({ panelBuilder: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: server, changes });
  });
  after(async () => {
    await api.close();
    await sqlite.close();
  });

  let n = 0;
  async function exercise(transport: Transport) {
    const client = new Client({ name: 'contrato', version: '0.0.0' });
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) => {
      // The client validates against the outputSchema; a field outside it becomes an McpError here.
      const r = await client.callTool({ name: WAIT_FOR_CHANGES, arguments: args });
      assert.equal(r.isError, false, JSON.stringify(args));
      return r.structuredContent as unknown as WaitForChangesOutput;
    };
    try {
      const { tools } = await client.listTools();
      const f = tools.find((t) => t.name === WAIT_FOR_CHANGES);
      assert.ok(f?.outputSchema, 'wait_for_changes with outputSchema');

      const start = await call({});
      assert.equal(start.reset, true);
      const empty = await call({ cursor: start.cursor, timeout: 0 });
      assert.deepEqual([empty.reset, empty.timedOut, empty.changes], [false, false, []]);

      // A wait that only the change wakes up, with each account shape in the output.
      const k = ++n;
      const pending = call({ cursor: start.cursor, timeout: 20 });
      while (changes.openWaits === 0) await new Promise((r) => setImmediate(r));
      await storage.putSession(session({ id: `nova-${k}-a`, accountId: c1.id, accountSource: 'env' }));
      const r = await pending;
      assert.deepEqual(r.changes.map((m) => [m.type, m.sessionId, m.account?.label]), [['session', `nova-${k}-a`, 'equipe']]);

      // The old type name (`sessao`) is still accepted (#173 phase 2b), the answer is English.
      const filtered = call({ cursor: r.cursor, timeout: 20, account: ['cliente', 'none'], types: ['sessao'], sessions: [`nova-${k}-b`, `nova-${k}-c`] });
      while (changes.openWaits === 0) await new Promise((r) => setImmediate(r));
      await storage.putSession(session({ id: `nova-${k}-x`, accountId: c2.id, accountSource: 'env' }));
      await storage.putSession(session({ id: `nova-${k}-b`, accountId: c1.id, accountSource: 'env' }));
      await storage.putSession(session({ id: `nova-${k}-c` }));
      const rf = await filtered;
      assert.deepEqual(rf.changes.map((m) => [m.sessionId, m.account]), [[`nova-${k}-c`, null]]);

      const timedOut = await call({ cursor: rf.cursor, timeout: 0.05 });
      assert.equal(timedOut.timedOut, true);

      const wrong = await client.callTool({ name: WAIT_FOR_CHANGES, arguments: { types: ['outro'] } });
      assert.equal(wrong.isError, true);
    } finally {
      await client.close();
    }
  }

  test('HTTP: the output passes the outputSchema', () => exercise(new StreamableHTTPClientTransport(new URL(`${api.url}/mcp`))));

  test('stdio (the Desktop bridge): the output passes the outputSchema', () =>
    exercise(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', CLI, '--porta', new URL(api.url).port],
        stderr: 'ignore',
      }),
    ));
});
