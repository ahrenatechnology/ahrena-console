// A fake of the memory module's reads for the route tests: real shapes from the readers, a record of every call, no process (#735).

import { readBridgeHandoffs, type MemoryBridgeHandoffsReading } from '../bridge-readers.ts';
import type { MemoryRead, MemoryStatusState, MemoryStatusWithLocalState } from '../memory.ts';
import { readRecent, readStatus, type MemoryRecentPage, type MemoryStatusReading } from '../readers.ts';
import { bridgeHandoffsFixture, recentFixture, statusFixture } from './fixtures.ts';

/** What the routes read from the module; the route file declares the same list as `MemoryReads` (#735). */
export interface FakeReads {
  status(): Promise<MemoryStatusState>;
  statusWithLocal(): Promise<MemoryStatusWithLocalState>;
  recent(project: string): Promise<MemoryRead<MemoryRecentPage[]>>;
  bridgeHandoffsWithLocal(project: string): Promise<MemoryRead<MemoryBridgeHandoffsReading>>;
  sessionHandoffsWithLocal(project: string, sessionId: string): Promise<MemoryRead<{ opened: MemoryBridgeHandoffsReading['handoffs']; local: MemoryBridgeHandoffsReading['local'] }>>;
  sessionCaptured(project: string, sessionId: string): Promise<MemoryRead<boolean>>;
}

/** A `status` reading of a server with auth on, no LLM and no embeddings: no alert; `over` replaces fields of the raw `status --json` (#735). */
export function statusReading(over: Record<string, unknown> = {}): MemoryStatusReading {
  const base = statusFixture() as { providers: { llm: Record<string, unknown>; embedding: Record<string, unknown> } };
  const raw = { ...base, auth_posture: { posture: 'auth_enabled' }, providers: { ...base.providers, llm: { ...base.providers.llm, status: 'disabled', provider: null, model: null } }, ...over };
  return readStatus(JSON.stringify(raw));
}

/** The fake and its record: `calls` holds one entry per call, `name` or `name:project[:session]` (#735). */
export function fakeReads(over: Partial<FakeReads> = {}): { memory: FakeReads; calls: string[] } {
  const calls: string[] = [];
  const reading = statusReading();
  const handoffs = readBridgeHandoffs(JSON.stringify({ handoffs: bridgeHandoffsFixture() }));
  const memory: FakeReads = {
    status: async () => (calls.push('status'), { state: 'running', status: reading.status }),
    statusWithLocal: async () => (calls.push('statusWithLocal'), { state: 'running', status: reading.status, local: reading.local }),
    recent: async (project) => (calls.push(`recent:${project}`), { ok: true, value: readRecent(JSON.stringify(recentFixture())) }),
    bridgeHandoffsWithLocal: async (project) => (calls.push(`bridgeHandoffsWithLocal:${project}`), { ok: true, value: handoffs }),
    sessionHandoffsWithLocal: async (project, id) => {
      calls.push(`sessionHandoffsWithLocal:${project}:${id}`);
      const opened = handoffs.handoffs.filter((h) => h.from_session_id === id);
      return { ok: true, value: { opened, local: handoffs.local.filter((l) => opened.some((h) => h.id === l.id)) } };
    },
    sessionCaptured: async (project, id) => (calls.push(`sessionCaptured:${project}:${id}`), { ok: true, value: true }),
    ...over,
  };
  return { memory, calls };
}
