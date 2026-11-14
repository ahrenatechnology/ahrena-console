/*
 * #465 #466 the work board in the API (epic #464): `GET /api/work`, the issues of the chosen GitHub Project
 * in the agent lifecycle columns, with the levels and the filters.
 *
 * | Param        | Values                                                         | Default |
 * | ------------ | -------------------------------------------------------------- | ------- |
 * | `level`      | `initiative`, `epic`, `item` or `plan` (`WORK_LEVELS`)         | `item`  |
 * | `initiative` | `<n>` or `owner/name#<n>`: the node descends from that initiative | —    |
 * | `epic`       | the same, for an epic                                          | —       |
 * | `type`       | `story`, `task`, `spike`, `bug`, `epic`, `initiative`, `plan`   | —       |
 * | `label`      | a label name, case-insensitive                                 | —       |
 * | `repo`       | `name` or `owner/name`, case-insensitive                       | —       |
 * | `status`     | the Project Status slug (`in-progress`), or `no-status`        | —       |
 * | `refresh`    | `1` re-reads GitHub (the cache keeps its 30 s floor, ADR-0001) | —       |
 *
 * The body is the use case's `WorkBoardView` as it is. Errors: 400 `bad-filter` with `param`, 503
 * `no-project` without a chosen Project, 503 `off` under --no-github, 502 `github-unavailable` with the
 * `reason` when the first read fails and nothing is stored. GitHub down after a read is not an error:
 * 200 with the last data, `stale`, `staleReason` and `retryAt` (ADR-0001). `reason` and `staleReason` are a code,
 * never GitHub's message (that goes to the core log, #495). `staleReason` is `network`, `rate-limited`,
 * `no-scope`, `github-error` or `sync-pending` (the stored board is old and no failure is recorded); a
 * 502 `reason` is only one of the first four and never `sync-pending`. `retryAt` (#496) is epoch ms: with `stale: true`, when the core reads GitHub
 * again (the end of the rate-limit pause, else the next scheduled read of the Project, now if it is overdue);
 * `null` when not stale or no read is scheduled. With the background sync the GET answers the stored board (ADR-0015).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import { isWorkBoardFilterError, parseWorkBoardFilters, type WorkProjectBoard } from '../github/work-board.ts';
import type { WorkBoardService } from '../github/work-board-service.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite } from './same-origin.ts';

export const WORK_BOARD_ROUTE = '/api/work';

export interface WorkBoardRouteOptions {
  /** #465 `null` under --no-github: the route answers 503 `off`. */
  service: Pick<WorkBoardService, 'board'> | null;
  /** ADR-0015 the background sync keeps the Project board stored: answer it and wait for GitHub only without one. */
  fromStore?: boolean;
}

/** #465 no GitHub Project is chosen (env, screen or demo): the board has nothing to read. */
export class NoProjectChosenError extends Error {
  constructor() {
    super('no GitHub Project chosen');
    this.name = 'NoProjectChosenError';
  }
}

/**
 * #465 the Project board of the current selection (#241 `ProjectResolver`): the selection can change
 * while the core runs, so every read asks the resolver; none chosen throws `NoProjectChosenError`.
 */
export function selectedProjectBoard(resolver: { kanban(): WorkProjectBoard | null }): WorkProjectBoard {
  const current = (): WorkProjectBoard => {
    const kanban = resolver.kanban();
    if (!kanban) throw new NoProjectChosenError();
    return kanban;
  };
  return {
    board: (options) => current().board(options),
    snapshot: async () => (await current().snapshot?.()) ?? null,
  };
}

export function createWorkBoardRoute({ service, fromStore = false }: WorkBoardRouteOptions) {
  return async function workBoardRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    // #465 reading the board calls GitHub and spends the credential's quota: never for another site's page.
    if (fromAnotherSite(req)) return send(res, 403, { error: 'forbidden' });
    if (!service) return send(res, 503, { error: 'off' });
    const filters = parseWorkBoardFilters(url.searchParams);
    if (isWorkBoardFilterError(filters)) return send(res, 400, filters);
    try {
      send(res, 200, await service.board(filters, { force: url.searchParams.get('refresh') === '1', fromStore }));
    } catch (err) {
      if (err instanceof NoProjectChosenError) return send(res, 503, { error: 'no-project' });
      // #465 502 as /api/project's `github-down`: GitHub, the upstream, failed and nothing is stored.
      if (err instanceof NoDataError) return send(res, 502, { error: 'github-unavailable', reason: githubFailureOf(err) });
      throw err;
    }
  };
}
