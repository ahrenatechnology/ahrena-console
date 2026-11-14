/*
 * #533 the work board's issue writes in the API: `PATCH /api/work/issue` saves fields of one issue and
 * `POST /api/work/issue/comments` adds a comment (wireframe 478-1). Both write to GitHub with the Console
 * connection's credential and answer the issue as GitHub returned it, the core cache holding that version
 * (ADR-0001, as `POST /api/project/move` does).
 *
 * | Route                           | JSON body                                                                                  | Answer                  |
 * | ------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
 * | `PATCH /api/work/issue`         | `{ repo, number, updatedAt?, title?, body?, labels?, type?, milestone?, parent? }`         | 200 the `GET` body      |
 * | `POST /api/work/issue/comments` | `{ repo, number, body }`                                                                   | 200 the `GET` body      |
 *
 * - `repo` is `owner/name` and `number` a positive integer, as in the read. `labels` replaces the whole set;
 *   `type`, `milestone` and `parent` (an `owner/name#N` key) clear with `null`; an absent field is left alone.
 * - A `title` or `body` save carries `updatedAt`, the version it was opened at: when GitHub's is newer nothing
 *   is written and the answer is 409 `{ error: 'conflict', title, body, updatedAt }`, GitHub's current. The
 *   other fields save with no check.
 * - A GitHub refusal or failure is 502 with a stable `reason` (#495 codes, plus `no-permission`): `github-refused`
 *   for `no-permission` and `no-scope`, `github-unavailable` for the rest. The raw text goes to the core log, and
 *   the cache is as it was. A label, type, milestone or parent GitHub does not know is 422 `unknown-value` with
 *   the `param`, before anything is written; no such issue is 404 `not-found`; --no-github is 503 `off`.
 * - The same gate as `POST /api/work/plan` (decision 0003; server.ts lets only the /ui's own origin in, on the
 *   exact raw path): a query is 403, `Content-Type` other than JSON 415, a body over `MAX_WRITE_BYTES` 413,
 *   malformed JSON 400, an invalid value 400 `bad-param` with the `param`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, type GithubFailure } from '../github/cache.ts';
import { GithubHttpError, GraphqlResponseError } from '../github/github-source.ts';
import { WorkIssueForbiddenError, WorkIssueRefusedError, type WorkIssueEdit } from '../github/work-issue.ts';
import { WorkIssueConflictError, WorkIssueNotFoundError, WorkIssueWriteOffError, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo } from '../github/work-plan.ts';
import { workKey } from '../github/work.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { readJsonBody } from './connections-route.ts';
import { WORK_ISSUE_COMMENTS_ROUTE, WORK_ISSUE_ROUTE } from './work-issue.ts';

/** GitHub's limits: a title is 256 characters, a body or a comment 65536; UTF-8 takes up to 4 bytes of each. */
const MAX_TITLE = 256;
const MAX_TEXT = 65_536;
export const MAX_WRITE_BYTES = 4 * MAX_TEXT + 16_384;
const MAX_LABELS = 100;
const MAX_LABEL = 50;
const MAX_NAME = 256;
const KEY = /^([^#\s]+)#(\d{1,10})$/;

export interface WorkIssueWriteRouteOptions {
  /** #533 `null` under --no-github or --demo: the routes answer 503 `off`. */
  service: Pick<WorkIssueService, 'update' | 'comment'> | null;
}

/** The write's reason: the #495 failure codes plus `no-permission` (the credential may not write). */
export type WorkIssueWriteReason = GithubFailure | 'no-permission';

function reasonOf(err: unknown): WorkIssueWriteReason {
  if (err instanceof WorkIssueForbiddenError) return 'no-permission';
  if (err instanceof GithubHttpError && (err.status === 401 || err.status === 403)) return 'no-permission';
  if (err instanceof GraphqlResponseError && err.types.includes('FORBIDDEN')) return 'no-permission';
  return githubFailureOf(err);
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isName = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function isIssueKey(v: unknown): v is string {
  const m = typeof v === 'string' ? KEY.exec(v) : null;
  return m !== null && isPlanRepo(m[1]!) && isPlanNumber(Number(m[2]));
}

type Parsed = { ok: true; edit: WorkIssueEdit; seenAt: string | undefined } | { ok: false; param: string };

function parseEdit(b: Record<string, unknown>): Parsed {
  const edit: WorkIssueEdit = {};
  if ('title' in b) {
    if (!isText(b.title, MAX_TITLE)) return { ok: false, param: 'title' };
    edit.title = b.title;
  }
  if ('body' in b) {
    if (typeof b.body !== 'string' || b.body.length > MAX_TEXT) return { ok: false, param: 'body' };
    edit.body = b.body;
  }
  if ('labels' in b) {
    if (!Array.isArray(b.labels) || b.labels.length > MAX_LABELS || !b.labels.every((l) => isName(l, MAX_LABEL))) return { ok: false, param: 'labels' };
    edit.labels = b.labels as string[];
  }
  if ('type' in b) {
    if (b.type !== null && !isName(b.type, MAX_NAME)) return { ok: false, param: 'type' };
    edit.type = b.type as string | null;
  }
  if ('milestone' in b) {
    if (b.milestone !== null && !isName(b.milestone, MAX_NAME)) return { ok: false, param: 'milestone' };
    edit.milestone = b.milestone as string | null;
  }
  if ('parent' in b) {
    if (b.parent !== null && !isIssueKey(b.parent)) return { ok: false, param: 'parent' };
    edit.parent = b.parent as string | null;
  }
  if (Object.keys(edit).length === 0) return { ok: false, param: 'edit' };
  const seenAt = b.updatedAt;
  if (edit.title !== undefined || edit.body !== undefined) {
    if (typeof seenAt !== 'string' || seenAt.length > 40 || Number.isNaN(Date.parse(seenAt))) return { ok: false, param: 'updatedAt' };
    return { ok: true, edit, seenAt };
  }
  return { ok: true, edit, seenAt: undefined };
}

export type WorkIssueWriteRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createWorkIssueWriteRoute({ service }: WorkIssueWriteRouteOptions): WorkIssueWriteRoute {
  return async function workIssueWriteRoute(req, res) {
    const path = (req.url ?? '').split('?')[0];
    const comments = path === WORK_ISSUE_COMMENTS_ROUTE;
    if (req.method !== (comments ? 'POST' : 'PATCH')) {
      req.resume();
      return send(res, 405, { error: 'method-not-allowed' });
    }
    // #533 the exact raw path: a query, a trailing slash or an encoded variant is never this route.
    if (req.url !== (comments ? WORK_ISSUE_COMMENTS_ROUTE : WORK_ISSUE_ROUTE)) {
      req.resume();
      return send(res, 403, { error: 'forbidden' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, { error: 'unsupported-media-type' });
    }
    const read = await readJsonBody(req, MAX_WRITE_BYTES);
    if (!read.ok) {
      if (read.error === 'too-large') {
        // The rest of the body is read and dropped (only the /ui reaches here), so the client sees the 413 and not a broken pipe.
        req.resume();
        res.setHeader('connection', 'close');
        return send(res, 413, { error: 'too-large' });
      }
      return send(res, 400, { error: 'invalid' });
    }
    if (!service) return send(res, 503, { error: 'off' });
    const b = read.value;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return send(res, 400, { error: 'bad-param', param: 'edit' });
    const { repo, number } = b as Record<string, unknown>;
    if (typeof repo !== 'string' || !isPlanRepo(repo)) return send(res, 400, { error: 'bad-param', param: 'repo' });
    if (!isPlanNumber(number)) return send(res, 400, { error: 'bad-param', param: 'number' });
    const key = workKey(repo, number);
    try {
      if (comments) {
        const text = (b as Record<string, unknown>).body;
        if (!isText(text, MAX_TEXT)) return send(res, 400, { error: 'bad-param', param: 'body' });
        return send(res, 200, await service.comment(key, text));
      }
      const parsed = parseEdit(b as Record<string, unknown>);
      if (!parsed.ok) return send(res, 400, { error: 'bad-param', param: parsed.param });
      return send(res, 200, await service.update(key, parsed.edit, parsed.seenAt));
    } catch (err) {
      if (err instanceof WorkIssueNotFoundError) return send(res, 404, { error: 'not-found' });
      if (err instanceof WorkIssueConflictError) return send(res, 409, { error: 'conflict', ...err.current });
      if (err instanceof WorkIssueRefusedError) return send(res, 422, { error: 'unknown-value', param: err.param });
      if (err instanceof WorkIssueWriteOffError) return send(res, 503, { error: 'off' });
      const reason = reasonOf(err);
      return send(res, 502, { error: reason === 'no-permission' || reason === 'no-scope' ? 'github-refused' : 'github-unavailable', reason });
    }
  };
}
