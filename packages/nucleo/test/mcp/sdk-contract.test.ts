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
import { criarServidorMcp } from '../../src/mcp/index.ts';
import { semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { AGORA, semear } from './helpers.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.ts');

/** As chamadas que exercitam cada forma da saída: grupos, filtros, páginas, vazio. */
const CHAMADAS: [string, Record<string, unknown>][] = [
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

async function exercitar(transporte: Transport) {
  const cliente = new Client({ name: 'contrato', version: '0.0.0' });
  await cliente.connect(transporte);
  try {
    const { tools } = await cliente.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['sessions_needing_attention', 'fleet_overview']);
    for (const t of tools) assert.ok(t.outputSchema, `${t.name} sem outputSchema`);
    for (const [name, args] of CHAMADAS) {
      // O cliente valida contra o outputSchema; um campo fora dele vira McpError aqui.
      const r = await cliente.callTool({ name, arguments: args });
      assert.equal(r.isError, false, `${name} ${JSON.stringify(args)}`);
      assert.ok(r.structuredContent, `${name} sem structuredContent`);
      const cursor = (r.structuredContent as any).nextCursor ?? (r.structuredContent as any).activeSessions?.nextCursor;
      if (cursor) await cliente.callTool({ name, arguments: { ...args, cursor } });
    }
    const errado = await cliente.callTool({ name: 'fleet_overview', arguments: { limit: 0 } });
    assert.equal(errado.isError, true);
  } finally {
    await cliente.close();
  }
}

for (const [nome, semente] of [
  ['casos sintéticos', semear],
  ['cenário p2 do simulador', (s: SqliteStorage) => semearCenariosDoPainel(s, 'p2', AGORA)],
  ['banco vazio', async () => {}],
] as const) {
  describe(`contrato com o cliente oficial: ${nome}`, () => {
    let storage: SqliteStorage;
    let api: ApiLocal;
    before(async () => {
      storage = openSqliteStorage({ path: ':memory:' });
      await semente(storage);
      const contas = new Contas({ storage, arquivo: null });
      const { servidor } = criarServidorMcp({ storage, contas, agora: () => AGORA, fusoHorario: 'UTC' });
      api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: servidor });
    });
    after(async () => {
      await api.close();
      await storage.close();
    });

    test('HTTP: a saída das ferramentas passa no outputSchema', () => exercitar(new StreamableHTTPClientTransport(new URL(`${api.url}/mcp`))));

    test('stdio (a ponte do Desktop): a saída das ferramentas passa no outputSchema', () =>
      exercitar(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', CLI, '--porta', new URL(api.url).port],
          stderr: 'ignore',
        }),
      ));
  });
}

test('stdio sem o núcleo: o cliente oficial conecta, lista as ferramentas e a chamada volta com isError', async () => {
  // Uma porta que ninguém escuta: sobe e derruba uma API para pegar uma livre.
  const storage = openSqliteStorage({ path: ':memory:' });
  const contas = new Contas({ storage, arquivo: null });
  const api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {} });
  const porta = new URL(api.url).port;
  await api.close();
  await storage.close();

  const cliente = new Client({ name: 'contrato', version: '0.0.0' });
  await cliente.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', CLI, '--porta', porta], stderr: 'ignore' }));
  try {
    const { tools } = await cliente.listTools();
    assert.equal(tools.length, 2);
    const r = await cliente.callTool({ name: 'sessions_needing_attention', arguments: {} });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /npm run api/);
  } finally {
    await cliente.close();
  }
});
