/*
 * #590 the issue options of a repository in the API: `GET /api/work/issue/options`, what the work board's
 * edit mode offers in its selectors: the repository's labels, issue types, open milestones and the open
 * issues that can be a parent.
 *
 * | Param     | Values                                                         | Required |
 * | --------- | -------------------------------------------------------------- | -------- |
 * | `repo`    | `owner/name`                                                   | yes      |
 * | `refresh` | `1` re-reads GitHub (the cache keeps its 30 s floor, ADR-0001) | no       |
 *
 * The body is `{ labels, types, milestones, parents, fetchedAt, stale, staleReason }`: names, titles of the
 * open milestones and `{ key: 'owner/name#N', title }` parents, each list bounded (github/work-issue-options.ts).
 * Errors, as `GET /api/work/issue`: 400 `bad-param` with `param`, 503 `off` under --no-github, 502
 * `github-unavailable` with the `reason` code when the read fails and nothing is stored, 403 for another
 * site's page, 405 for a method other than GET; and 404 `not-found` when GitHub has no such repository.
 * GitHub down after a read is 200 with the last value, `stale`, `staleReason` (a code, #495) and `fetchedAt`;
 * the raw message goes to the core log.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import { WorkRepositoryNotFoundError, type WorkIssueOptionsService } from '../github/work-issue-options.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite } from './same-origin.ts';

export const WORK_ISSUE_OPTIONS_ROUTE = '/api/work/issue/options';

export interface WorkIssueOptionsRouteOptions {
  /** `null` under --demo and --no-github: the route answers 503 `off`. */
  service: Pick<WorkIssueOptionsService, 'options'> | null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createWorkIssueOptionsRoute({ service }: WorkIssueOptionsRouteOptions) {
  return async function workIssueOptionsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    // #590 reading the options calls GitHub and spends the credential's quota: never for another site's page.
    if (fromAnotherSite(req)) return send(res, 403, { error: 'forbidden' });
    if (!service) return send(res, 503, { error: 'off' });
    const repo = url.searchParams.get('repo') ?? '';
    if (!REPO.test(repo)) return send(res, 400, { error: 'bad-param', param: 'repo' });
    try {
      send(res, 200, await service.options(repo, { force: url.searchParams.get('refresh') === '1' }));
    } catch (err) {
      if (err instanceof WorkRepositoryNotFoundError) return send(res, 404, { error: 'not-found' });
      if (err instanceof NoDataError) return send(res, 502, { error: 'github-unavailable', reason: githubFailureOf(err) });
      throw err;
    }
  };
}
