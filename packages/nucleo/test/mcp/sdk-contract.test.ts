// Contract with the official MCP client (@modelcontextprotocol/sdk, a devDependency at the version
// Claude Code uses): it validates each `structuredContent` against the tool's `outputSchema` and
// fails the call with -32602 if a field is extra or missing. Over HTTP (/mcp) and over stdio (the
// Desktop bridge), with synthetic data.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { createMcpServer } from '../../src/mcp/index.ts';
import { semearCenariosDoPainel } from '../../src/simulator/panel.ts';
import { NOW, seed } from './helpers.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.ts');

/** The calls that exercise every shape of the output: groups, filters, pages, empty. */
const CALLS: [string, Record<string, unknown>][] = [
  ['sessions_needing_attention', {}],
  ['sessions_needing_attention', { group: 'blocking' }],
  ['sessions_needing_attention', { group: 'your_turn', account: 'equipe' }],
  ['sessions_needing_attention', { account: 'none' }],
  ['sessions_needing_attention', { account: 'não-existe' }],
  ['sessions_needing_attention', { limit: 2 }],
  ['fleet_overview', {}],
  ['fleet_overview', { account: ['cliente', 'none'] }],
  ['fleet_overview', { account: 'não-existe' }],
  ['fleet_overview', { limit: 1 }],
];

async function exercise(transport: Transport) {
  const client = new Client({ name: 'contrato', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['sessions_needing_attention', 'fleet_overview']);
    for (const t of tools) assert.ok(t.outputSchema, `${t.name} has no outputSchema`);
    for (const [name, args] of CALLS) {
      // The client validates against the outputSchema; a field outside it becomes an McpError here.
      const r = await client.callTool({ name, arguments: args });
      assert.equal(r.isError, false, `${name} ${JSON.stringify(args)}`);
      assert.ok(r.structuredContent, `${name} has no structuredContent`);
      const cursor = (r.structuredContent as any).nextCursor ?? (r.structuredContent as any).activeSessions?.nextCursor;
      if (cursor) await client.callTool({ name, arguments: { ...args, cursor } });
    }
    const wrong = await client.callTool({ name: 'fleet_overview', arguments: { limit: 0 } });
    assert.equal(wrong.isError, true);
  } finally {
    await client.close();
  }
}

for (const [name, seedWith] of [
  ['synthetic cases', seed],
  ['simulator scenario p2', (s: SqliteStorage) => semearCenariosDoPainel(s, 'p2', NOW)],
  ['empty database', async () => {}],
] as const) {
  describe(`contract with the official client: ${name}`, () => {
    let storage: SqliteStorage;
    let api: ApiLocal;
    before(async () => {
      storage = openSqliteStorage({ path: ':memory:' });
      await seedWith(storage);
      const accounts = new Contas({ storage, arquivo: null });
      const { server } = createMcpServer({ storage, accounts, now: () => NOW, timeZone: 'UTC' });
      api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: server });
    });
    after(async () => {
      await api.close();
      await storage.close();
    });

    test('HTTP: the tools output passes the outputSchema', () => exercise(new StreamableHTTPClientTransport(new URL(`${api.url}/mcp`))));

    test('stdio (the Desktop bridge): the tools output passes the outputSchema', () =>
      exercise(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', CLI, '--port', new URL(api.url).port],
          stderr: 'ignore',
        }),
      ));
  });
}

test('stdio without the core: the official client connects, lists the tools and the call comes back with isError', async () => {
  // A port nobody listens on: start and stop an API to get a free one.
  const storage = openSqliteStorage({ path: ':memory:' });
  const accounts = new Contas({ storage, arquivo: null });
  const api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {} });
  const port = new URL(api.url).port;
  await api.close();
  await storage.close();

  const client = new Client({ name: 'contrato', version: '0.0.0' });
  // The old option name (`--porta`) is still accepted until phase 6 of #173.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', CLI, '--porta', port], stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 2);
    const r = await client.callTool({ name: 'sessions_needing_attention', arguments: {} });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /npm run api/);
  } finally {
    await client.close();
  }
});
