import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// One version for the product (issue #261): the core announces its package's `version`, which the
// release bumps with the desktop app's (the app's `cargo test` checks the two match). Before, a
// constant fixed at 0.0.1 made the app 0.0.4 show "v0.0.1" in the /ui footer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, API_VERSION, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createMcpServer, type JsonRpcResponse } from '../../src/mcp/index.ts';

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('#261: the core announces its package version', () => {
  test('AC-3: API_VERSION is the version in package.json', () => {
    assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(API_VERSION, PACKAGE_VERSION);
  });

  test('AC-1: /api/overview, the panel footer and the MCP serverInfo say it', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    const accounts = new Accounts({ storage, file: null });
    const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {} });
    try {
      const overview = (await (await fetch(`${api.url}/api/overview`)).json()) as { version: string };
      assert.equal(overview.version, PACKAGE_VERSION);
      const panel = (await (await fetch(`${api.url}/api/panel/any-session`)).json()) as { api: { version: string } };
      assert.equal(panel.api.version, PACKAGE_VERSION);
      const { server } = createMcpServer({ storage, accounts, timeZone: 'UTC' });
      const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })) as JsonRpcResponse;
      assert.equal((r.result as { serverInfo: { version: string } }).serverInfo.version, PACKAGE_VERSION);
    } finally {
      await api.close();
      storage.close();
    }
  });
});
