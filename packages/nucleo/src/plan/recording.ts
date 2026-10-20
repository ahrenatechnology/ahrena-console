// Writes the plan through the port: applies the new events to the stored plan, in order, and writes once.
// The caller is the ingestion (hooks and the transcript importer), with the events it just wrote.
// Each change also goes through the history (history.ts): the plans that closed and the open one
// are written through the port, one record per plan.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { applyToPlan, isPlanEvent } from './extraction.ts';
import { followHistory } from './history.ts';
import type { PlanRecord, SessionPlan } from './model.ts';

/** Returns the stored plan, or `null` if no event changed the plan. */
export async function updatePlan(
  port: Pick<StoragePort, 'getPlan' | 'putPlan' | 'putPlanRecord'>,
  sessionId: string,
  events: readonly SessionEvent[],
): Promise<SessionPlan | null> {
  const planEvents = events
    .filter((e) => e.sessionId === sessionId && isPlanEvent(e))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : a.i - b.i))
    .map(({ e }) => e);
  if (planEvents.length === 0) return null;
  let plan = await port.getPlan(sessionId);
  let changed = false;
  const records = new Map<number, PlanRecord>();
  for (const e of planEvents) {
    const next = applyToPlan(plan, sessionId, e);
    if (next) {
      const h = followHistory(plan, next, e);
      for (const r of h.records) records.set(r.seq, r);
      plan = h.plan;
      changed = true;
    }
  }
  if (!changed || !plan) return null;
  for (const r of records.values()) await port.putPlanRecord(r);
  await port.putPlan(plan);
  return plan;
}

/**
 * Rebuilds the session's plan and history from all stored events. For sessions imported before
 * the plan (#19) or the history (#131): the incremental write only sees new events.
 * Returns how many plans the session had.
 */
export async function rebuildPlan(
  port: Pick<StoragePort, 'listEvents' | 'getPlan' | 'putPlan' | 'putPlanRecord' | 'deletePlanRecords'>,
  sessionId: string,
  /** The same events re-read from the transcript, with the fields the old import did not keep. */
  reread: readonly SessionEvent[] = [],
): Promise<number> {
  const byId = new Map<string, SessionEvent>();
  let cursor: string | null = null;
  do {
    const page = await port.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) if (isPlanEvent(e)) byId.set(e.id, e);
    cursor = page.nextCursor;
  } while (cursor);
  for (const e of reread) if (e.sessionId === sessionId && isPlanEvent(e)) byId.set(e.id, e);
  const planEvents = [...byId.values()];
  if (planEvents.length === 0) return 0;
  await port.deletePlanRecords(sessionId);
  // From scratch: the stored plan only saw part of the events.
  let plans = 0;
  const fromScratch = {
    getPlan: async () => null,
    putPlan: (p: SessionPlan) => port.putPlan(p),
    putPlanRecord: (r: PlanRecord) => ((plans = Math.max(plans, r.seq)), port.putPlanRecord(r)),
  };
  await updatePlan(fromScratch, sessionId, planEvents);
  return plans;
}
