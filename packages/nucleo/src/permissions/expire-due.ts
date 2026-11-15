// The sweeps of the core: the requests whose deadline passed (run on a schedule), and the ones open before a restart (#618)
// (run once on start). Neither delivers anything (decision 0025, "Prazo" and "Reinício", #618/AC-3).
import { expireIfDue, recordChange } from './internal.ts';
import { RECENT_MS } from './list-requests.ts';
import type { PermissionDeps } from './ports.ts';

/** Expires every open request at or past its deadline, and nulls the reasons settled before the window; returns the ids expired. (#618) */
export function expireDue(deps: PermissionDeps): string[] {
  // Without a listing or a restart, this sweep is what keeps a deny reason from outliving the /ui window (#618/AC-7).
  deps.repository.clearReasonsSettledBefore(deps.clock.now() - RECENT_MS);
  return deps.repository.listOpen().filter((request) => expireIfDue(deps, request)).map((request) => request.id);
}

/** On start, every pending or answered request is closed as `core_restarted`: an answer given before is never delivered after, and old reasons are cleared. (#618) */
export function sweepOnStart(deps: PermissionDeps): string[] {
  // A deny reason does not outlive the window the /ui lists a closed request for (#618/AC-7).
  deps.repository.clearReasonsSettledBefore(deps.clock.now() - RECENT_MS);
  return deps.repository.listOpen().map((request) => {
    request.closeAfterRestart(deps.clock.now());
    recordChange(deps, request, 'closed');
    return request.id;
  });
}
