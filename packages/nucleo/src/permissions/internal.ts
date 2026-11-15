// What the use cases share: finding a request of a session, settling an overdue one, and writing what happened to the
// audit and the change feed. Nothing here is exported by the package. (#618, layer 2)
import { createHash } from 'node:crypto';
import { DigestMismatch, PermissionNotFound } from './errors.ts';
import { PermissionRefusal, type PermissionRequest } from './model.ts';
import type { PermissionDeps } from './ports.ts';

/** The id of a caller is data: it is cut before it reaches the audit. */
const clip = (text: string): string => text.slice(0, 128);

/** SHA-256 hex of a reason: the only form in which a reason reaches the audit (#618/AC-7). */
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The request with this id of this session, or `PermissionNotFound`: another session's id is no request (#618/AC-1). */
export function mustFind(deps: PermissionDeps, sessionId: string, requestId: string): PermissionRequest {
  const request = deps.repository.find(sessionId, requestId);
  if (request === null) throw new PermissionNotFound();
  return request;
}

/** Saves a request that changed, and tells the audit and the change feed what became of it. */
export function recordChange(deps: PermissionDeps, request: PermissionRequest, event: 'registered' | 'answered' | 'delivered' | 'closed'): void {
  deps.repository.save(request);
  const base = { at: deps.clock.now(), event, requestId: request.id, sessionId: request.sessionId, digest: request.digest, state: request.state };
  switch (event) {
    case 'registered':
      deps.audit.append({ ...base, toolName: request.toolName, terminalOnly: request.terminalOnly });
      break;
    case 'answered':
      deps.audit.append({ ...base, decision: request.decision ?? undefined, answeredBy: request.answeredBy ?? undefined, channel: request.channel ?? undefined, reasonSha256: request.reason === null ? null : sha256Hex(request.reason) });
      break;
    case 'delivered':
      deps.audit.append({ ...base, decision: request.decision ?? undefined, answeredBy: request.answeredBy ?? undefined, channel: request.channel ?? undefined });
      break;
    case 'closed':
      deps.audit.append({ ...base, settledBy: request.settledBy ?? undefined });
      break;
  }
  deps.notifier.publish({ sessionId: request.sessionId, requestId: request.id, state: request.state });
}

/** An open request whose deadline passed is settled as expired, wherever it is first seen; returns whether it was. */
export function expireIfDue(deps: PermissionDeps, request: PermissionRequest): boolean {
  if (!request.isOpen || deps.clock.now() < request.expiresAt) return false;
  request.expire(deps.clock.now());
  recordChange(deps, request, 'closed');
  return true;
}

/** Audits a refusal and lets it go on: every refusal is a record, none carries the call or the reason (#618/AC-7). */
export function auditRefusal(deps: PermissionDeps, operation: string, sessionId: string, requestId: string, error: unknown): void {
  const code = error instanceof PermissionRefusal || error instanceof PermissionNotFound || error instanceof DigestMismatch ? error.code : null;
  if (code === null) return;
  deps.audit.append({ at: deps.clock.now(), event: 'refused', requestId: clip(requestId), sessionId: clip(sessionId), operation, code });
}

export function refusing<T>(deps: PermissionDeps, operation: string, sessionId: string, requestId: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    auditRefusal(deps, operation, sessionId, requestId, error);
    throw error;
  }
}

export async function refusingAsync<T>(deps: PermissionDeps, operation: string, sessionId: string, requestId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    auditRefusal(deps, operation, sessionId, requestId, error);
    throw error;
  }
}
