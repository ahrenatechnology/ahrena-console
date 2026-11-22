/*
 * What the memory routes answer, built field by field from the module's values (#735). Nothing here spreads or returns a module
 * object whole: each item names the fields it carries, so a field upstream adds later does not come out. The local part (a path, a
 * personal field) sits under a `local` key, and these answers are for the local routes only (#735/D3).
 */

import type { MemorySessionHandoff, MemorySessionHandoffLocal } from '../memory/bridge-readers.ts';
import type { MemoryStatusWithLocalState } from '../memory/memory.ts';
import type { MemoryRecentPage, MemoryStatus, MemoryStatusLocal } from '../memory/readers.ts';

/** The ids of the alerts, in english; the text is what the person reads (#735, #719/AC-5, AC-6, AC-12). */
export type MemoryAlertId = 'bind-not-loopback' | 'auth-none-loopback' | 'llm-provider-configured' | 'embeddings-enabled';

export interface MemoryAlert {
  id: MemoryAlertId;
  text: string;
}

// The texts are fixed: no value from the status goes into them (#735).
const ALERTS: Record<MemoryAlertId, MemoryAlert> = {
  'bind-not-loopback': { id: 'bind-not-loopback', text: 'O servidor da memória não está ouvindo só em 127.0.0.1: outras máquinas podem alcançá-lo.' },
  'auth-none-loopback': { id: 'auth-none-loopback', text: 'O servidor da memória não pede autenticação: qualquer programa deste computador pode ler o que ele guarda.' },
  'llm-provider-configured': { id: 'llm-provider-configured', text: 'Há um provedor de LLM configurado no ai-memory: os prompts capturados passam a ir para esse provedor.' },
  'embeddings-enabled': { id: 'embeddings-enabled', text: 'Os embeddings estão ligados no ai-memory: o texto capturado pode passar pelo provedor deles.' },
};

// Only 127.0.0.1 with a port confirms the loopback bind; localhost, ::1 and 0.0.0.0 do not (#735).
const LOOPBACK_BIND = /^127\.0\.0\.1:\d{1,5}$/;

/** Whether the status's bind is 127.0.0.1 (#735, #719/AC-6). */
export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_BIND.test(bind);
}

/** The alert the bridge routes refuse with (#735, #719/AC-6). */
export function bindAlert(): MemoryAlert {
  return { ...ALERTS['bind-not-loopback'] };
}

/** The alerts a status carries: a bind that is not 127.0.0.1, no authentication, an LLM provider, embeddings (#735, #719/AC-5, AC-6, AC-12). */
export function memoryAlerts(status: MemoryStatus): MemoryAlert[] {
  const ids: MemoryAlertId[] = [];
  if (!isLoopbackBind(status.bind)) ids.push('bind-not-loopback');
  if (status.auth_posture === 'none_loopback') ids.push('auth-none-loopback');
  if (status.providers.llm.provider !== null) ids.push('llm-provider-configured');
  if (status.providers.embedding.status !== 'disabled') ids.push('embeddings-enabled');
  return ids.map((id) => ({ ...ALERTS[id] }));
}

export type MemoryServerView =
  | { state: 'unavailable' | 'stopped' | 'failed'; alerts: MemoryAlert[] }
  | {
      state: 'running';
      version: string;
      bind: string;
      auth_posture: string;
      client_auth: 'on' | 'off';
      llm: { status: string; provider: string | null };
      embeddings: { status: string };
      capture_mode: string;
      counts: { sessions: number; pages_latest: number; pages_all: number; observations: number };
      storage: { database_bytes: number; data_dir_free_bytes: number | null };
      alerts: MemoryAlert[];
      local?: { data_dir: string; db_path: string };
    };

/** `GET /api/memory`: the state, and for a running server its named fields; a server that is not running carries no detail (#735, #719/AC-5). */
export function serverView(read: MemoryStatusWithLocalState): MemoryServerView {
  if (read.state !== 'running') return { state: read.state === 'unknown' ? 'failed' : read.state, alerts: [] };
  if (!read.status) return { state: 'failed', alerts: [] };
  const { status } = read;
  return {
    state: 'running',
    version: status.version,
    bind: status.bind,
    auth_posture: status.auth_posture,
    client_auth: status.client_auth,
    llm: { status: status.providers.llm.status, provider: status.providers.llm.provider },
    embeddings: { status: status.providers.embedding.status },
    capture_mode: status.capture_mode,
    counts: { sessions: status.counts.sessions, pages_latest: status.counts.pages_latest, pages_all: status.counts.pages_all, observations: status.counts.observations },
    storage: { database_bytes: status.storage.database_bytes, data_dir_free_bytes: status.storage.data_dir_free_bytes },
    alerts: memoryAlerts(status),
    ...(read.local ? { local: localPaths(read.local) } : {}),
  };
}

function localPaths(local: MemoryStatusLocal): { data_dir: string; db_path: string } {
  return { data_dir: local.data_dir, db_path: local.db_path };
}

/** One handoff item of the answers (#735). */
export interface MemoryHandoffItem {
  id: string;
  from_session_id: string | null;
  from_agent: string;
  to_agent: string | null;
  state: string;
  created_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_by_session: string | null;
  local: { cwd: string | null; owner_user: string | null; accepted_by_user: string | null };
}

/** One page item of the answers (#735). */
export interface MemoryPageItem {
  path: string;
  title: string;
  updated_at: string;
}

/** One open handoff: no body, and the cwd and the two personal fields under `local` (#719/AC-7, #735/D2). */
export function handoffView(handoff: MemorySessionHandoff, local: MemorySessionHandoffLocal | undefined): MemoryHandoffItem {
  return {
    id: handoff.id,
    from_session_id: handoff.from_session_id,
    from_agent: handoff.from_agent,
    to_agent: handoff.to_agent,
    state: handoff.state,
    created_at: handoff.created_at,
    accepted_by: handoff.accepted_by,
    accepted_at: handoff.accepted_at,
    accepted_by_session: handoff.accepted_by_session,
    local: { cwd: local?.cwd ?? null, owner_user: local?.owner_user ?? null, accepted_by_user: local?.accepted_by_user ?? null },
  };
}

/** One recent page: path, title and date, never the snippet (#735, #719/AC-7). */
export function pageView(page: MemoryRecentPage): MemoryPageItem {
  return { path: page.path, title: page.title, updated_at: page.updated_at };
}
