// The sweeps of the core: the requests whose deadline passed (run on a schedule), and the ones open before a restart
// (run once on start). Neither delivers anything (decision 0025, "Prazo" and "Reinício", #618/AC-3).
import { expireIfDue, recordChange } from './internal.ts';
import type { PermissionDeps } from './ports.ts';

/** Expires every open request at or past its deadline; returns their ids. */
export function expireDue(deps: PermissionDeps): string[] {
  return deps.repository.listOpen().filter((request) => expireIfDue(deps, request)).map((request) => request.id);
}

/** On start, every pending or answered request is closed as `core_restarted`: an answer given before is never delivered after. */
export function sweepOnStart(deps: PermissionDeps): string[] {
  return deps.repository.listOpen().map((request) => {
    request.closeAfterRestart(deps.clock.now());
    recordChange(deps, request, 'closed');
    return request.id;
  });
}
