// History import (item 1.2) with synthetic transcripts in test/fixtures/history.
// No real transcript goes into the repository.

import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { discoverTranscripts, readLinesFrom } from '../src/ingest/history/files.ts';
import { eventId, importHistory, mainAgentId, resumeOffset, subagentId } from '../src/ingest/history/importer.ts';
import { parseLine, parseUsage } from '../src/ingest/history/transcript.ts';
import { aggregateUsage, dedupeByMessage, type UsageSample } from '../src/ingest/history/usage.ts';
import type { SessionEvent, StoragePort, TokenUsage } from '../src/index.ts';
import { session } from './fixtures.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'history', 'projects');
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const A1 = 'a1111111111111111';
const A2 = 'a2222222222222222';
const A3 = 'a3333333333333333';
const MAIN_FILE = join('-repo-app', `${S1}.jsonl`);

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-ingest-history-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Cópia das fixtures numa pasta própria, para o teste poder acrescentar ou reescrever arquivos. */
function projectsCopy(): string {
  const dir = join(tmp, `projects-${n++}`);
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

async function allEvents(store: StoragePort, sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.listEvents(sessionId, { limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const byModel = (usage: TokenUsage[]) => new Map(usage.map((u) => [u.model, u]));

async function fresh() {
  const root = projectsCopy();
  const store = openSqliteStorage({ path: ':memory:' });
  const report = await importHistory({ storage: store, root });
  return { root, store, report };
}

describe('history import: first pass', () => {
  test('finds the main agent, the current-layout subagents and the old-layout ones', async () => {
    const files = await discoverTranscripts(FIXTURES);
    assert.deepEqual(
      files.map((f) => [f.kind, f.sessionId, f.agentId, f.metaPath !== null]),
      [
        ['main', S1, null, false],
        ['subagent', S1, A1, true],
        ['subagent', S1, A2, true],
        ['subagent', null, A3, false],
        ['main', S2, null, false],
      ],
    );
  });

  test("creates the sessions with the transcript's title, directory, model and dates", async () => {
    const { store, report } = await fresh();
    assert.equal(report.filesFound, 5);
    assert.equal(report.filesRead, 5);
    assert.equal(report.sessionsTouched, 2);
    assert.equal(report.linesInvalid, 1);
    // `<id>.superseded-1.jsonl` é cópia antiga do principal: não vira sessão.
    assert.deepEqual((await store.listSessions()).items.map((s) => s.id).sort(), [S1, S2]);

    const s1 = await store.getSession(S1);
    assert.ok(s1);
    assert.equal(s1.name, 'Ajuste do login');
    assert.equal(s1.cwd, '/repo/app');
    assert.equal(s1.model, 'claude-opus-5-5');
    assert.equal(s1.source, 'import');
    assert.equal(s1.status, 'completed');
    assert.equal(s1.startedAt, '2026-11-02T12:00:00.000Z');
    // A última linha datada é a do subagente do layout antigo.
    assert.equal(s1.updatedAt, '2026-11-02T12:03:10.000Z');
    assert.equal(s1.endedAt, s1.updatedAt);

    const s2 = await store.getSession(S2);
    assert.equal(s2?.name, 'Revisão de custos');
    assert.equal(s2?.cwd, '/repo/other');
    await store.close();
  });

  test('creates the main agent and the subagents, with the right type, task and parent', async () => {
    const { store } = await fresh();
    const agents = new Map((await store.listAgents(S1)).map((a) => [a.id, a]));
    assert.deepEqual([...agents.keys()].sort(), [mainAgentId(S1), subagentId(S1, A1), subagentId(S1, A2), subagentId(S1, A3)].sort());

    const main = agents.get(mainAgentId(S1))!;
    assert.equal(main.type, 'main');
    assert.equal(main.parentAgentId, null);
    assert.equal(main.task, 'Corrija o login e rode os testes');

    const a1 = agents.get(subagentId(S1, A1))!;
    assert.equal(a1.type, 'subagent');
    assert.equal(a1.subagentType, 'Explore');
    assert.equal(a1.name, 'Explorar o código');
    assert.equal(a1.task, 'Explore o módulo de login');
    assert.equal(a1.parentAgentId, mainAgentId(S1));
    assert.equal(a1.status, 'completed');
    assert.equal(a1.startedAt, '2026-11-02T12:00:07.000Z');
    assert.equal(a1.endedAt, '2026-11-02T12:00:50.000Z');
    assert.equal(a1.metadata.spawnDepth, 1);

    // Subagente lançado por outro subagente: o pai vem do toolUseId do .meta.json.
    const a2 = agents.get(subagentId(S1, A2))!;
    assert.equal(a2.parentAgentId, subagentId(S1, A1));
    assert.equal(a2.subagentType, 'general-purpose');

    // Layout antigo, sem .meta.json: nome vem da tarefa, pai é o principal.
    const a3 = agents.get(subagentId(S1, A3))!;
    assert.equal(a3.name, 'Revise o diff');
    assert.equal(a3.parentAgentId, mainAgentId(S1));
    await store.close();
  });

  test('writes one event per relevant line, on the right agent', async () => {
    const { store, report } = await fresh();
    const events = await allEvents(store, S1);
    assert.equal(events.length, 15);
    assert.equal(report.eventsAdded, 17);
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);

    const main = events.filter((e) => e.agentId === mainAgentId(S1)).map((e) => e.type);
    assert.deepEqual(main, ['UserPrompt', 'AssistantMessage', 'ToolUse', 'ToolResult', 'AssistantMessage', 'Compaction', 'APIError']);

    const toolUse = events.find((e) => e.id === eventId('u3'))!;
    assert.equal(toolUse.toolName, 'Agent');
    assert.equal(toolUse.summary, 'Explorar o código');
    const toolResult = events.find((e) => e.id === eventId('u4'))!;
    assert.equal(toolResult.toolName, 'Agent');

    assert.equal(events.filter((e) => e.agentId === subagentId(S1, A1)).length, 4);
    assert.equal(events.filter((e) => e.agentId === subagentId(S1, A2)).length, 2);
    assert.equal(events.filter((e) => e.agentId === subagentId(S1, A3)).length, 2);
    await store.close();
  });

  test('sums the tokens without counting streaming twice, subagents included', async () => {
    const { store } = await fresh();
    const usage = byModel(await store.listTokenUsage(S1));
    assert.deepEqual([...usage.keys()].sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);

    // msg_01 aparece em duas linhas (parcial e final): conta só a final.
    // `<synthetic>` (erro de API) não entra.
    const opus = usage.get('claude-opus-5-5')!;
    assert.deepEqual(opus.tokens, { input: 14, output: 162, cacheRead: 4010, cacheWrite5m: 500, cacheWrite1h: 2000 });
    assert.equal(opus.speed, 'standard');
    assert.equal(opus.serviceTier, 'standard');
    assert.equal(opus.inferenceGeo, '');

    const haiku = usage.get('claude-haiku-5-5')!;
    assert.deepEqual(haiku.tokens, { input: 127, output: 88, cacheRead: 0, cacheWrite5m: 300, cacheWrite1h: 0 });
    assert.equal(haiku.webSearchRequests, 2);

    const [sonnet] = await store.listTokenUsage(S2);
    assert.equal(sonnet.speed, 'fast');
    assert.equal(sonnet.serviceTier, 'priority');
    assert.equal(sonnet.inferenceGeo, 'us');

    const agents = new Map((await store.listAgents(S1)).map((a) => [a.id, a]));
    assert.deepEqual(agents.get(mainAgentId(S1))!.metadata.tokens, { input: 13, output: 160, cacheRead: 4000, cacheWrite5m: 500, cacheWrite1h: 2000 });
    assert.deepEqual(agents.get(subagentId(S1, A1))!.metadata.tokens, { input: 120, output: 80, cacheRead: 0, cacheWrite5m: 300, cacheWrite1h: 0 });
    await store.close();
  });
});

describe('history import: running again', () => {
  test('duplicates nothing and does not reread unchanged files', async () => {
    const { root, store } = await fresh();
    const before = { events: await allEvents(store, S1), usage: await store.listTokenUsage(S1), agents: await store.listAgents(S1) };

    const again = await importHistory({ storage: store, root });
    assert.equal(again.filesRead, 0);
    assert.equal(again.filesUnchanged, 5);
    assert.equal(again.eventsAdded, 0);
    assert.equal(again.sessionsTouched, 0);

    assert.deepEqual(await allEvents(store, S1), before.events);
    assert.deepEqual(await store.listTokenUsage(S1), before.usage);
    assert.deepEqual(await store.listAgents(S1), before.agents);
    await store.close();
  });

  test('resumes from the cursor: reads only what was appended', async () => {
    const { root, store } = await fresh();
    const file = join(root, MAIN_FILE);
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    const common = { sessionId: S1, cwd: '/repo/app', isSidechain: false };
    appendFileSync(
      file,
      line({ ...common, type: 'user', uuid: 'u9', parentUuid: 'u8', timestamp: '2026-11-02T12:10:00.000Z', message: { role: 'user', content: 'Agora o logout' } }) +
        line({
          ...common,
          type: 'assistant',
          uuid: 'u10',
          parentUuid: 'u9',
          timestamp: '2026-11-02T12:10:05.000Z',
          requestId: 'req_msg_50',
          message: { id: 'msg_50', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Ok.' }], usage: { input_tokens: 2, output_tokens: 3 } },
        }),
    );

    const again = await importHistory({ storage: store, root });
    assert.equal(again.filesRead, 1);
    assert.equal(again.eventsAdded, 2);
    assert.equal(again.eventsExisting, 0, 'não releu as linhas antigas');

    const opus = byModel(await store.listTokenUsage(S1)).get('claude-opus-5-5')!;
    assert.deepEqual(opus.tokens, { input: 16, output: 165, cacheRead: 4010, cacheWrite5m: 500, cacheWrite1h: 2000 });
    const s1 = await store.getSession(S1);
    assert.equal(s1?.updatedAt, '2026-11-02T12:10:05.000Z');
    assert.equal(s1?.name, 'Ajuste do login', 'o título lido antes continua');
    await store.close();
  });

  test('a half-written line waits for the next round', async () => {
    const { root, store } = await fresh();
    const file = join(root, MAIN_FILE);
    const full = JSON.stringify({
      sessionId: S1,
      type: 'user',
      uuid: 'u20',
      timestamp: '2026-11-02T12:20:00.000Z',
      message: { role: 'user', content: 'meio' },
    });
    appendFileSync(file, full.slice(0, 40));
    const first = await importHistory({ storage: store, root });
    assert.equal(first.eventsAdded, 0);
    assert.equal(first.linesInvalid, 0);

    appendFileSync(file, `${full.slice(40)}\n`);
    const second = await importHistory({ storage: store, root });
    assert.equal(second.eventsAdded, 1);
    assert.ok((await allEvents(store, S1)).some((e) => e.id === eventId('u20')));
    await store.close();
  });

  test('a message that ends after the cursor keeps the final usage, not a sum', async () => {
    const { root, store } = await fresh();
    const file = join(root, join('-repo-other', `${S2}.jsonl`));
    const line = (uuid: string, output: number) =>
      `${JSON.stringify({
        sessionId: S2,
        type: 'assistant',
        uuid,
        timestamp: `2026-11-02T09:05:0${output > 100 ? 9 : 1}.000Z`,
        message: { id: 'msg_60', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '…' }], usage: { input_tokens: 4, output_tokens: output } },
      })}\n`;
    appendFileSync(file, line('w1', 10));
    await importHistory({ storage: store, root });
    appendFileSync(file, line('w2', 400));
    await importHistory({ storage: store, root });

    const usage = await store.listTokenUsage(S2);
    const std = usage.find((u) => u.speed === 'standard')!;
    assert.deepEqual(std.tokens, { input: 4, output: 400, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    await store.close();
  });

  test('a file rewritten smaller is reread from the start without duplicating', async () => {
    const { root, store } = await fresh();
    const file = join(root, MAIN_FILE);
    const lines = readFileSync(file, 'utf8').split('\n');
    writeFileSync(file, `${lines.slice(0, 3).join('\n')}\n`);
    const again = await importHistory({ storage: store, root });
    assert.equal(again.eventsAdded, 0);
    assert.equal(again.eventsExisting, 2);
    assert.equal((await allEvents(store, S1)).length, 15);
    const opus = byModel(await store.listTokenUsage(S1)).get('claude-opus-5-5')!;
    assert.equal(opus.tokens.output, 162, 'o uso continua vindo de todos os eventos gravados');
    await store.close();
  });

  test('an import that stopped before the cursor is redone without duplicating', async () => {
    const root = projectsCopy();
    const store = openSqliteStorage({ path: ':memory:' });
    // Simula a queda: grava os eventos, mas a sessão (com o cursor) nunca chega a ser gravada.
    const failing: StoragePort = Object.create(store);
    failing.putSession = async () => {
      throw new Error('queda simulada');
    };
    await assert.rejects(importHistory({ storage: failing, root }), /queda simulada/);
    assert.equal(await store.getSession(S1), null);

    const report = await importHistory({ storage: store, root });
    assert.equal(report.eventsAdded, 2, 'só os eventos de S2, que não chegou a ser lida');
    assert.equal((await allEvents(store, S1)).length, 15);
    const opus = byModel(await store.listTokenUsage(S1)).get('claude-opus-5-5')!;
    assert.equal(opus.tokens.output, 162);
    await store.close();
  });

  test('a session that already exists (from the hooks) keeps status, wait and metadata', async () => {
    const root = projectsCopy();
    const store = openSqliteStorage({ path: ':memory:' });
    await store.putSession(
      session({
        id: S1,
        name: null,
        status: 'active',
        source: 'startup',
        startedAt: '2026-11-02T12:00:00.000Z',
        updatedAt: '2026-11-02T12:30:00.000Z',
        awaitingInputSince: '2026-11-02T12:30:00.000Z',
        awaitingReason: 'stop',
        metadata: { hooks: { ultimo: 'Stop' } },
      }),
    );
    await importHistory({ storage: store, root });
    const s1 = (await store.getSession(S1))!;
    assert.equal(s1.status, 'active');
    assert.equal(s1.source, 'startup');
    assert.equal(s1.awaitingReason, 'stop');
    assert.equal(s1.endedAt, null);
    assert.equal(s1.updatedAt, '2026-11-02T12:30:00.000Z');
    assert.equal(s1.name, 'Ajuste do login');
    assert.deepEqual(s1.metadata.hooks, { ultimo: 'Stop' });
    assert.ok(s1.metadata.importacao);
    await store.close();
  });
});

describe('transcript reading', () => {
  test('reads the complete lines from an offset', async () => {
    const file = join(tmp, 'linhas.jsonl');
    writeFileSync(file, 'á\n\n{"b":1}\nmeio');
    const all = [];
    for await (const l of readLinesFrom(file, 0)) all.push(l);
    assert.deepEqual(all, [
      { line: 'á', end: 3 },
      { line: '{"b":1}', end: 12 },
    ]);
    const rest = [];
    for await (const l of readLinesFrom(file, 3)) rest.push(l.line);
    assert.deepEqual(rest, ['{"b":1}']);
    truncateSync(file, 0);
  });

  test('the cursor decides where to continue', () => {
    const cursor = { file: 'p/s.jsonl', offset: 100, size: 120, mtimeMs: 5 };
    assert.equal(resumeOffset(null, 'p/s.jsonl', { size: 50, mtimeMs: 1 }), 0);
    assert.equal(resumeOffset(cursor, 'p/s.jsonl', { size: 120, mtimeMs: 5 }), null);
    assert.equal(resumeOffset(cursor, 'p/s.jsonl', { size: 150, mtimeMs: 6 }), 100);
    assert.equal(resumeOffset(cursor, 'p/s.jsonl', { size: 80, mtimeMs: 6 }), 0);
    assert.equal(resumeOffset(cursor, 'other/s.jsonl', { size: 120, mtimeMs: 5 }), 0);
  });

  test('usage without per-TTL detail counts the cache write as 5 minutes', () => {
    const u = parseUsage({ id: 'm', model: 'claude-x', usage: { input_tokens: 1, cache_creation_input_tokens: 70 } }, null)!;
    assert.equal(u.tokens.cacheWrite5m, 70);
    assert.equal(u.tokens.cacheWrite1h, 0);
    assert.equal(parseUsage({ model: '<synthetic>', usage: { input_tokens: 1 } }, null), null);
  });

  test('lines without a uuid, or control lines, do not become events', () => {
    const names = new Map<string, string>();
    assert.equal(parseLine('[1,2]', names), null);
    assert.deepEqual(parseLine('{"type":"queue-operation","sessionId":"s"}', names)?.events, []);
    assert.deepEqual(parseLine('{"type":"user","timestamp":"2026-11-02T12:00:00Z","message":{"content":"x"}}', names)?.events, []);
    assert.deepEqual(parseLine('{"type":"summary","summary":"Resumo"}', names)?.title, { kind: 'summary', value: 'Resumo' });
  });

  test('dedupe by message keeps the final entry and aggregates by bucket', () => {
    const sample = (eventId: string, messageId: string | null, output: number): UsageSample => ({
      eventId,
      agentId: 'a',
      usage: {
        messageId,
        requestId: null,
        model: 'm',
        speed: 'standard',
        inferenceGeo: '',
        serviceTier: 'standard',
        contextSize: '',
        tokens: { input: 1, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        webSearchRequests: 0,
        webFetchRequests: 0,
        codeExecutionRequests: 0,
      },
    });
    const samples = [sample('e1', 'x', 5), sample('e2', 'x', 50), sample('e3', null, 7), sample('e4', null, 7)];
    assert.equal(dedupeByMessage(samples).length, 3);
    const { buckets } = aggregateUsage('s', samples);
    assert.equal(buckets.length, 1);
    assert.deepEqual(buckets[0].tokens, { input: 3, output: 64, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  });
});
