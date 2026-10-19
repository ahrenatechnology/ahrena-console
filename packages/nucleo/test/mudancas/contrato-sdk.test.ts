// Contrato de `wait_for_changes` com o cliente oficial do MCP (@modelcontextprotocol/sdk, a mesma
// devDependency de test/mcp/contrato-sdk.test.ts): ele valida cada `structuredContent` contra o
// `outputSchema` e derruba a chamada se um campo sobra ou falta. Pelo HTTP (/mcp) e pelo stdio (a
// ponte do Desktop), com dados sintéticos e uma espera que só a mudança acorda.

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
import { CursorDeMudancas, comMudancas, waitForChanges, WAIT_FOR_CHANGES, type SaidaDoWaitForChanges } from '../../src/mudancas/index.ts';
import { c1, c2, semear } from '../mcp/helpers.ts';
import { session } from '../fixtures.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.ts');

describe('wait_for_changes com o cliente oficial', () => {
  let sqlite: SqliteStorage;
  let storage: SqliteStorage;
  let mudancas: CursorDeMudancas;
  let api: ApiLocal;
  before(async () => {
    sqlite = openSqliteStorage({ path: ':memory:' });
    await semear(sqlite);
    mudancas = new CursorDeMudancas({ intervaloMinimoMs: 0, agruparMs: 0 });
    storage = comMudancas(sqlite, mudancas);
    const contas = new Contas({ storage, arquivo: null });
    const { servidor } = criarServidorMcp({ storage, contas });
    servidor.registrar(waitForChanges({ mudancas, contas }));
    api = await iniciarApiLocal({ montador: new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null }), hooks: { storage }, port: 0, log: () => {}, mcp: servidor, mudancas });
  });
  after(async () => {
    await api.close();
    await sqlite.close();
  });

  let n = 0;
  async function exercitar(transporte: Transport) {
    const cliente = new Client({ name: 'contrato', version: '0.0.0' });
    await cliente.connect(transporte);
    const chamar = async (args: Record<string, unknown>) => {
      // O cliente valida contra o outputSchema; um campo fora dele vira McpError aqui.
      const r = await cliente.callTool({ name: WAIT_FOR_CHANGES, arguments: args });
      assert.equal(r.isError, false, JSON.stringify(args));
      return r.structuredContent as unknown as SaidaDoWaitForChanges;
    };
    try {
      const { tools } = await cliente.listTools();
      const f = tools.find((t) => t.name === WAIT_FOR_CHANGES);
      assert.ok(f?.outputSchema, 'wait_for_changes com outputSchema');

      const inicio = await chamar({});
      assert.equal(inicio.reset, true);
      const vazio = await chamar({ cursor: inicio.cursor, timeout: 0 });
      assert.deepEqual([vazio.reset, vazio.timedOut, vazio.changes], [false, false, []]);

      // Uma espera que só a mudança acorda, com cada forma de conta na saída.
      const k = ++n;
      const pendente = chamar({ cursor: inicio.cursor, timeout: 20 });
      while (mudancas.abertas === 0) await new Promise((r) => setImmediate(r));
      await storage.putSession(session({ id: `nova-${k}-a`, accountId: c1.id, accountSource: 'env' }));
      const r = await pendente;
      assert.deepEqual(r.changes.map((m) => [m.type, m.sessionId, m.account?.label]), [['sessao', `nova-${k}-a`, 'equipe']]);

      const filtrada = chamar({ cursor: r.cursor, timeout: 20, account: ['cliente', 'none'], types: ['sessao'], sessions: [`nova-${k}-b`, `nova-${k}-c`] });
      while (mudancas.abertas === 0) await new Promise((r) => setImmediate(r));
      await storage.putSession(session({ id: `nova-${k}-x`, accountId: c2.id, accountSource: 'env' }));
      await storage.putSession(session({ id: `nova-${k}-b`, accountId: c1.id, accountSource: 'env' }));
      await storage.putSession(session({ id: `nova-${k}-c` }));
      const rf = await filtrada;
      assert.deepEqual(rf.changes.map((m) => [m.sessionId, m.account]), [[`nova-${k}-c`, null]]);

      const expirou = await chamar({ cursor: rf.cursor, timeout: 0.05 });
      assert.equal(expirou.timedOut, true);

      const errado = await cliente.callTool({ name: WAIT_FOR_CHANGES, arguments: { types: ['outro'] } });
      assert.equal(errado.isError, true);
    } finally {
      await cliente.close();
    }
  }

  test('HTTP: a saída passa no outputSchema', () => exercitar(new StreamableHTTPClientTransport(new URL(`${api.url}/mcp`))));

  test('stdio (a ponte do Desktop): a saída passa no outputSchema', () =>
    exercitar(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', CLI, '--porta', new URL(api.url).port],
        stderr: 'ignore',
      }),
    ));
});
