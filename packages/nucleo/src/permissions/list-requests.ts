// What the /ui reads for a session: the pending requests and the ones closed in the last 10 minutes, redacted (#618)
// (decision 0025, "Protocolo", #618/AC-7). The shape is the one the wireframe skeleton fixes.
import { expireIfDue } from './internal.ts';
import type { PermissionDeps } from './ports.ts';

/** How long a closed request stays on the screen. (#618) */
export const RECENT_MS = 10 * 60_000;

export interface ListedRequest {
  id: string;
  state: string;
  tool: string;
  /** Already redacted by the domain; the raw tool input is not here to leak. (#618) */
  summary: string;
  folder: string;
  requestedAt: string;
  expiresAt: string;
  terminalOnly: boolean;
  decision: string | null;
  reason: string | null;
  /**
   * ISO time of the answer the screen shows "às HH:MM" for (the wireframe skeleton, 60-7 and 60-8). Answered here: when the owner answered. (#618)
   * Answered elsewhere: when the Console learned it (it closed the request), since the Console never sees the Desktop answer time. Otherwise `null`. (#618)
   */
  answeredAt: string | null;
}

export interface RequestListing {
  available: boolean;
  /** Why the capability is unavailable (`off`, `no_plugin`, ...), decided by the caller; `null` when available. (#618) */
  reason: string | null;
  requests: ListedRequest[];
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function listRequests(deps: PermissionDeps, input: { sessionId: string; unavailableReason: string | null }): RequestListing {
  if (input.unavailableReason !== null) return { available: false, reason: input.unavailableReason, requests: [] };
  const since = deps.clock.now() - RECENT_MS;
  // What leaves the window leaves the store too: a deny reason is not kept in clear past what the screen shows (#618/AC-7).
  deps.repository.clearReasonsSettledBefore(since);
  const requests = deps.repository.listBySession(input.sessionId);
  for (const request of requests) expireIfDue(deps, request);
  const shown = requests.filter((request) => request.isOpen || (request.settledAt ?? 0) >= since);
  return {
    available: true,
    reason: null,
    requests: shown.map((r) => ({
      id: r.id,
      state: r.state,
      tool: r.toolName,
      summary: r.summary,
      folder: r.cwd,
      requestedAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
      terminalOnly: r.terminalOnly,
      decision: r.decision,
      reason: r.reason,
      answeredAt: iso(r.state === 'answered_elsewhere' ? r.settledAt : r.answeredAt),
    })),
  };
}
