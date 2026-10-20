// Records the context meter through the port: applies the new events to the stored meters, in order,
// and writes each meter that changed once. The caller is ingestion (hooks and the transcript importer),
// with the events it has just written; a repeated event never reaches here, so nothing counts twice.
// `rebuildContextMeters` rebuilds the meters from scratch, for reprocessing the history.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { meterAgentOf, applyToMeter, isContextEvent, instantOf, emptyMeter } from './measurement.ts';
import type { ContextMeter } from './model.ts';

/** Returns the meters written (the ones that changed). */
export async function updateContextMeters(
  port: Pick<StoragePort, 'getSession' | 'listContextMeters' | 'putContextMeter'>,
  sessionId: string,
  events: readonly SessionEvent[],
): Promise<ContextMeter[]> {
  const contextEvents = events
    .filter((e) => e.sessionId === sessionId && isContextEvent(e))
    .map((e, i) => ({ e, i, t: instantOf(e.createdAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
  if (contextEvents.length === 0) return [];

  const sessionModel = (await port.getSession(sessionId))?.model ?? null;
  const stored = new Map((await port.listContextMeters(sessionId)).map((m) => [m.agentId, m] as const));
  const changed = new Map<string | null, ContextMeter>();
  for (const e of contextEvents) {
    const agent = meterAgentOf(e);
    const current = changed.get(agent) ?? stored.get(agent) ?? emptyMeter(sessionId, agent, e.createdAt);
    const next = applyToMeter(current, e, sessionModel);
    if (next) changed.set(agent, next);
  }
  for (const m of changed.values()) await port.putContextMeter(m);
  return [...changed.values()];
}

/**
 * Rebuilds the session's meters from scratch out of the stored events and the same events read again
 * from the transcript (which carry the `compactMetadata` the old import did not keep). The reread
 * event replaces the stored one with the same id. Returns how many meters it wrote.
 */
export async function rebuildContextMeters(
  port: Pick<StoragePort, 'getSession' | 'listEvents' | 'putContextMeter' | 'deleteContextMeters'>,
  sessionId: string,
  reread: readonly SessionEvent[] = [],
): Promise<number> {
  const byId = new Map<string, SessionEvent>();
  let cursor: string | null = null;
  do {
    const page = await port.listEvents(sessionId, { limit: 500, cursor });
    for (const e of page.items) if (isContextEvent(e)) byId.set(e.id, e);
    cursor = page.nextCursor;
  } while (cursor);
  for (const e of reread) if (e.sessionId === sessionId && isContextEvent(e)) byId.set(e.id, e);
  if (byId.size === 0) return 0;
  await port.deleteContextMeters(sessionId);
  const fromScratch = { getSession: port.getSession.bind(port), listContextMeters: async () => [], putContextMeter: port.putContextMeter.bind(port) };
  return (await updateContextMeters(fromScratch, sessionId, [...byId.values()])).length;
}
