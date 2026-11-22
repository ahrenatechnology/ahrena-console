// The console MCP keeps its tool list and registers nothing of the ai-memory (#735/AC-4, #719/AC-14) (#735): the list is pinned, no `memory_*` tool exists, and the MCP sources do not reach the memory module.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts } from '../../src/api/index.ts';
import { createMcpServer, serverWithoutCore, type JsonRpcResponse, type McpServer } from '../../src/mcp/index.ts';
import { NOW } from './helpers.ts';

// The tool list of the console MCP as of (#735) and (#719/AC-14): a change to it is a decision, not a side effect.
const PINNED_TOOLS = ['sessions_needing_attention', 'fleet_overview'];

async function toolNames(server: McpServer): Promise<string[]> {
  const r = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse;
  return (r.result as { tools: { name: string }[] }).tools.map((t) => t.name);
}

let storage: SqliteStorage;
beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
});
afterEach(() => storage.close());

describe('#735/AC-4 #719/AC-14 the console MCP tool list is unchanged and has no memory tool', () => {
  test('#735/AC-4 #719/AC-14 Given the console MCP with its core, When it lists its tools, Then they are the pinned two and none is memory_*', async () => {
    const { server } = createMcpServer({ storage, accounts: new Accounts({ storage, file: null }), now: () => NOW, timeZone: 'UTC' });
    const names = await toolNames(server);
    assert.deepEqual(names, PINNED_TOOLS);
    assert.deepEqual(names.filter((n) => /^memory_|memory/i.test(n)), []);
  });

  test('#735/AC-4 #719/AC-14 Given the console MCP with no core, When it lists its tools, Then it holds no memory tool either', async () => {
    const names = await toolNames(serverWithoutCore('the memory test'));
    assert.deepEqual(names.filter((n) => /memory/i.test(n)), []);
    assert.ok(names.every((n) => PINNED_TOOLS.includes(n)), names.join(','));
  });

  test('#735/AC-4 #719/AC-14 the MCP sources register no memory_ tool and import neither the memory module nor the embedded binary', () => {
    const dir = fileURLToPath(new URL('../../src/mcp/', import.meta.url));
    const sources: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(current, entry.name));
        else if (/\.ts$/.test(entry.name)) sources.push(join(current, entry.name));
      }
    };
    walk(dir);
    assert.ok(sources.length > 3);
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      assert.equal(/['"`]memory_[a-z_]+['"`]/.test(text), false, `${path} names a memory_ tool`);
      assert.equal(/from\s+['"][^'"]*(?:\/memory\/|embedded-ai-memory)/.test(text), false, `${path} imports the memory module`);
    }
  });
});
