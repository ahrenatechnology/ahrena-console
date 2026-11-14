/*
 * #477 the execution queue of the work board: put an item in line, take it out, reorder it. The queue is
 * one per installation (github/work-queue.ts); the screen filters it.
 *
 * | Request                                                    | Answer                                                    |
 * | ---------------------------------------------------------- | --------------------------------------------------------- |
 * | `POST /api/work/queue` `{ repo, number, target }`          | 200 `{ ok, key, position, target }`                       |
 * | `DELETE /api/work/queue` `{ repo, number }`                | 200 `{ ok, key }`                                         |
 * | `POST /api/work/queue/order` `{ repo, number, after }`     | 200 `{ ok, key, position }`; `after` is an issue key or `null` for the top |
 * | `POST /api/work/queue/retry` (no body is read)             | 200 `{ ok, resumed }`                                     |
 *
 * `repo` is `owner/name`, `number` the issue number, `target` `'desktop' | 'terminal'`: where the session
 * opens when the queue pulls the item (the last choice wins, wireframe 477-1).
 *
 * Refusals, all `{ code, error }` where `code` is stable English the screen branches on and `error` is
 * the pt-BR text it shows:
 * - 403 `untrusted-repository`: the owner is not trusted (#594, github/trusted-owners.ts); checked right
 *   after the body is validated and before the issue is read.
 * - 422 `no-plan`: the issue has no sub-issue (the card's "plano · N passos", #467). "Planeje antes".
 * - 409 `not-plannable`: a closed issue, an epic or an initiative, or a card in Em execução, Em review,
 *   Bloqueado or Concluído, which are facts of the session and of GitHub (`column` names it).
 * - 404 `not-queued`: take out or reorder of something that is not in line, or after something that is not.
 * Taking out and reordering never ask GitHub, so they work with it down and for any repository.
 *
 * Retry (#477 L2): when the puller failed to open the first item the queue is stopped with the item on top and
 * its reason (`stopped` on the board); retry clears that stop and wakes the puller, which tries the same item
 * again. `resumed` is whether a stop was cleared. It answers at once: the pull runs after the answer, and its
 * outcome is on the board (the card leaves, or stops again with a new reason). Its refusals are `{ error }`
 * (origin, JSON, query, method, malformed body); no body field is read.
 *
 * A missing issue is 404, GitHub down with nothing stored 502 with the `reason` code, `--no-github` 503.
 * Same-origin and JSON like /api/work/run; `repo`, `number`, `target` and `after` are validated before
 * anything is read.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import type { RepositoryTrust } from '../github/trusted-owners.ts';
import { isQueueColumn, type CardColumns, type WorkQueueStore } from '../github/work-queue.ts';
import { WorkIssueNotFoundError, type WorkIssueResult, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo, type PlanTarget } from '../github/work-plan.ts';
import { levelOf, workKey } from '../github/work.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { readJsonBody } from './connections-route.ts';
import { NEW_SESSION_TARGETS } from './new-session.ts';
import { UNTRUSTED_REPOSITORY } from './work-session-open.ts';

export const WORK_QUEUE_ROUTE = '/api/work/queue';
export const WORK_QUEUE_ORDER_ROUTE = '/api/work/queue/order';
export const WORK_QUEUE_RETRY_ROUTE = '/api/work/queue/retry';

export interface WorkQueueRouteOptions {
  /** #506 the issue detail use case; `null` under --no-github: putting in the queue answers 503. */
  issues: Pick<WorkIssueService, 'issue'> | null;
  queue: WorkQueueStore;
  /** The column of a card, to refuse the fact columns; the board service implements it. */
  columns: CardColumns;
  /** #594 whose repositories the core queues. Required: a route without it would trust everyone. */
  trust: RepositoryTrust;
  /** #477 L2 the puller `retry` wakes; without it retry only clears the stop. */
  puller?: { trigger(): Promise<void> };
  now?: () => number;
}

export type WorkQueueRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** An answer the route sends as is: a refusal, not a value. */
interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

const isRefusal = (v: object): v is Refusal => 'status' in v && 'body' in v;

const INVALID: Refusal = { status: 400, body: { error: 'pedido inválido' } };

const NOT_QUEUED: Refusal = { status: 404, body: { code: 'not-queued', error: 'Este item não está na fila' } };

/** `owner/name#N` as the screen sends it in `after`: the same shape `workKey` builds. */
const KEY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9]\d{0,9}$/;

interface Request {
  repo: string;
  number: number;
  key: string;
  body: Record<string, unknown>;
}

/** The method is the caller's to check; this reads origin, content type and body, then the item. */
async function readRequest(req: IncomingMessage): Promise<Request | Refusal> {
  if ((req.url ?? '').includes('?')) {
    req.resume();
    return { status: 403, body: { error: 'origem não permitida' } };
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    return { status: 415, body: { error: 'use application/json' } };
  }
  const read = await readJsonBody(req);
  if (!read.ok) return { status: read.error === 'too-large' ? 413 : 400, body: { error: 'pedido inválido' } };
  const body = (read.value ?? {}) as Record<string, unknown>;
  const { repo, number } = body;
  if (typeof repo !== 'string' || !isPlanRepo(repo) || !isPlanNumber(number)) return INVALID;
  return { repo, number, key: workKey(repo, number), body };
}

/** Reads the issue and refuses what cannot be queued; the issue when it can. */
async function queueableIssue(o: WorkQueueRouteOptions & { issues: NonNullable<WorkQueueRouteOptions['issues']> }, key: string): Promise<WorkIssueResult | Refusal> {
  let issue: WorkIssueResult;
  try {
    issue = await o.issues.issue(key);
  } catch (err) {
    if (err instanceof WorkIssueNotFoundError) return { status: 404, body: { error: 'Não achei esta issue no GitHub' } };
    if (err instanceof NoDataError) return { status: 502, body: { error: 'Não deu para ler a issue no GitHub', reason: githubFailureOf(err) } };
    throw err;
  }
  const level = levelOf(issue.type, null);
  if (issue.state === 'CLOSED' || level === 'epic' || level === 'initiative') {
    return { status: 409, body: { code: 'not-plannable', error: 'Só entra na fila uma issue aberta que não seja épico nem iniciativa: ponha as histórias deles' } };
  }
  const column = await o.columns.columnOf(key);
  if (column !== null && !isQueueColumn(column)) {
    return { status: 409, body: { code: 'not-plannable', column, error: 'Este card já está em andamento ou concluído: a coluna é um fato da sessão e do GitHub, não aceita arrastar' } };
  }
  // "has a plan" is the TOTAL sub-issue count, the card's meaning (#467).
  if (issue.subIssues.length === 0) return { status: 422, body: { code: 'no-plan', error: 'Planeje antes: esta issue não tem plano e não entra na fila' } };
  return issue;
}

export function createWorkQueueRoute(o: WorkQueueRouteOptions | null): WorkQueueRoute {
  const now = o?.now ?? Date.now;

  async function enqueue(o: WorkQueueRouteOptions, r: Request): Promise<Refusal | Record<string, unknown>> {
    const { target } = r.body;
    if (typeof target !== 'string' || !(NEW_SESSION_TARGETS as readonly string[]).includes(target)) return { status: 400, body: { error: 'Escolha Claude Desktop ou terminal' } };
    if (!o.issues) return { status: 503, body: { error: 'O GitHub está desligado neste console' } };
    if (!o.trust.isTrusted(r.repo)) return { status: 403, body: UNTRUSTED_REPOSITORY };
    const issue = await queueableIssue({ ...o, issues: o.issues }, r.key);
    if (isRefusal(issue)) return issue;
    const entry = await o.queue.enqueue(r.key, target as PlanTarget, new Date(now()).toISOString());
    return { ok: true, key: r.key, position: entry.position, target: entry.target };
  }

  async function remove(o: WorkQueueRouteOptions, r: Request): Promise<Refusal | Record<string, unknown>> {
    return (await o.queue.remove(r.key)) ? { ok: true, key: r.key } : NOT_QUEUED;
  }

  async function reorder(o: WorkQueueRouteOptions, r: Request): Promise<Refusal | Record<string, unknown>> {
    const { after } = r.body;
    if (after === undefined || (after !== null && (typeof after !== 'string' || !KEY.test(after) || after.toLowerCase() === r.key.toLowerCase()))) return INVALID;
    if (!(await o.queue.reorder(r.key, after))) return NOT_QUEUED;
    return { ok: true, key: r.key, position: (await o.queue.positions()).get(r.key.toLowerCase()) ?? null };
  }

  /** Method, origin, content type and a readable body are checked; the body itself is ignored. */
  async function retry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'use POST' });
    }
    if ((req.url ?? '').includes('?')) {
      req.resume();
      return send(res, 403, { error: 'origem não permitida' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, { error: 'use application/json' });
    }
    const read = await readJsonBody(req);
    if (!read.ok) return send(res, read.error === 'too-large' ? 413 : 400, { error: 'pedido inválido' });
    if (!o) return send(res, 503, { error: 'O GitHub está desligado neste console' });
    const resumed = await o.queue.clearStop();
    // the pull runs after the answer: it never throws, and its outcome is on the board
    void o.puller?.trigger();
    return send(res, 200, { ok: true, resumed });
  }

  return async function workQueueRoute(req, res) {
    if ((req.url ?? '').split('?')[0] === WORK_QUEUE_RETRY_ROUTE) return retry(req, res);
    const order = (req.url ?? '').split('?')[0] === WORK_QUEUE_ORDER_ROUTE;
    const handler = order ? (req.method === 'POST' ? reorder : null) : req.method === 'POST' ? enqueue : req.method === 'DELETE' ? remove : null;
    if (!handler) {
      req.resume();
      return send(res, 405, { error: order ? 'use POST' : 'use POST ou DELETE' });
    }
    const request = await readRequest(req);
    if (isRefusal(request)) return send(res, request.status, request.body);
    if (!o) return send(res, 503, { error: 'O GitHub está desligado neste console' });
    const out = await handler(o, request);
    return isRefusal(out) ? send(res, out.status, out.body) : send(res, 200, out);
  };
}
