// History of the session's plans (issue #131): where one plan ends and the next one begins.
//
// The extraction (extraction.ts) keeps a single list, the current one. Here each change of the list
// is read as an adjustment of the current plan or as a new plan:
// - new plan: the list was swapped for a substantially different one, or the previous plan
//   finished (all steps done) and new steps came;
// - adjustment: checking, unchecking, reordering, appending or renaming steps stays in the same plan;
// - end without a new plan: the list became empty (`/clear`, empty TodoWrite, deleted steps).
//
// The state (number of the open plan, its start and the steps inherited from the previous one) lives
// in `metadata.history` of the stored plan; each plan of the history is a `PlanRecord` in the port.

import type { SessionEvent } from '../model.ts';
import type { PlanRecord, PlanStep, SessionPlan } from './model.ts';

/** How a change splits the plans. Internal: never saved or sent. */
export type PlanSplit = 'continue' | 'new' | 'end';

/** Below this, the new list is another one: fewer than half of the steps in common. */
export const MIN_SIMILARITY = 0.5;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Steps in common (by text) over the size of the larger list: 1 is the same list, 0 none in common. */
export function similarity(a: readonly Pick<PlanStep, 'text'>[], b: readonly Pick<PlanStep, 'text'>[]): number {
  const ta = new Set(a.map((s) => normalize(s.text)));
  const tb = new Set(b.map((s) => normalize(s.text)));
  const larger = Math.max(ta.size, tb.size);
  if (larger === 0) return 1;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / larger;
}

/**
 * The split rule, a pure function. `previous` are the steps of the open plan (empty if there is no
 * open plan), `next` the list after the change. `incremental` is a one-step change (TaskCreate,
 * TaskUpdate, `update_plan` without a list): it never swaps the whole list, so it only starts a
 * new plan when the previous one had already finished.
 */
export function splitPlan(previous: readonly PlanStep[], next: readonly PlanStep[], incremental = false): PlanSplit {
  if (next.length === 0) return previous.length ? 'end' : 'continue';
  if (previous.length === 0) return 'new';
  if (previous.every((s) => s.status === 'completed')) {
    const before = new Set(previous.map((s) => normalize(s.text)));
    // A to-do step the finished plan did not have came in: it is another plan.
    if (next.some((s) => s.status !== 'completed' && !before.has(normalize(s.text)))) return 'new';
    // The same whole list back to pending: the same script, again.
    const inCommon = next.filter((s) => before.has(normalize(s.text)));
    if (inCommon.length === previous.length && inCommon.every((s) => s.status !== 'completed')) return 'new';
    return 'continue';
  }
  if (incremental) return 'continue';
  return similarity(previous, next) < MIN_SIMILARITY ? 'new' : 'continue';
}

/** History state, kept in `metadata.history` of the stored plan. The field names are persisted data. */
export interface PlanHistoryState {
  /** Number of the last plan opened in the session (0: none yet). */
  seq: number;
  open: boolean;
  /** Start of the open plan. */
  start: string | null;
  /** Steps the open plan inherited, already done, from the previous one (`<id>\0<text>`): they are not its own. */
  inherited: string[];
}

const keyOf = (s: PlanStep) => `${s.id}\u0000${s.text}`;

export function planHistoryOf(plan: SessionPlan | null): PlanHistoryState {
  const h = plan?.metadata?.history as Partial<PlanHistoryState> | undefined;
  if (h && typeof h.seq === 'number') {
    return { seq: h.seq, open: h.open === true, start: h.start ?? null, inherited: Array.isArray(h.inherited) ? h.inherited : [] };
  }
  // A plan stored before the history: it is the first one, open since its last change.
  if (plan && plan.steps.length > 0) return { seq: 1, open: true, start: plan.changedAt, inherited: [] };
  return { seq: 0, open: false, start: null, inherited: [] };
}

const ownSteps = (steps: readonly PlanStep[], inherited: readonly string[]) => {
  const out = new Set(inherited);
  return steps.filter((s) => !out.has(keyOf(s)));
};

/** Is the change a one-step change? (TaskCreate, TaskUpdate, `update_plan` without `items`.) */
export function isIncrementalChange(e: SessionEvent): boolean {
  if (e.toolName === 'TaskCreate' || e.toolName === 'TaskUpdate') return true;
  if (!e.toolName || !/(^|__)update_plan$/.test(e.toolName)) return false;
  const input = (e.data as { tool_input?: { items?: unknown } } | null)?.tool_input;
  return !Array.isArray(input?.items);
}

function recordOf(plan: SessionPlan, h: PlanHistoryState, steps: PlanStep[], end: string | null): PlanRecord {
  const done = steps.filter((s) => s.status === 'completed').length;
  return {
    sessionId: plan.sessionId,
    seq: h.seq,
    source: plan.source,
    startedAt: h.start!,
    endedAt: end,
    result: end === null ? 'current' : done === steps.length ? 'completed' : 'abandoned',
    steps,
    done,
    total: steps.length,
    currentStepId: steps.find((s) => s.status === 'in_progress')?.id ?? null,
    changedAt: end ?? plan.changedAt,
    metadata: {},
  };
}

/**
 * Follows the history on a plan change: `before` is the stored plan, `after` what the extraction
 * returned for the event `e`. Returns the plan to write (with `metadata.history` updated) and the
 * history plans that changed: the one that closed and the open one.
 */
export function followHistory(
  before: SessionPlan | null,
  after: SessionPlan,
  e: SessionEvent,
): { plan: SessionPlan; records: PlanRecord[] } {
  let h = planHistoryOf(before);
  const previous = h.open && before ? ownSteps(before.steps, h.inherited) : [];
  const split = splitPlan(previous, ownSteps(after.steps, h.inherited), isIncrementalChange(e));
  const records: PlanRecord[] = [];
  const at = e.createdAt < (h.start ?? '') ? h.start! : e.createdAt;

  if (split !== 'continue' && h.open && before) {
    records.push(recordOf(before, h, previous, at));
    h = { ...h, open: false, start: null, inherited: [] };
  }
  if (split === 'new') {
    // A new plan after a finished one: the done steps that came from it stay in the list
    // (TaskCreate appends to the tasks that already exist), but they belong to the previous plan.
    const finished = previous.length > 0 && previous.every((s) => s.status === 'completed');
    const fromBefore = new Set((before?.steps ?? []).map(keyOf));
    const inherited = finished ? after.steps.filter((s) => s.status === 'completed' && fromBefore.has(keyOf(s))).map(keyOf) : [];
    h = { seq: h.seq + 1, open: true, start: at, inherited: inherited };
  }
  if (h.open) {
    const steps = ownSteps(after.steps, h.inherited);
    if (steps.length > 0) records.push(recordOf(after, h, steps, null));
  }
  return { plan: { ...after, metadata: { ...after.metadata, history: h } }, records };
}
