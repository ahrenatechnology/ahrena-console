// Registers a permission request the hook sent: the core recomputes the digest, keeps only the redacted summary and (#618)
// the terminalOnly flag, and never the raw tool input (decision 0025, #618/AC-1, AC-7).
import { DigestMismatch } from './errors.ts';
import { recordChange, refusingAsync } from './internal.ts';
import { PermissionRequest } from './model.ts';
import type { PermissionDeps } from './ports.ts';

export interface RegisterInput {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  permissionMode: string | null;
  /** The digest the hook computed; the core checks it against its own. (#618) */
  digest: string;
}

export function registerRequest(deps: PermissionDeps, input: RegisterInput): Promise<{ requestId: string; expiresAt: number }> {
  return refusingAsync(deps, 'register', input.sessionId, '', async () => {
    const request = await PermissionRequest.open({ id: deps.newId(), sessionId: input.sessionId, toolName: input.toolName, toolInput: input.toolInput, cwd: input.cwd, permissionMode: input.permissionMode, now: deps.clock.now() });
    if (request.digest !== input.digest) throw new DigestMismatch();
    recordChange(deps, request, 'registered');
    return { requestId: request.id, expiresAt: request.expiresAt };
  });
}
