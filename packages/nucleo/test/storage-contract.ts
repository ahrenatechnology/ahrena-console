// Contrato da porta de armazenamento. Todo adaptador (SQLite hoje, DynamoDB no item 7.2)
// roda esta mesma bateria: se passa, quem usa a porta não percebe a troca.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { InvalidModelError } from '../src/model.ts';
import type { StoragePort } from '../src/storage-port.ts';
import { T0, agent, at, event, pricing, session, usage } from './fixtures.ts';

export function storageContract(name: string, create: () => Promise<StoragePort>): void {
  describe(`contrato da porta de armazenamento: ${name}`, () => {
    let store: StoragePort;
    beforeEach(async () => {
      store = await create();
    });
    afterEach(async () => {
      await store.close();
    });

    describe('sessões', () => {
      test('grava e lê a sessão inteira, com metadados', async () => {
        const s = session({ metadata: { branch: 'main', turnos: 3 } });
        await store.putSession(s);
        assert.deepEqual(await store.getSession('s1'), s);
      });

      test('sessão inexistente é null', async () => {
        assert.equal(await store.getSession('nada'), null);
      });

      test('put substitui a sessão inteira (upsert)', async () => {
        await store.putSession(session());
        const done = session({ status: 'completed', endedAt: at(30), updatedAt: at(30) });
        await store.putSession(done);
        assert.deepEqual(await store.getSession('s1'), done);
      });

      test('waiting é camada: grava awaitingInputSince e o motivo sem mudar o status persistido', async () => {
        await store.putSession(session({ awaitingInputSince: at(5), awaitingReason: 'notification' }));
        const got = await store.getSession('s1');
        assert.equal(got?.status, 'active');
        assert.equal(got?.awaitingInputSince, at(5));
        assert.equal(got?.awaitingReason, 'notification');
      });

      test('aceita os quatro status persistidos', async () => {
        for (const [i, status] of (['active', 'completed', 'error', 'abandoned'] as const).entries()) {
          await store.putSession(session({ id: `s${i}`, status }));
          assert.equal((await store.getSession(`s${i}`))?.status, status);
        }
      });

      test('recusa status inválido, inclusive "waiting" persistido', async () => {
        await assert.rejects(store.putSession(session({ status: 'waiting' as never })), InvalidModelError);
        assert.equal(await store.getSession('s1'), null);
      });

      test('lista da mais recente para a mais antiga, paginando por cursor', async () => {
        for (let i = 0; i < 5; i++) await store.putSession(session({ id: `s${i}`, updatedAt: at(i) }));
        const p1 = await store.listSessions({ limit: 2 });
        assert.deepEqual(p1.items.map((s) => s.id), ['s4', 's3']);
        assert.ok(p1.nextCursor);
        const p2 = await store.listSessions({ limit: 2, cursor: p1.nextCursor });
        assert.deepEqual(p2.items.map((s) => s.id), ['s2', 's1']);
        const p3 = await store.listSessions({ limit: 2, cursor: p2.nextCursor });
        assert.deepEqual(p3.items.map((s) => s.id), ['s0']);
        assert.equal(p3.nextCursor, null);
      });

      test('paginação estável com updatedAt empatado', async () => {
        for (const id of ['a', 'b', 'c']) await store.putSession(session({ id, updatedAt: T0 }));
        const p1 = await store.listSessions({ limit: 2 });
        const p2 = await store.listSessions({ limit: 2, cursor: p1.nextCursor });
        assert.deepEqual([...p1.items, ...p2.items].map((s) => s.id), ['c', 'b', 'a']);
      });

      test('filtra por status, por espera e por diretório', async () => {
        await store.putSession(session({ id: 'ativa', updatedAt: at(1) }));
        await store.putSession(session({ id: 'esperando', updatedAt: at(2), awaitingInputSince: at(2), awaitingReason: 'stop' }));
        await store.putSession(session({ id: 'fim', status: 'completed', endedAt: at(3), updatedAt: at(3) }));
        await store.putSession(session({ id: 'outra', cwd: '/repo/api', updatedAt: at(4) }));

        const ids = async (q: Parameters<StoragePort['listSessions']>[0]) =>
          (await store.listSessions(q)).items.map((s) => s.id);
        assert.deepEqual(await ids({ status: ['active'] }), ['outra', 'esperando', 'ativa']);
        assert.deepEqual(await ids({ status: ['completed', 'abandoned'] }), ['fim']);
        assert.deepEqual(await ids({ awaiting: true }), ['esperando']);
        assert.deepEqual(await ids({ status: ['active'], awaiting: false }), ['outra', 'ativa']);
        assert.deepEqual(await ids({ cwd: '/repo/api' }), ['outra']);
        assert.deepEqual(await ids({ status: [] }), []);
      });

      test('cursor inválido é erro', async () => {
        await assert.rejects(store.listSessions({ cursor: 'lixo' }), RangeError);
      });
    });

    describe('agentes', () => {
      test('grava, lê e lista por sessão na ordem de início', async () => {
        const main = agent();
        const sub = agent({
          id: 'a2', name: 'revisor', type: 'subagent', subagentType: 'Explore', task: 'achar o bug',
          parentAgentId: 'a1', startedAt: at(2), updatedAt: at(2), metadata: { tokens: 10 },
        });
        await store.putAgent(sub);
        await store.putAgent(main);
        await store.putAgent(agent({ id: 'x', sessionId: 'outra' }));
        assert.deepEqual(await store.getAgent('a2'), sub);
        assert.deepEqual(await store.listAgents('s1'), [main, sub]);
        assert.equal(await store.getAgent('nada'), null);
      });

      test('put substitui o agente', async () => {
        await store.putAgent(agent());
        await store.putAgent(agent({ status: 'waiting', currentTool: null, updatedAt: at(1) }));
        assert.equal((await store.getAgent('a1'))?.status, 'waiting');
      });

      test('recusa status e tipo inválidos', async () => {
        await assert.rejects(store.putAgent(agent({ status: 'active' as never })), InvalidModelError);
        await assert.rejects(store.putAgent(agent({ type: 'robo' as never })), InvalidModelError);
      });
    });

    describe('eventos', () => {
      test('acrescenta e lista em ordem cronológica, com data JSON', async () => {
        await store.appendEvent(event({ id: 'e2', createdAt: at(2), toolName: null, summary: null, data: null }));
        await store.appendEvent(event({ id: 'e1', createdAt: at(1) }));
        await store.appendEvent(event({ id: 'e3', sessionId: 'outra' }));
        const page = await store.listEvents('s1');
        assert.deepEqual(page.items.map((e) => e.id), ['e1', 'e2']);
        assert.deepEqual(page.items[0].data, { command: 'npm test' });
        assert.equal(page.items[1].data, null);
        assert.equal(page.nextCursor, null);
      });

      test('mesmo id não duplica nem altera o evento', async () => {
        assert.equal(await store.appendEvent(event()), true);
        assert.equal(await store.appendEvent(event({ summary: 'outra coisa' })), false);
        const { items } = await store.listEvents('s1');
        assert.equal(items.length, 1);
        assert.equal(items[0].summary, 'npm test');
      });

      test('pagina por cursor', async () => {
        for (let i = 0; i < 5; i++) await store.appendEvent(event({ id: `e${i}`, createdAt: at(i) }));
        const p1 = await store.listEvents('s1', { limit: 3 });
        const p2 = await store.listEvents('s1', { limit: 3, cursor: p1.nextCursor });
        assert.deepEqual(p1.items.map((e) => e.id), ['e0', 'e1', 'e2']);
        assert.deepEqual(p2.items.map((e) => e.id), ['e3', 'e4']);
        assert.equal(p2.nextCursor, null);
      });

      test('recusa evento sem tipo ou com data fora do padrão', async () => {
        await assert.rejects(store.appendEvent(event({ type: '' })), InvalidModelError);
        await assert.rejects(store.appendEvent(event({ createdAt: '02/11/2026' })), InvalidModelError);
      });
    });

    describe('uso de tokens', () => {
      test('um registro por bucket; put substitui o mesmo bucket', async () => {
        await store.putTokenUsage(usage());
        await store.putTokenUsage(usage({ speed: 'fast' }));
        const novo = usage({
          tokens: { input: 2000, output: 900, cacheRead: 30_000, cacheWrite5m: 0, cacheWrite1h: 8000 },
          baseline: { input: 100, output: 50, cacheRead: 0, cacheWrite5m: 10, cacheWrite1h: 20 },
          webSearchRequests: 2,
          updatedAt: at(5),
        });
        await store.putTokenUsage(novo);
        const all = await store.listTokenUsage('s1');
        assert.equal(all.length, 2);
        assert.deepEqual(all.find((u) => u.speed === 'standard'), novo);
        assert.deepEqual(await store.listTokenUsage('outra'), []);
      });

      test('separa os buckets de cache de 5 min e de 1 h', async () => {
        await store.putTokenUsage(usage());
        const [u] = await store.listTokenUsage('s1');
        assert.equal(u.tokens.cacheWrite5m, 3000);
        assert.equal(u.tokens.cacheWrite1h, 4000);
      });

      test('recusa contagem negativa ou fracionária', async () => {
        const bad = usage();
        bad.tokens = { ...bad.tokens, output: -1 };
        await assert.rejects(store.putTokenUsage(bad), InvalidModelError);
        bad.tokens = { ...bad.tokens, output: 1.5 };
        await assert.rejects(store.putTokenUsage(bad), InvalidModelError);
      });
    });

    describe('tabela de preços', () => {
      test('grava, lista em ordem de padrão, substitui e remove', async () => {
        const opus = pricing({ cacheWrite1hPerMTok: 20 });
        const haiku = pricing({ pattern: 'claude-haiku%', inputPerMTok: 1, outputPerMTok: 5 });
        await store.putModelPricing(opus);
        await store.putModelPricing(haiku);
        assert.deepEqual(await store.listModelPricing(), [haiku, opus]);

        const opus2 = { ...opus, inputPerMTok: 12, updatedAt: at(1) };
        await store.putModelPricing(opus2);
        assert.deepEqual(await store.listModelPricing(), [haiku, opus2]);

        assert.equal(await store.deleteModelPricing('claude-haiku%'), true);
        assert.equal(await store.deleteModelPricing('claude-haiku%'), false);
        assert.deepEqual(await store.listModelPricing(), [opus2]);
      });

      test('recusa preço negativo', async () => {
        await assert.rejects(store.putModelPricing(pricing({ outputPerMTok: -1 })), InvalidModelError);
      });
    });
  });
}
