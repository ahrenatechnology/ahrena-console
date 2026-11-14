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
 *   `parent` is saved on its own: carried with another field it is 400 `bad-param` `parent` and nothing is written
 *   (a parent change is a second GitHub call, and a half-written save would 409 the user's own retry).
 * - A `title` or `body` save carries `updatedAt`, the version it was opened at: when GitHub's is newer nothing
 *   is written and the answer is 409 `{ error: 'conflict', title, body, updatedAt }`, GitHub's current. The
 *   other fields save with no check.
 * - A GitHub refusal or failure is 502 with a stable `reason` (#495 codes, plus `no-permission`): `github-refused`
 *   for `no-permission` and `no-scope`, `github-unavailable` for the rest. The raw text goes to the core log, and
 *   the cache is as it was. A label, type, milestone or parent GitHub does not know is 422 `unknown-value` with
 *   the `param`, before anything is written; no such issue is 404 `not-found`; --no-github is 503 `off`.
 * - GitHub applied the write and reading the issue back failed: 502 `{ error: 'written-unread', reason }`, the
 *   `reason` the #495 code of the failed read. It is not a refusal: the issue on GitHub is changed, so the /ui
 *   reloads and never offers a retry (a retried comment would post twice). The core drops its cached version, so
 *   the next `GET` reads GitHub.
 * - The same gate as `POST /api/work/plan` (decision 0003; server.ts lets only the /ui's own origin in, on the
 *   exact raw path): a query is 403, `Content-Type` other than JSON 415, a body over `MAX_WRITE_BYTES` 413,
 *   malformed JSON 400, an invalid value 400 `bad-param` with the `param`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, type GithubFailure } from '../github/cache.ts';
import { GithubHttpError, GraphqlResponseError } from '../github/github-source.ts';
import { WorkIssueForbiddenError, WorkIssueNotRemovedError, WorkIssueRefusedError, WorkIssueWrittenUnreadError, type WorkIssueEdit } from '../github/work-issue.ts';
import { WorkIssueConflictError, WorkIssueNotFoundError, WorkIssueWriteOffError, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo } from '../github/work-plan.ts';
import { workKey } from '../github/work.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { readJsonBody } from './connections-route.ts';
import { WORK_ISSUE_COMMENTS_ROUTE, WORK_ISSUE_ROUTE } from './work-issue.ts';

/** #533 GitHub's limits: a title is 256 characters, a body or a comment 65536; UTF-8 takes up to 4 bytes of each. */
export const MAX_TITLE = 256;
export const MAX_TEXT = 65_536;
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

export const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isName = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isIssueKey(v: unknown): v is string {
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
  if ('parent' in edit && Object.keys(edit).length > 1) return { ok: false, param: 'parent' };
  const seenAt = b.updatedAt;
  if (edit.title !== undefined || edit.body !== undefined) {
    if (typeof seenAt !== 'string' || seenAt.length > 40 || Number.isNaN(Date.parse(seenAt))) return { ok: false, param: 'updatedAt' };
    return { ok: true, edit, seenAt };
  }
  return { ok: true, edit, seenAt: undefined };
}

export type WorkIssueWriteRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** #533 a write request that passed the shared checks: the JSON body, and the issue it names. */
export interface WriteRequest {
  body: Record<string, unknown>;
  key: string;
}

/**
 * The checks every issue write route shares, in order (#534 reuses them): the method (405), the exact raw path (403),
 * JSON only (415), the bounded body (413), malformed JSON (400), `--no-github` (503 `off`), then `repo` and `number`
 * (400 `bad-param`). It answers on failure and returns `null`; the route goes on with the body only when it returns one.
 */
export async function readWriteRequest(req: IncomingMessage, res: ServerResponse, route: { method: string; route: string; enabled: boolean }): Promise<WriteRequest | null> {
  const read = await readTransport(req, res, route);
  return read === null ? null : readTarget(res, read.body);
}

/** #534 the transport checks: the method (405), the exact raw path (403), JSON only (415), the bounded body (413, 400), `--no-github` (503). */
async function readTransport(req: IncomingMessage, res: ServerResponse, { method, route, enabled }: { method: string; route: string; enabled: boolean }): Promise<{ body: unknown } | null> {
  if (req.method !== method) {
    req.resume();
    send(res, 405, { error: 'method-not-allowed' });
    return null;
  }
  // #533 the exact raw path: a query, a trailing slash or an encoded variant is never this route.
  if (req.url !== route) {
    req.resume();
    send(res, 403, { error: 'forbidden' });
    return null;
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    send(res, 415, { error: 'unsupported-media-type' });
    return null;
  }
  const read = await readJsonBody(req, MAX_WRITE_BYTES);
  if (!read.ok) {
    if (read.error === 'too-large') {
      // #533 the rest of the body is read and dropped (only the /ui reaches here), so the client sees the 413 and not a broken pipe.
      req.resume();
      res.setHeader('connection', 'close');
      send(res, 413, { error: 'too-large' });
    } else send(res, 400, { error: 'invalid' });
    return null;
  }
  if (!enabled) {
    send(res, 503, { error: 'off' });
    return null;
  }
  return { body: read.value };
}

/** #534 the target checks: the body is an object, `repo` and `number` name an issue (400 `bad-param`); answers the key. */
function readTarget(res: ServerResponse, b: unknown): WriteRequest | null {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    send(res, 400, { error: 'bad-param', param: 'edit' });
    return null;
  }
  const { repo, number } = b as Record<string, unknown>;
  if (typeof repo !== 'string' || !isPlanRepo(repo)) {
    send(res, 400, { error: 'bad-param', param: 'repo' });
    return null;
  }
  if (!isPlanNumber(number)) {
    send(res, 400, { error: 'bad-param', param: 'number' });
    return null;
  }
  return { body: b as Record<string, unknown>, key: workKey(repo, number) };
}

/** #533 a failed write as the /ui sees it: a status and a stable code, never GitHub's text (that went to the core log). */
export function sendWriteFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof WorkIssueNotFoundError) return send(res, 404, { error: 'not-found' });
  if (err instanceof WorkIssueConflictError) return send(res, 409, { error: 'conflict', ...err.current });
  if (err instanceof WorkIssueRefusedError) return send(res, 422, { error: 'unknown-value', param: err.param });
  if (err instanceof WorkIssueNotRemovedError) return send(res, 409, { error: 'not-removed' });
  if (err instanceof WorkIssueWriteOffError) return send(res, 503, { error: 'off' });
  if (err instanceof WorkIssueWrittenUnreadError) return send(res, 502, { error: 'written-unread', reason: githubFailureOf(err.cause) });
  const reason = reasonOf(err);
  return send(res, 502, { error: reason === 'no-permission' || reason === 'no-scope' ? 'github-refused' : 'github-unavailable', reason });
}

export function createWorkIssueWriteRoute({ service }: WorkIssueWriteRouteOptions): WorkIssueWriteRoute {
  return async function workIssueWriteRoute(req, res) {
    const comments = (req.url ?? '').split('?')[0] === WORK_ISSUE_COMMENTS_ROUTE;
    const request = await readWriteRequest(req, res, { method: comments ? 'POST' : 'PATCH', route: comments ? WORK_ISSUE_COMMENTS_ROUTE : WORK_ISSUE_ROUTE, enabled: service !== null });
    if (!request || !service) return;
    const { body: b, key } = request;
    try {
      if (comments) {
        if (!isText(b.body, MAX_TEXT)) return send(res, 400, { error: 'bad-param', param: 'body' });
        return send(res, 200, await service.comment(key, b.body));
      }
      const parsed = parseEdit(b);
      if (!parsed.ok) return send(res, 400, { error: 'bad-param', param: parsed.param });
      return send(res, 200, await service.update(key, parsed.edit, parsed.seenAt));
    } catch (err) {
      sendWriteFailure(res, err);
    }
  };
}
