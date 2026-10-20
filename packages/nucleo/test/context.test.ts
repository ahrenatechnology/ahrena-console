// Context meter and overflows (item 1.7) with synthetic transcripts and hooks.
// The fields follow the structure of the Claude Code transcript (`message.usage`, `compact_boundary` with
// `compactMetadata`); no real content enters the repository.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { MIGRATIONS, migrate, schemaVersion } from '../src/adapters/sqlite/migrations.ts';
import { Contas, MontadorDoPainel } from '../src/api/index.ts';
import { reprocessarContexto } from '../src/api/reprocessing.ts';
import {
  LONG_WINDOW,
  DEFAULT_WINDOW,
  contextAlert,
  applyToMeter,
  emptyMeter,
  updateContextMeters,
  contextLabel,
  validateContextMeter,
  type ContextMeter,
} from '../src/context/index.ts';
import { importHistory } from '../src/ingest/history/importer.ts';
import { ingestHook } from '../src/ingest/hooks/index.ts';
import { at, event } from './fixtures.ts';

let store: SqliteStorage;
beforeEach(() => {
  store = openSqliteStorage({ path: ':memory:' });
});

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-context-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let line = 0;
const uuid = () => `00000000-0000-4000-9000-${String(++line).padStart(12, '0')}`;
const A = 'a7777777777777777';

interface Usage {
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

function message(sid: string, m: number, usage: Usage, extra: { agentId?: string; model?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: sid, cwd: '/repo/app',
    ...(extra.agentId ? { isSidechain: true, agentId: extra.agentId } : {}),
    message: {
      id: `msg_${line}`, model: extra.model ?? 'claude-opus-5-5', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: usage.input,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
        output_tokens: usage.output ?? 10,
      },
    },
  });
}

function compaction(sid: string, m: number, trigger: 'auto' | 'manual', preTokens: number, postTokens: number): string {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', uuid: uuid(), parentUuid: null, timestamp: at(m), sessionId: sid,
    cwd: '/repo/app', content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger, preTokens, postTokens, durationMs: 1000 },
  });
}

/** Writes the session's transcript (and the subagent's, if any) and imports it. */
async function importTranscript(name: string, sid: string, lines: string[], sub: string[] = []): Promise<{ root: string; file: string }> {
  const root = join(tmp, name);
  mkdirSync(join(root, '-repo-app', sid, 'subagents'), { recursive: true });
  const file = join(root, '-repo-app', `${sid}.jsonl`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  if (sub.length > 0) writeFileSync(join(root, '-repo-app', sid, 'subagents', `agent-${A}.jsonl`), sub.map((l) => `${l}\n`).join(''));
  await importHistory({ storage: store, root });
  return { root, file };
}

const mainMeter = async (sid: string) => (await store.listContextMeters(sid)).find((m) => m.agentId === null)!;
const summary = (m: ContextMeter) => ({ used: m.usedTokens, window: m.windowTokens, overflows: m.compactions, label: contextLabel(m) });

describe('meter from the transcript', () => {
  test('normal session: the last assistant message, input plus cache, on the 200k window', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c1';
    await importTranscript('normal', sid, [
      message(sid, 1, { input: 3, cacheRead: 10_000, cacheWrite: 2_000, output: 500 }),
      message(sid, 2, { input: 600, cacheRead: 60_000, cacheWrite: 2_000, output: 900 }),
    ]);
    const m = await mainMeter(sid);
    assert.deepEqual(summary(m), { used: 62_600, window: DEFAULT_WINDOW, overflows: 0, label: '62.6k / 200k (31%)' });
    assert.equal(m.windowSource, 'model');
    assert.equal(m.model, 'claude-opus-5-5');
    assert.equal(m.measuredAt, at(2));
  });

  test('1 compaction: counts one overflow, no alert, and the context drops to the one after', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c2';
    await importTranscript('uma', sid, [
      message(sid, 1, { input: 1_000, cacheRead: 180_000 }),
      compaction(sid, 2, 'auto', 181_000, 9_000),
    ]);
    let m = await mainMeter(sid);
    assert.deepEqual(summary(m), { used: 9_000, window: DEFAULT_WINDOW, overflows: 1, label: '9k / 200k (5%)' });
    assert.equal(contextAlert(m), false, 'the alert starts at 2');
    assert.equal(m.lastCompactionTrigger, 'auto');
    assert.equal(m.lastCompactionAt, at(2));

    // The next message sets the measurement again; the overflow stays.
    const root = join(tmp, 'uma');
    const file = join(root, '-repo-app', `${sid}.jsonl`);
    appendFileSync(file, `${message(sid, 3, { input: 200, cacheRead: 15_000 })}\n`);
    await importHistory({ storage: store, root });
    m = await mainMeter(sid);
    assert.deepEqual([m.usedTokens, m.compactions], [15_200, 1]);
  });

  test('3 automatic compactions: three overflows and the alert; the manual one stays apart; reimporting does not count again', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c3';
    const { root } = await importTranscript('tres', sid, [
      message(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 2, 'auto', 160_000, 10_000),
      message(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 4, 'auto', 151_000, 8_000),
      message(sid, 5, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 6, 'manual', 151_000, 9_000),
      message(sid, 7, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 8, 'auto', 158_000, 12_000),
      message(sid, 9, { input: 500, cacheRead: 40_000 }),
    ]);
    let m = await mainMeter(sid);
    assert.deepEqual([m.compactions, m.compactionsTranscript, m.manualCompactions, m.usedTokens, m.lastCompactionTrigger], [3, 3, 1, 40_500, 'auto']);
    assert.equal(contextAlert(m), true);
    await importHistory({ storage: store, root });
    m = await mainMeter(sid);
    assert.equal(m.compactions, 3, 'the same transcript does not count twice');
  });

  test('subagent: a meter of its own, without changing the main one', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c4';
    await importTranscript('sub', sid, [message(sid, 1, { input: 100, cacheRead: 50_000 })], [
      message(sid, 2, { input: 50, cacheRead: 20_000 }, { agentId: A, model: 'claude-haiku-5-5' }),
      compaction(sid, 3, 'auto', 20_050, 4_000).replace('"sessionId"', `"isSidechain":true,"agentId":"${A}","sessionId"`),
    ]);
    const meters = await store.listContextMeters(sid);
    assert.deepEqual(meters.map((m) => m.agentId), [null, `${sid}:${A}`], 'the main one first');
    const [p, s] = meters;
    assert.deepEqual([p.usedTokens, p.compactions], [50_100, 0]);
    assert.deepEqual([s.usedTokens, s.compactions, s.model], [4_000, 1, 'claude-haiku-5-5']);
  });

  test('1M model: by the session\'s [1m] suffix, and by a context that went past 200k', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c5';
    // The SessionStart hook carries the model with the suffix; the transcript, without.
    await ingestHook(store, { session_id: sid, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5[1m]' }, { receivedAt: at(0) });
    await importTranscript('longo', sid, [message(sid, 1, { input: 2_000, cacheRead: 60_000 })]);
    let m = await mainMeter(sid);
    assert.deepEqual([m.usedTokens, m.windowTokens, m.windowSource, contextLabel(m)], [62_000, LONG_WINDOW, 'suffix', '62k / 1M (6%)']);

    const sid2 = '00000000-0000-4000-8000-0000000000c6';
    await importTranscript('observado', sid2, [
      message(sid2, 1, { input: 1_000, cacheRead: 150_000 }),
      message(sid2, 2, { input: 1_000, cacheRead: 320_000 }),
      message(sid2, 3, { input: 1_000, cacheRead: 100_000 }),
    ]);
    m = await mainMeter(sid2);
    assert.deepEqual([m.usedTokens, m.windowTokens, m.windowSource], [101_000, LONG_WINDOW, 'observed'], 'the window does not shrink');
  });
});

describe('overflows from the PreCompact hook', () => {
  const pre = (sid: string, m: number, trigger: string, id: string) =>
    ingestHook(store, { session_id: sid, hook_event_name: 'PreCompact', trigger, custom_instructions: '' }, { receivedAt: at(m), deliveryId: id });

  test('the automatic hook counts, the manual one stays apart, and a repeated delivery does not', async () => {
    const sid = 'sess-hook-1';
    await pre(sid, 1, 'auto', 'd1');
    await pre(sid, 1, 'auto', 'd1');
    await pre(sid, 2, 'manual', 'd2');
    await pre(sid, 3, 'auto', 'd4');
    const m = await mainMeter(sid);
    assert.deepEqual([m.compactions, m.compactionsHook, m.manualCompactions, m.lastCompactionTrigger, m.measuredAt], [2, 2, 1, 'auto', null]);
  });

  test('meter from PreCompact only: the card does not show "0 / 200k"', async () => {
    const sid = 'sess-hook-2';
    await pre(sid, 1, 'auto', 'd5');
    const builder = new MontadorDoPainel({ storage: store, contas: new Contas({ storage: store, arquivo: null }), desktop: null, trabalho: null, agora: () => Date.parse(at(10)) });
    assert.equal((await builder.montar({ sessionId: sid })).context, null);
  });

  test('hook and transcript see the same compaction: the larger wins, never the sum', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c7';
    await pre(sid, 2, 'auto', 'd3');
    await importTranscript('ambos', sid, [message(sid, 1, { input: 1_000, cacheRead: 170_000 }), compaction(sid, 2, 'auto', 171_000, 9_000)]);
    const m = await mainMeter(sid);
    assert.deepEqual([m.compactions, m.compactionsHook, m.compactionsTranscript], [1, 1, 1]);
  });
});

describe('applyToMeter', () => {
  test('the compaction\'s preTokens does not change the window ("prompt too long" above 200k)', () => {
    const c = event({ id: 'c1', type: 'Compaction', createdAt: at(1), data: { subtype: 'compact_boundary', compact: { trigger: 'auto', preTokens: 260_000, postTokens: 20_000 } } });
    const m = applyToMeter(emptyMeter('s1', null, at(0)), c, null)!;
    assert.deepEqual([m.windowTokens, m.windowSource, m.usedTokens, m.compactions], [DEFAULT_WINDOW, 'model', 20_000, 1]);
  });

  test('dates with different precisions are compared as instants', async () => {
    const usage = (id: string, createdAt: string, input: number) =>
      event({ id, type: 'AssistantMessage', createdAt, data: { usage: { model: 'claude-opus-5-5', tokens: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    // As text, "12:00:00Z" comes after "12:00:00.500Z"; as an instant, before.
    const written: ContextMeter[] = [];
    const port = { getSession: async () => null, listContextMeters: async () => [], putContextMeter: async (m: ContextMeter) => void written.push(m) };
    await updateContextMeters(port, 's1', [usage('b', '2026-11-02T12:00:00.500Z', 5_000), usage('a', '2026-11-02T12:00:00Z', 3_000)]);
    assert.deepEqual([written[0].usedTokens, written[0].measuredAt], [5_000, '2026-11-02T12:00:00.500Z']);
    const m = applyToMeter(written[0], usage('c', '2026-11-02T12:00:00Z', 1_000), null)!;
    assert.equal(m.usedTokens, 5_000, 'the older message does not replace it');
  });

  test('a message older than the measurement does not replace it', () => {
    let m = emptyMeter('s1', null, at(0));
    const usage = (minute: number, input: number) =>
      event({ id: `e${minute}`, type: 'AssistantMessage', createdAt: at(minute), data: { usage: { model: 'claude-opus-5-5', tokens: { input, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } } });
    m = applyToMeter(m, usage(5, 5_000), null)!;
    m = applyToMeter(m, usage(3, 3_000), null)!;
    assert.deepEqual([m.usedTokens, m.measuredAt], [5_000, at(5)]);
    assert.equal(applyToMeter(m, event({ type: 'ToolResult', createdAt: at(6) }), null), null);
    validateContextMeter(m);
  });

  test('label as in Podium', () => {
    assert.equal(contextLabel({ usedTokens: 62_600, windowTokens: 200_000 }), '62.6k / 200k (31%)');
    assert.equal(contextLabel({ usedTokens: 950, windowTokens: 200_000 }), '950 / 200k (0%)');
  });
});

describe('migration and port', () => {
  test('migration 7 creates context_meters in a version 6 database', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.filter((m) => m.version <= 6));
    assert.deepEqual(migrate(db, MIGRATIONS.filter((m) => m.version <= 7)), [7]);
    assert.equal(schemaVersion(db), 7);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_meters'").get());
    db.close();
  });

  test('an invalid meter is not written', async () => {
    const m = { ...emptyMeter('s1', null, at(0)), compactions: 2 };
    await assert.rejects(store.putContextMeter(m), /compactions/);
  });
});

describe('panel API', () => {
  test('context with tokens, window, percentage, overflows and alert, and each subagent\'s', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c8';
    await importTranscript('painel', sid, [
      message(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 2, 'auto', 160_000, 10_000),
      message(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 4, 'auto', 151_000, 8_000),
      compaction(sid, 4.5, 'manual', 70_000, 7_000),
      message(sid, 5, { input: 600, cacheRead: 62_000 }),
    ], [message(sid, 6, { input: 50, cacheRead: 20_000 }, { agentId: A })]);
    const builder = new MontadorDoPainel({ storage: store, contas: new Contas({ storage: store, arquivo: null }), desktop: null, trabalho: null, agora: () => Date.parse(at(10)) });
    const p = await builder.montar({ sessionId: sid });
    assert.deepEqual(p.context, {
      used: 62_600,
      limit: 200_000,
      pct: 31,
      overflows: 2,
      alert: true,
      manualCompactions: 1,
      label: '62.6k / 200k (31%)',
      agents: [{ agentId: `${sid}:${A}`, used: 20_050, limit: 200_000, pct: 10, overflows: 0, alert: false }],
    });
    assert.ok(p.subagents.items.some((s) => s.id === `${sid}:${A}`), 'agentId is the subagent id on the card');
  });
});

describe('reprocessing context-1', () => {
  test('rebuilds the meter of a session imported before 1.7, with the compactions reread from the transcript and the subagent', async () => {
    const sid = '00000000-0000-4000-8000-0000000000c9';
    const lines = [
      message(sid, 1, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 2, 'auto', 160_000, 10_000),
      message(sid, 3, { input: 1_000, cacheRead: 150_000 }),
      compaction(sid, 4, 'auto', 151_000, 8_000),
      message(sid, 5, { input: 600, cacheRead: 62_000 }),
    ];
    const { root, file } = await importTranscript('reprocessar', sid, lines, [
      message(sid, 6, { input: 50, cacheRead: 20_000 }, { agentId: A }),
      compaction(sid, 7, 'auto', 20_050, 4_000).replace('"sessionId"', `"isSidechain":true,"agentId":"${A}","sessionId"`),
    ]);
    // Like the old import: no meter, and the compaction written without compactMetadata.
    const old = openSqliteStorage({ path: ':memory:' });
    const session = (await store.getSession(sid))!;
    await old.putSession({ ...session, metadata: { ...session.metadata, transcriptPath: file } });
    let cursor: string | null = null;
    do {
      const page = await store.listEvents(sid, { limit: 500, cursor });
      for (const e of page.items) {
        const d = e.data as Record<string, unknown>;
        await old.appendEvent(e.type === 'Compaction' ? { ...e, data: { ...d, compact: undefined } } : e);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(await old.listContextMeters(sid), []);

    const r = await reprocessarContexto({ storage: old, raiz: root });
    assert.deepEqual(r, { sessoes: 1, medidores: 2 });
    const [p, sub] = await old.listContextMeters(sid);
    assert.deepEqual([p.usedTokens, p.compactions, contextAlert(p)], [62_600, 2, true]);
    assert.deepEqual([sub.agentId, sub.usedTokens, sub.compactions], [`${sid}:${A}`, 4_000, 1]);
    // Running again gives the same: it rebuilds from scratch, it does not add up.
    await reprocessarContexto({ storage: old, raiz: root });
    assert.equal((await old.listContextMeters(sid))[0].compactions, 2);
    await old.close();
  });
});
