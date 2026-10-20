// The watcher covers the hooks that get lost. Pure function: takes the state, the time and what the
// probe saw, and returns the synthetic event the rule asks for (or none). The machine applies and saves.
//
// Rules, in this order (the first that matches wins):
// 1. probe: no live `claude` process in the session's `cwd` → synthetic `SessionEnd` (becomes `completed`);
// 2. abandonment: `active` session idle for 180 min → `Abandoned`;
// 3. dead turn: the main agent is `working`, no tool, no subagent, and nothing changed in 120 s →
//    `Interrupted` (becomes waiting with reason `interrupted`).
// Error healing is not a watcher rule: it happens in the transition, when progress arrives after the error.

import { createHash } from 'node:crypto';
import type { SessionEvent } from '../model.ts';
import { readMemory, mainAgentOf, workingSubagents, lastActivity, type SessionState } from './rules.ts';

/** The watcher's time limits. */
export interface WatcherLimits {
  /** A turn with no signal for this long is taken as dead. Default 120 s. */
  deadTurnMs: number;
  /** An active session idle for this long becomes `abandoned`. Default 180 min. */
  abandonMs: number;
  /** The probe only ends a session idle for at least this long, so it does not catch a process still starting. Default 30 s. */
  probeGraceMs: number;
}

export const DEFAULT_LIMITS: Readonly<WatcherLimits> = {
  deadTurnMs: 120_000,
  abandonMs: 180 * 60_000,
  probeGraceMs: 30_000,
};

/** Which watcher rule fired. Internal: not saved nor sent. */
export type WatcherRule = 'probe' | 'abandonment' | 'dead_turn';

/** A watcher rule that fired and the synthetic event it produced. */
export interface WatcherFinding {
  rule: WatcherRule;
  event: SessionEvent;
}

/** Normalizes a directory to compare it with what the probe returns. */
export function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/**
 * Decides whether a watcher rule applies now.
 * `liveDirs` is the set of directories with a live `claude` process; `null` when the probe is off or failed.
 */
export function checkWatcherRules(
  state: SessionState,
  now: Date,
  liveDirs: ReadonlySet<string> | null,
  limits: WatcherLimits = DEFAULT_LIMITS,
): WatcherFinding | null {
  const s = state.session;
  if (s.endedAt || (s.status !== 'active' && s.status !== 'error')) return null;
  const idle = now.getTime() - Date.parse(lastActivity(state));

  if (liveDirs && s.cwd && idle >= limits.probeGraceMs && !liveDirs.has(normalizeDir(s.cwd))) {
    return { rule: 'probe', event: syntheticEvent(state, now, 'SessionEnd', 'processo encerrado (sonda)', { reason: 'processo_encerrado' }) };
  }

  if (s.status !== 'active') return null;

  if (idle >= limits.abandonMs) {
    return { rule: 'abandonment', event: syntheticEvent(state, now, 'Abandoned', 'sem atividade há 180 min', null) };
  }

  const main = mainAgentOf(state);
  const memory = readMemory(s);
  if (
    !s.awaitingInputSince &&
    main?.status === 'working' &&
    !main.currentTool &&
    Object.keys(memory.delegacoes).length === 0 &&
    workingSubagents(state).length === 0 &&
    idle >= limits.deadTurnMs
  ) {
    return { rule: 'dead_turn', event: syntheticEvent(state, now, 'Interrupted', 'turno sem sinal há 120 s (vigia)', null) };
  }
  return null;
}

// The id prefix, `data.sintetico`, the summaries and the reason are saved with the event: they stay as they are.
function syntheticEvent(state: SessionState, now: Date, type: string, summary: string, extra: Record<string, unknown> | null): SessionEvent {
  const createdAt = now.toISOString();
  const sessionId = state.session.id;
  const digest = createHash('sha256').update(`${sessionId}\0${type}\0${createdAt}`).digest('hex').slice(0, 32);
  return {
    id: `estado:${digest}`,
    sessionId,
    agentId: mainAgentOf(state)?.id ?? null,
    type,
    toolName: null,
    summary,
    data: { sintetico: true, ...extra },
    createdAt,
  };
}
