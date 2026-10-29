// Contrato da porta de armazenamento. Todo adaptador (SQLite hoje, DynamoDB no item 7.2)
// roda esta mesma bateria: se passa, quem usa a porta não percebe a troca.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { InvalidModelError } from '../src/model.ts';
import type { StoragePort } from '../src/storage-port.ts';
import type { PlanRecord, SessionPlan } from '../src/plan/model.ts';
import type { ContextMeter } from '../src/context/model.ts';
import { T0, account, agent, at, event, pricing, session, usage } from './fixtures.ts';

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

    describe('contas', () => {
      test('grava e lê a conta inteira, com pastas e metadados', async () => {
        const a = account({ color: '#5b8def', configDirs: ['/simulacao/.claude', '/simulacao/.claude-b'], metadata: { x: 1 } });
        await store.putAccount(a);
        assert.deepEqual(await store.getAccount(a.id), a);
        assert.equal(await store.getAccount('nada/nada'), null);
      });

      test('put substitui a conta inteira (upsert)', async () => {
        await store.putAccount(account());
        const editada = account({ label: 'Cliente X (sintético)', organizationName: null, lastSeenAt: at(10) });
        await store.putAccount(editada);
        assert.deepEqual(await store.listAccounts(), [editada]);
      });

      test('lista na ordem em que foram vistas pela primeira vez', async () => {
        const a2 = account({ n: 2, firstSeenAt: at(1), lastSeenAt: at(1) });
        const a1 = account({ n: 1, firstSeenAt: at(0) });
        const a3 = account({ n: 3, firstSeenAt: at(2), lastSeenAt: at(2) });
        for (const a of [a3, a1, a2]) await store.putAccount(a);
        assert.deepEqual(await store.listAccounts(), [a1, a2, a3]);
      });

      test('a mesma pessoa em duas orgs são duas contas', async () => {
        const org1 = account({ n: 1 });
        const org2 = account({ n: 1, organizationUuid: '00000000-0000-4000-8000-0000000000b9' });
        await store.putAccount(org1);
        await store.putAccount(org2);
        assert.equal((await store.listAccounts()).length, 2);
      });

      test('recusa id fora do formato <accountUuid>/<organizationUuid>', async () => {
        await assert.rejects(store.putAccount(account({ id: 'outra-coisa' })), InvalidModelError);
        assert.deepEqual(await store.listAccounts(), []);
      });

      test('a sessão guarda a conta e a procedência', async () => {
        const s = session({ accountId: account().id, accountSource: 'transcript' });
        await store.putSession(s);
        assert.deepEqual(await store.getSession('s1'), s);
      });

      test('recusa conta sem procedência, procedência sem conta e procedência fora da lista', async () => {
        await assert.rejects(store.putSession(session({ accountId: account().id })), InvalidModelError);
        await assert.rejects(store.putSession(session({ accountSource: 'env' })), InvalidModelError);
        await assert.rejects(
          store.putSession(session({ accountId: account().id, accountSource: 'palpite' as never })),
          InvalidModelError,
        );
        assert.equal(await store.getSession('s1'), null);
      });

      test('filtra as sessões por conta, com null pedindo as "Sem conta"', async () => {
        const c1 = account({ n: 1 }).id;
        const c2 = account({ n: 2 }).id;
        await store.putSession(session({ id: 'c1-a', accountId: c1, accountSource: 'env', updatedAt: at(1) }));
        await store.putSession(session({ id: 'c2-a', accountId: c2, accountSource: 'config', updatedAt: at(2) }));
        await store.putSession(session({ id: 'sem', updatedAt: at(3) }));
        await store.putSession(session({ id: 'c1-b', accountId: c1, accountSource: 'profile', updatedAt: at(4), status: 'completed', endedAt: at(4) }));

        const ids = async (q: Parameters<StoragePort['listSessions']>[0]) =>
          (await store.listSessions(q)).items.map((s) => s.id);
        assert.deepEqual(await ids({}), ['c1-b', 'sem', 'c2-a', 'c1-a']);
        assert.deepEqual(await ids({ accountIds: [c1] }), ['c1-b', 'c1-a']);
        assert.deepEqual(await ids({ accountIds: [c2, c1] }), ['c1-b', 'c2-a', 'c1-a']);
        assert.deepEqual(await ids({ accountIds: [null] }), ['sem']);
        assert.deepEqual(await ids({ accountIds: [c2, null] }), ['sem', 'c2-a']);
        assert.deepEqual(await ids({ accountIds: [] }), []);
        assert.deepEqual(await ids({ accountIds: ['nada/nada'] }), []);
        assert.deepEqual(await ids({ accountIds: [c1], status: ['active'] }), ['c1-a']);
      });

      test('o filtro por conta pagina por cursor', async () => {
        const c1 = account({ n: 1 }).id;
        for (let i = 0; i < 5; i++) {
          await store.putSession(session({ id: `c1-${i}`, accountId: c1, accountSource: 'env', updatedAt: at(i) }));
          await store.putSession(session({ id: `sem-${i}`, updatedAt: at(i) }));
        }
        const p1 = await store.listSessions({ accountIds: [c1], limit: 3 });
        const p2 = await store.listSessions({ accountIds: [c1], limit: 3, cursor: p1.nextCursor });
        assert.deepEqual([...p1.items, ...p2.items].map((s) => s.id), ['c1-4', 'c1-3', 'c1-2', 'c1-1', 'c1-0']);
        assert.equal(p2.nextCursor, null);
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

      test('setEventText fills data.text and keeps the rest of data', async () => {
        await store.appendEvent(event({ id: 'e1' }));
        await store.appendEvent(event({ id: 'e2', data: null }));
        assert.equal(await store.setEventText('e1', 'linha 1\n\n  linha 2'), true);
        assert.equal(await store.setEventText('e2', 'só texto'), true);
        assert.equal(await store.setEventText('nao-existe', 'x'), false);
        const { items } = await store.listEvents('s1');
        assert.deepEqual(items[0].data, { command: 'npm test', text: 'linha 1\n\n  linha 2' });
        assert.deepEqual(items[1].data, { text: 'só texto' });
        assert.equal(await store.setEventText('e1', 'de novo'), true);
        assert.deepEqual((await store.listEvents('s1')).items[0].data, { command: 'npm test', text: 'de novo' });
      });

      test('recusa evento sem tipo ou com data fora do padrão', async () => {
        await assert.rejects(store.appendEvent(event({ type: '' })), InvalidModelError);
        await assert.rejects(store.appendEvent(event({ createdAt: '02/11/2026' })), InvalidModelError);
      });
    });

    describe('eventos recentes de todas as sessões (feed, #94)', () => {
      const ids = (p: { items: { id: string }[] }) => p.items.map((e) => e.id);
      async function semear() {
        await store.appendEvent(event({ id: 'e1', sessionId: 's1', createdAt: at(1), type: 'UserPromptSubmit', toolName: null, summary: 'pedido' }));
        await store.appendEvent(event({ id: 'e2', sessionId: 's2', createdAt: at(2), type: 'PreToolUse', toolName: 'Bash', summary: 'npm test' }));
        await store.appendEvent(event({ id: 'e3', sessionId: 's1', createdAt: at(3), type: 'PreToolUse', toolName: 'Read', summary: '/repo/a_b.ts' }));
        await store.appendEvent(event({ id: 'e4', sessionId: 's2', createdAt: at(4), type: 'Notification', toolName: null, summary: '100% pronto' }));
        await store.appendEvent(event({ id: 'e5', sessionId: 's1', createdAt: at(5), type: 'Stop', toolName: null, summary: null }));
      }

      test('sem evento nenhum: vazio, com o cursor do ao vivo no começo', async () => {
        const p = await store.listRecentEvents();
        assert.deepEqual(p.items, []);
        assert.equal(p.nextCursor, null);
        assert.ok(p.liveCursor);
        await store.appendEvent(event({ id: 'primeiro', createdAt: at(1) }));
        assert.deepEqual(ids(await store.listRecentEvents({ after: p.liveCursor })), ['primeiro']);
      });

      test('todas as sessões, mais novo primeiro, paginando para trás por cursor', async () => {
        await semear();
        const p1 = await store.listRecentEvents({ limit: 2 });
        assert.deepEqual(ids(p1), ['e5', 'e4']);
        assert.ok(p1.liveCursor);
        assert.ok(p1.nextCursor);
        const p2 = await store.listRecentEvents({ limit: 2, before: p1.nextCursor });
        assert.deepEqual(ids(p2), ['e3', 'e2']);
        const p3 = await store.listRecentEvents({ limit: 2, before: p2.nextCursor });
        assert.deepEqual(ids(p3), ['e1']);
        assert.equal(p3.nextCursor, null);
        assert.deepEqual(p3.items[0], event({ id: 'e1', sessionId: 's1', createdAt: at(1), type: 'UserPromptSubmit', toolName: null, summary: 'pedido' }));
      });

      test('createdAt empatado desempata pelo id, sem repetir nem pular', async () => {
        for (const id of ['a', 'c', 'b']) await store.appendEvent(event({ id, createdAt: T0 }));
        const p1 = await store.listRecentEvents({ limit: 2 });
        const p2 = await store.listRecentEvents({ limit: 2, before: p1.nextCursor });
        assert.deepEqual([...ids(p1), ...ids(p2)], ['c', 'b', 'a']);
      });

      test('ao vivo: depois do cursor vem só o gravado depois, inclusive com createdAt mais velho (backfill)', async () => {
        await semear();
        const p = await store.listRecentEvents({ limit: 10 });
        const nada = await store.listRecentEvents({ after: p.liveCursor });
        assert.deepEqual(nada.items, []);
        assert.equal(nada.liveCursor, p.liveCursor, 'sem nada novo, repete o cursor recebido');
        assert.equal(nada.nextCursor, null);

        await store.appendEvent(event({ id: 'novo', sessionId: 's3', createdAt: at(9) }));
        await store.appendEvent(event({ id: 'atrasado', sessionId: 's3', createdAt: at(0) }));
        await store.appendEvent(event({ id: 'e2', createdAt: at(99) })); // repetido: não conta
        const vivo = await store.listRecentEvents({ after: p.liveCursor });
        assert.deepEqual(ids(vivo), ['novo', 'atrasado']);
        assert.notEqual(vivo.liveCursor, p.liveCursor);
        assert.deepEqual((await store.listRecentEvents({ after: vivo.liveCursor })).items, []);
      });

      test('a página para trás não traz o que foi gravado depois do primeiro pedido (isso vem pelo ao vivo)', async () => {
        await semear();
        const p1 = await store.listRecentEvents({ limit: 2 });
        await store.appendEvent(event({ id: 'atrasado', createdAt: at(2.5) }));
        const p2 = await store.listRecentEvents({ limit: 10, before: p1.nextCursor });
        assert.deepEqual(ids(p2), ['e3', 'e2', 'e1']);
        assert.deepEqual(ids(await store.listRecentEvents({ after: p1.liveCursor })), ['atrasado']);
      });

      test('ao vivo com mais novos que o limite: os gravados primeiro, e o cursor busca o resto', async () => {
        await store.appendEvent(event({ id: 'zero', createdAt: at(0) }));
        const base = await store.listRecentEvents();
        for (let i = 1; i <= 5; i++) await store.appendEvent(event({ id: `n${i}`, createdAt: at(i) }));
        const a = await store.listRecentEvents({ limit: 3, after: base.liveCursor });
        assert.deepEqual(ids(a), ['n3', 'n2', 'n1']);
        const b = await store.listRecentEvents({ limit: 3, after: a.liveCursor });
        assert.deepEqual(ids(b), ['n5', 'n4']);
      });

      test('filtra por sessão, tipos, fora de tipos, ferramenta, texto e período', async () => {
        await semear();
        const q = async (query: Parameters<StoragePort['listRecentEvents']>[0]) => ids(await store.listRecentEvents(query));
        assert.deepEqual(await q({ sessionId: 's2' }), ['e4', 'e2']);
        assert.deepEqual(await q({ types: ['PreToolUse', 'Stop'] }), ['e5', 'e3', 'e2']);
        assert.deepEqual(await q({ types: [] }), []);
        assert.deepEqual(await q({ excludeTypes: ['PreToolUse', 'Stop'] }), ['e4', 'e1']);
        assert.deepEqual(await q({ toolName: 'Bash' }), ['e2']);
        assert.deepEqual(await q({ text: 'NPM' }), ['e2'], 'sem diferenciar maiúsculas');
        assert.deepEqual(await q({ text: 'rea' }), ['e3'], 'acha também no nome da ferramenta');
        assert.deepEqual(await q({ text: '%' }), ['e4'], '% é literal');
        assert.deepEqual(await q({ text: 'a_b' }), ['e3'], '_ é literal');
        assert.deepEqual(await q({ text: '_' }), ['e3']);
        assert.deepEqual(await q({ text: '\\' }), []);
        assert.deepEqual(await q({ createdFrom: at(2), createdUntil: at(4) }), ['e3', 'e2']);
        assert.deepEqual(await q({ sessionId: 's1', types: ['PreToolUse'], text: 'a_b' }), ['e3']);
      });

      test('o ao vivo respeita os filtros', async () => {
        await semear();
        const p = await store.listRecentEvents({ sessionId: 's1' });
        await store.appendEvent(event({ id: 'outra', sessionId: 's2', createdAt: at(10) }));
        await store.appendEvent(event({ id: 'dela', sessionId: 's1', createdAt: at(11) }));
        assert.deepEqual(ids(await store.listRecentEvents({ sessionId: 's1', after: p.liveCursor })), ['dela']);
      });

      test('cursor inválido e depois com antes são erro', async () => {
        await semear();
        await assert.rejects(store.listRecentEvents({ after: 'lixo' }), RangeError);
        await assert.rejects(store.listRecentEvents({ before: 'lixo' }), RangeError);
        const p = await store.listRecentEvents({ limit: 1 });
        await assert.rejects(store.listRecentEvents({ after: p.liveCursor, before: p.nextCursor }), RangeError);
      });

      test('as opções dos filtros: tipos e ferramentas distintos, em ordem, limitados', async () => {
        await semear();
        assert.deepEqual(await store.listEventFacets(), { types: ['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit'], toolNames: ['Bash', 'Read'] });
        assert.deepEqual(await store.listEventFacets(1), { types: ['Notification'], toolNames: ['Bash'] });
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

    describe('medidor de contexto (item 1.7)', () => {
      const medidor = (over: Partial<ContextMeter> = {}): ContextMeter => ({
        sessionId: 's1',
        agentId: null,
        model: 'claude-opus-5-5',
        usedTokens: 62_600,
        windowTokens: 200_000,
        windowSource: 'model',
        compactions: 2,
        compactionsTranscript: 2,
        compactionsHook: 1,
        manualCompactions: 1,
        manualCompactionsTranscript: 1,
        manualCompactionsHook: 0,
        lastCompactionAt: at(2),
        lastCompactionTrigger: 'auto',
        measuredAt: at(3),
        updatedAt: at(3),
        ...over,
      });

      test('grava, lista com o principal primeiro, substitui pela chave e apaga por sessão', async () => {
        assert.deepEqual(await store.listContextMeters('s1'), []);
        const sub = medidor({ agentId: 's1:a1', usedTokens: 4_000, compactions: 0, compactionsTranscript: 0, compactionsHook: 0 });
        await store.putContextMeter(sub);
        await store.putContextMeter(medidor({ usedTokens: 1 }));
        await store.putContextMeter(medidor());
        await store.putContextMeter(medidor({ sessionId: 's2' }));
        assert.deepEqual(await store.listContextMeters('s1'), [medidor(), sub]);
        await store.deleteContextMeters('s1');
        assert.deepEqual(await store.listContextMeters('s1'), []);
        assert.equal((await store.listContextMeters('s2')).length, 1);
      });

      test('recusa contagem que não é o maior das fontes, janela zero e gatilho inválido', async () => {
        await assert.rejects(store.putContextMeter(medidor({ compactions: 3 })), InvalidModelError);
        await assert.rejects(store.putContextMeter(medidor({ manualCompactions: 0 })), InvalidModelError);
        await assert.rejects(store.putContextMeter(medidor({ windowTokens: 0 })), InvalidModelError);
        await assert.rejects(store.putContextMeter(medidor({ lastCompactionTrigger: 'outro' as ContextMeter['lastCompactionTrigger'] })), InvalidModelError);
      });
    });

    describe('plano da sessão', () => {
      const plano = (over: Partial<SessionPlan> = {}): SessionPlan => ({
        sessionId: 's1',
        source: 'TodoWrite',
        steps: [
          { id: '1', text: 'Ler', activeText: 'Lendo', status: 'completed', owner: { kind: 'main', agentId: 's1:main', name: null }, updatedAt: at(1) },
          { id: '2', text: 'Revisar', activeText: null, status: 'in_progress', owner: { kind: 'session', agentId: null, name: 'filha' }, updatedAt: at(2) },
        ],
        done: 1,
        total: 2,
        currentStepId: '2',
        changedAt: at(2),
        metadata: { extraction: { applied: ['t1'] } },
        ...over,
      });

      test('grava, lê e substitui o plano inteiro', async () => {
        assert.equal(await store.getPlan('s1'), null);
        await store.putPlan(plano());
        assert.deepEqual(await store.getPlan('s1'), plano());
        const vazio = plano({ steps: [], done: 0, total: 0, currentStepId: null, changedAt: at(3) });
        await store.putPlan(vazio);
        assert.deepEqual(await store.getPlan('s1'), vazio);
      });

      test('recusa contagem que não bate, passo atual fora da lista e estado inválido', async () => {
        await assert.rejects(store.putPlan(plano({ done: 2 })), InvalidModelError);
        await assert.rejects(store.putPlan(plano({ total: 3 })), InvalidModelError);
        await assert.rejects(store.putPlan(plano({ currentStepId: '9' })), InvalidModelError);
        const ruim = plano();
        (ruim.steps[0] as { status: string }).status = 'deleted';
        await assert.rejects(store.putPlan(ruim), InvalidModelError);
      });

      const registro = (over: Partial<PlanRecord> = {}): PlanRecord => {
        const { sessionId, source, steps, done, total, currentStepId, changedAt } = plano();
        return { sessionId, seq: 1, source, startedAt: at(1), endedAt: null, result: 'current', steps, done, total, currentStepId, changedAt, metadata: {}, ...over };
      };

      test('histórico: grava, substitui pelo seq e lista do mais recente para o mais antigo (#131)', async () => {
        assert.deepEqual(await store.listPlanRecords('s1'), []);
        const primeiro = registro({ endedAt: at(3), result: 'abandoned' });
        const segundo = registro({ seq: 2, startedAt: at(3) });
        await store.putPlanRecord(registro());
        await store.putPlanRecord(segundo);
        await store.putPlanRecord(primeiro);
        await store.putPlanRecord(registro({ sessionId: 's2' }));
        assert.deepEqual(await store.listPlanRecords('s1'), [segundo, primeiro]);
      });

      test('histórico: recusa resultado, fim e contagem que não batem', async () => {
        await assert.rejects(store.putPlanRecord(registro({ seq: 0 })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ result: 'parado' as PlanRecord['result'] })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ endedAt: at(3) })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ result: 'abandoned' })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ result: 'completed', endedAt: at(3) })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ result: 'abandoned', endedAt: at(0) })), InvalidModelError);
        await assert.rejects(store.putPlanRecord(registro({ done: 2 })), InvalidModelError);
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
