// The hook gave up at its own deadline: the request is withdrawn and never delivered (decision 0025, #618/AC-3).
import { mustFind, recordChange, refusing } from './internal.ts';
import type { PermissionDeps } from './ports.ts';

export function withdrawRequest(deps: PermissionDeps, input: { sessionId: string; requestId: string }): void {
  refusing(deps, 'withdraw', input.sessionId, input.requestId, () => {
    const request = mustFind(deps, input.sessionId, input.requestId);
    request.withdraw(deps.clock.now());
    recordChange(deps, request, 'closed');
  });
}
