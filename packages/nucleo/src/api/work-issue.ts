/*
 * #506 the issue detail of the work board in the API: `GET /api/work/issue`, one issue with its body,
 * comments, parent chain, sub-issues, Plan steps and linked pull request (wireframe 467-1).
 *
 * | Param     | Values                                                         | Required |
 * | --------- | -------------------------------------------------------------- | -------- |
 * | `repo`    | `owner/name`                                                   | yes      |
 * | `number`  | the issue number, a positive integer                           | yes      |
 * | `refresh` | `1` re-reads GitHub (the cache keeps its 30 s floor, ADR-0001) | no       |
 *
 * The body is the use case's `WorkIssueResult` as it is. Errors, as `GET /api/work`: 400 `bad-param` with
 * `param`, 503 `off` under --no-github, 502 `github-unavailable` with the `reason` code when the read fails
 * and nothing is stored, 403 for another site's page, 405 for a method other than GET; and 404 `not-found`
 * when GitHub has no such issue. GitHub down after a read is 200 with the last value, `stale`, `staleReason`
 * (a code, #495) and `fetchedAt`; the raw message goes to the core log.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import { workKey } from '../github/work.ts';
import { WorkIssueNotFoundError, type WorkIssueService } from '../github/work-issue-service.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite } from './same-origin.ts';

export const WORK_ISSUE_ROUTE = '/api/work/issue';
/** #533 `POST`: adds a comment (api/work-issue-write.ts). `PATCH` on `WORK_ISSUE_ROUTE` saves the issue's fields. */
export const WORK_ISSUE_COMMENTS_ROUTE = '/api/work/issue/comments';

export interface WorkIssueRouteOptions {
  /** #506 `null` under --no-github: the route answers 503 `off`; #533 the writes (api/work-issue-write.ts) go through the same service. */
  service: Pick<WorkIssueService, 'issue' | 'update' | 'comment'> | null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;
/** #506 GitHub's GraphQL `Int` is 32-bit: a larger number would fail upstream as a 502, so it is the caller's 400. */
const MAX_NUMBER = 2147483647;

export function createWorkIssueRoute({ service }: WorkIssueRouteOptions) {
  return async function workIssueRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    // #506 reading the issue calls GitHub and spends the credential's quota: never for another site's page.
    if (fromAnotherSite(req)) return send(res, 403, { error: 'forbidden' });
    if (!service) return send(res, 503, { error: 'off' });
    const repo = url.searchParams.get('repo') ?? '';
    const number = url.searchParams.get('number') ?? '';
    if (!REPO.test(repo)) return send(res, 400, { error: 'bad-param', param: 'repo' });
    if (!NUMBER.test(number) || Number(number) > MAX_NUMBER) return send(res, 400, { error: 'bad-param', param: 'number' });
    try {
      send(res, 200, await service.issue(workKey(repo, Number(number)), { force: url.searchParams.get('refresh') === '1' }));
    } catch (err) {
      if (err instanceof WorkIssueNotFoundError) return send(res, 404, { error: 'not-found' });
      if (err instanceof NoDataError) return send(res, 502, { error: 'github-unavailable', reason: githubFailureOf(err) });
      throw err;
    }
  };
}
