// Applies an event to the context meter. Pure function: recording (recording.ts) reads, applies in
// order and writes.
//
// - Assistant message with usage (`data.usage`, from the transcript): the context it sent is the
//   input plus the cache read and written. The most recent one wins; a message older than the stored
//   measurement does not replace it.
// - Compaction in the transcript (`Compaction`, the `compact_boundary` mark): the automatic one
//   (`trigger: 'auto'`, the window filled up) is an overflow; the manual one (`/compact`, the panel's
//   Compact button) is counted apart and is not an overflow. If the mark carries the context after the
//   compaction (`postTokens`), it becomes the measurement until the next message.
// - `PreCompact` hook: another view of the same compaction. Both sources count the same
//   compactions, so each count is the larger of the two, never the sum.
// - The compaction's `preTokens` does not change the window: a "prompt too long" above 200k does not
//   prove the session is on the 1M window.
//
// Dates are compared as instants (`Date.parse`), not as text: the hook and the transcript record
// different precisions.

import type { SessionEvent } from '../model.ts';
import { windowFor } from './window.ts';
import { COMPACTION_TRIGGERS, type CompactionTrigger, type ContextMeter } from './model.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The meter's agent: `null` for the main one (no agent, or the importer's `<session>:main`). */
export function meterAgentOf(e: Pick<SessionEvent, 'agentId'>): string | null {
  return e.agentId === null || e.agentId.endsWith(':main') ? null : e.agentId;
}

/** Context tokens of an assistant message; `null` if the event has no usage. */
export function messageContext(e: Pick<SessionEvent, 'data'>): { tokens: number; model: string | null } | null {
  const usage = obj(obj(e.data)?.usage);
  const t = obj(usage?.tokens);
  if (!usage || !t) return null;
  const tokens = n(t.input) + n(t.cacheRead) + n(t.cacheWrite5m) + n(t.cacheWrite1h);
  return tokens > 0 ? { tokens, model: str(usage.model) } : null;
}

interface Compaction {
  source: 'transcript' | 'hook';
  trigger: CompactionTrigger | null;
  after: number;
}

function compactionOf(e: SessionEvent): Compaction | null {
  const d = obj(e.data);
  if (e.type === 'Compaction') {
    const c = obj(d?.compact);
    return { source: 'transcript', trigger: triggerOf(c?.trigger), after: n(c?.postTokens) };
  }
  if (e.type === 'PreCompact') return { source: 'hook', trigger: triggerOf(d?.trigger), after: 0 };
  return null;
}

/** The event's instant in ms; an invalid date is 0. */
export const instantOf = (iso: string | null): number => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

const triggerOf = (v: unknown): CompactionTrigger | null =>
  COMPACTION_TRIGGERS.includes(v as CompactionTrigger) ? (v as CompactionTrigger) : null;

/** Whether the event changes any meter. */
export function isContextEvent(e: SessionEvent): boolean {
  return compactionOf(e) !== null || messageContext(e) !== null;
}

export function emptyMeter(sessionId: string, agentId: string | null, at: string): ContextMeter {
  return {
    sessionId,
    agentId,
    model: null,
    usedTokens: 0,
    windowTokens: windowFor(null, null, 0).tokens,
    windowSource: 'model',
    compactions: 0,
    compactionsTranscript: 0,
    compactionsHook: 0,
    manualCompactions: 0,
    manualCompactionsTranscript: 0,
    manualCompactionsHook: 0,
    lastCompactionAt: null,
    lastCompactionTrigger: null,
    measuredAt: null,
    updatedAt: at,
  };
}

/**
 * Returns the meter with the event applied, or `null` if the event does not change it. The event must
 * belong to the meter's agent (`meterAgentOf`). `sessionModel` is the session's, which may carry `[1m]`.
 */
export function applyToMeter(current: ContextMeter, e: SessionEvent, sessionModel: string | null): ContextMeter | null {
  const message = messageContext(e);
  const compaction = compactionOf(e);
  if (!message && !compaction) return null;

  const t = instantOf(e.createdAt);
  const m: ContextMeter = { ...current, updatedAt: t > instantOf(current.updatedAt) ? e.createdAt : current.updatedAt };
  const isNewer = m.measuredAt === null || t >= instantOf(m.measuredAt);

  if (message && isNewer) {
    m.usedTokens = message.tokens;
    m.model = message.model ?? m.model;
    m.measuredAt = e.createdAt;
  }
  if (compaction) {
    const transcript = compaction.source === 'transcript';
    // Only the automatic one is an overflow; the manual one, and one with no known trigger, stays apart.
    if (compaction.trigger === 'auto') {
      if (transcript) m.compactionsTranscript++;
      else m.compactionsHook++;
    } else if (compaction.trigger === 'manual') {
      if (transcript) m.manualCompactionsTranscript++;
      else m.manualCompactionsHook++;
    }
    m.compactions = Math.max(m.compactionsTranscript, m.compactionsHook);
    m.manualCompactions = Math.max(m.manualCompactionsTranscript, m.manualCompactionsHook);
    if (m.lastCompactionAt === null || t >= instantOf(m.lastCompactionAt)) {
      m.lastCompactionAt = e.createdAt;
      m.lastCompactionTrigger = compaction.trigger ?? m.lastCompactionTrigger;
    }
    if (compaction.after > 0 && isNewer) {
      m.usedTokens = compaction.after;
      m.measuredAt = e.createdAt;
    }
  }

  // The window comes only from what the API accepted (the message), never from the compaction's `preTokens`.
  const seen = message ? Math.max(message.tokens, m.usedTokens) : m.usedTokens;
  const window = windowFor(m.model, sessionModel, seen, { tokens: m.windowTokens, source: m.windowSource });
  m.windowTokens = window.tokens;
  m.windowSource = window.source;
  return m;
}
