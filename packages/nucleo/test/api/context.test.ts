// The session's context after compacting: the usage from before (the peak) no longer counts, and the long
// window stays the same. Synthetic events.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextoDe } from '../../src/api/painel.ts';
import { aplicarEvento, resumoVazio } from '../../src/api/resumo.ts';
import { at, event } from '../fixtures.ts';

const S = 'sess-contexto';
const reply = (minute: number, context: number) =>
  event({
    sessionId: S, agentId: `${S}:main`, type: 'AssistantMessage', toolName: null, createdAt: at(minute),
    data: { usage: { tokens: { input: 1_000, output: 500, cacheRead: context - 1_500, cacheWrite5m: 0, cacheWrite1h: 0 } } },
  });
const compacted = (minute: number) => event({ sessionId: S, agentId: `${S}:main`, type: 'Compaction', toolName: null, createdAt: at(minute), data: { subtype: 'compact_boundary' } });
const session = { metadata: {}, model: 'claude-opus-5-5' };

test('compacting drops the context: no peak until the next reply, then the new usage, on the same 1M window', () => {
  const r = resumoVazio();
  aplicarEvento(r, reply(1, 852_000));
  assert.equal(contextoDe(session, r)?.pct, 85);
  aplicarEvento(r, compacted(2));
  // Right after /compact: unknown (the panel uses the engine's source), never the 85% from before.
  assert.equal(contextoDe(session, r), null);
  aplicarEvento(r, reply(3, 105_000));
  const after = contextoDe(session, r)!;
  // 105 thousand on the 1M window: 11%, not 53% of a 200 thousand window.
  assert.equal(after.limit, 1_000_000);
  assert.equal(after.pct, 11);
});

test('a session that never went past 200 thousand stays on the default window', () => {
  const r = resumoVazio();
  aplicarEvento(r, reply(1, 150_000));
  assert.equal(contextoDe(session, r)?.limit, 200_000);
  assert.equal(contextoDe({ metadata: {}, model: 'claude-sonnet-4-6[1m]' }, r)?.limit, 1_000_000);
});
