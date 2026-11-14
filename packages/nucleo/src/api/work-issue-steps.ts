/*
 * #534 the Plan steps of the work board's issue in the API (wireframe 478-1): each step is a Plan sub-issue of the
 * issue. The routes write to GitHub with the Console connection's credential and answer the issue as GitHub returned
 * it after the write (the `GET /api/work/issue` body, so `plan` is the new plan), the core cache holding that version
 * (ADR-0001, the write seam of #533).
 *
 * | Route                              | JSON body                                                  | Answer             |
 * | ---------------------------------- | ---------------------------------------------------------- | ------------------ |
 * | `POST /api/work/issue/steps`       | `{ repo, number, title, body? }`                           | 200 the `GET` body |
 * | `PATCH /api/work/issue/steps`      | `{ repo, number, step, updatedAt, title?, body? }`         | 200 the `GET` body |
 * | `DELETE /api/work/issue/steps`     | `{ repo, number, step }`                                   | 200 the `GET` body |
 * | `POST /api/work/issue/steps/order` | `{ repo, number, step, after }`                            | 200 the `GET` body |
 * | `POST /api/work/issue/steps/restore` | `{ repo, number, step }`                                 | 200 the `GET` body |
 *
 * - `repo` and `number` name the issue (as in #533); `step` and `after` are issue keys `owner/name#N`. `after` is the
 *   sub-issue the step goes behind, or `null` for the top; it is required (an absent one is 400 `bad-param` `after`).
 * - A new step is a sub-issue of the Plan type, created last. A removed step is closed as not planned and leaves the
 *   plan (its sub-issue stays in `subIssues`).
 * - A restore reopens a removed step (a Plan sub-issue closed as not planned), which returns to the plan; one that is a Plan
 *   sub-issue of the issue but not closed as not planned (open, or closed as completed) is 409 `not-removed`, and a
 *   non-member 422 `unknown-value` `step`; nothing is written either way.
 * - Before any write the step is checked against a fresh read of the issue's sub-issues: one that is not a Plan
 *   sub-issue of it, or is already removed, is 422 `unknown-value` with `param` `step`. `after` may be any sub-issue of
 *   the issue, Plan or not (GitHub orders them all together); one that is not a sub-issue of it is 422 `unknown-value`
 *   with `param` `after`. A repository with no Plan type is 422 `type`; nothing is written. No such issue is 404 `not-found`.
 * - An edit carries `updatedAt`, the step's version the /ui read; when GitHub's is newer nothing is written and the
 *   answer is 409 `{ error: 'conflict', title, body, updatedAt }`, the step as GitHub holds it.
 * - Failures as #533: 502 `github-refused` (`no-permission`, `no-scope`) or `github-unavailable` with a stable
 *   `reason`, the raw text only in the core log and the cache as it was; 502 `written-unread` when GitHub applied
 *   the write and the read-back failed (the cache entry is dropped; the /ui reloads, never retries). A write that timed
 *   out or failed with a 5xx may have been applied: its outcome is unknown (follow-up #544).
 * - The same gate as #533 (decision 0003; server.ts lets only the /ui's own origin in, on the exact raw path and
 *   method): a query is 403, `Content-Type` other than JSON 415, a body over `MAX_WRITE_BYTES` 413, malformed JSON
 *   400, an invalid value 400 `bad-param` with the `param`; --no-github is 503 `off`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkIssueService } from '../github/work-issue-service.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { isIssueKey, isText, MAX_TEXT, MAX_TITLE, readWriteRequest, sendWriteFailure } from './work-issue-write.ts';

export const WORK_ISSUE_STEPS_ROUTE = '/api/work/issue/steps';
/** `POST`: restores a removed step (reopens its sub-issue). */
export const WORK_ISSUE_STEPS_RESTORE_ROUTE = '/api/work/issue/steps/restore';
/** `POST`: moves a step (`WORK_ISSUE_STEPS_ROUTE` takes `POST` to add, `PATCH` to edit and `DELETE` to remove). */
export const WORK_ISSUE_STEPS_ORDER_ROUTE = '/api/work/issue/steps/order';

export interface WorkIssueStepsRouteOptions {
  /** #534 `null` under --no-github or --demo: the routes answer 503 `off`. */
  service: Pick<WorkIssueService, 'editStep' | 'addStep' | 'removeStep' | 'restoreStep' | 'moveStep'> | null;
}

export type WorkIssueStepsRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The methods a step route takes at a path: none for a path that is not one. */
export const stepsRouteMethods = (path: string): readonly string[] =>
  path === WORK_ISSUE_STEPS_ROUTE ? ['POST', 'PATCH', 'DELETE'] : path === WORK_ISSUE_STEPS_ORDER_ROUTE || path === WORK_ISSUE_STEPS_RESTORE_ROUTE ? ['POST'] : [];

type Fail = { ok: false; param: string };

const badParam = (res: ServerResponse, param: string) => send(res, 400, { error: 'bad-param', param });
const isBody = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const isSeenAt = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** #534 the body of a move: the step and the sub-issue it goes behind (`null`: the top), never behind itself. */
function parseStepMove(b: Record<string, unknown>): { ok: true; step: string; after: string | null } | Fail {
  const { step, after } = b;
  if (!isIssueKey(step)) return { ok: false, param: 'step' };
  if (after !== null && (!isIssueKey(after) || after.toLowerCase() === step.toLowerCase())) return { ok: false, param: 'after' };
  return { ok: true, step, after };
}

/** #534 the body of an add: a title, and a text that defaults to empty. */
function parseStepAdd(b: Record<string, unknown>): { ok: true; step: { title: string; body: string } } | Fail {
  if (!isText(b.title, MAX_TITLE)) return { ok: false, param: 'title' };
  if ('body' in b && !isBody(b.body)) return { ok: false, param: 'body' };
  return { ok: true, step: { title: b.title, body: typeof b.body === 'string' ? b.body : '' } };
}

/** #534 the body of a remove or a restore: the step. */
function parseStepKey(b: Record<string, unknown>): { ok: true; step: string } | Fail {
  return isIssueKey(b.step) ? { ok: true, step: b.step } : { ok: false, param: 'step' };
}

/** #534 the body of an edit: the step, at least one of title and body, and the version the /ui read. */
function parseStepEdit(b: Record<string, unknown>): { ok: true; step: string; edit: { title?: string; body?: string }; seenAt: string } | Fail {
  if (!isIssueKey(b.step)) return { ok: false, param: 'step' };
  const edit: { title?: string; body?: string } = {};
  if ('title' in b) {
    if (!isText(b.title, MAX_TITLE)) return { ok: false, param: 'title' };
    edit.title = b.title;
  }
  if ('body' in b) {
    if (!isBody(b.body)) return { ok: false, param: 'body' };
    edit.body = b.body;
  }
  if (edit.title === undefined && edit.body === undefined) return { ok: false, param: 'edit' };
  if (!isSeenAt(b.updatedAt)) return { ok: false, param: 'updatedAt' };
  return { ok: true, step: b.step, edit, seenAt: b.updatedAt };
}

export function createWorkIssueStepsRoute({ service }: WorkIssueStepsRouteOptions): WorkIssueStepsRoute {
  return async function workIssueStepsRoute(req, res) {
    const path = (req.url ?? '').split('?')[0]!;
    const method = req.method ?? '';
    if (!stepsRouteMethods(path).includes(method)) {
      req.resume();
      return send(res, 405, { error: 'method-not-allowed' });
    }
    const request = await readWriteRequest(req, res, { method, route: path, enabled: service !== null });
    if (!request || !service) return;
    const { body: b, key } = request;
    try {
      if (path === WORK_ISSUE_STEPS_ORDER_ROUTE) {
        const p = parseStepMove(b);
        return p.ok ? send(res, 200, await service.moveStep(key, p.step, p.after)) : badParam(res, p.param);
      }
      if (path === WORK_ISSUE_STEPS_RESTORE_ROUTE) {
        const p = parseStepKey(b);
        return p.ok ? send(res, 200, await service.restoreStep(key, p.step)) : badParam(res, p.param);
      }
      if (method === 'POST') {
        const p = parseStepAdd(b);
        return p.ok ? send(res, 200, await service.addStep(key, p.step)) : badParam(res, p.param);
      }
      if (method === 'DELETE') {
        const p = parseStepKey(b);
        return p.ok ? send(res, 200, await service.removeStep(key, p.step)) : badParam(res, p.param);
      }
      const p = parseStepEdit(b);
      return p.ok ? send(res, 200, await service.editStep(key, p.step, p.edit, p.seenAt)) : badParam(res, p.param);
    } catch (err) {
      sendWriteFailure(res, err);
    }
  };
}
