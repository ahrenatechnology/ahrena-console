/*
 * The memory action routes (#740, #719): the plan a dialog shows and the confirm that queues it, for activate, stop, start,
 * deactivate and delete-data. The same conventions as the Docker routes (decision 0017), local only:
 * - `GET /api/memory/plan?action=<id>`: the plan (the steps without any path, the accounts, the service, the `planDigest`, the consent
 *   or the notices), built from a fresh read. 404 unknown action, 409 `{ error, reason }` when the action is not offered now.
 * - `POST /api/memory/actions/<id>` `{ planDigest, acknowledgeDataLoss? }`: 202 `{ job }`; 409 `{ error, reason: 'stale-plan', plan }`
 *   when the digest is not the plan's now; 400 when the acknowledgment delete-data needs is missing. Nothing runs on any refusal.
 * - Every write goes through `memoryWriteAllowed` in the server INSTEAD of the usual gate: our Host, the exact raw path with POST, and
 *   `Origin` exactly `http://<Host>`; no Origin is 403, there is no remote-actions switch for the memory (#740/AC-6).
 * - The routes are not in the remote credential's closed list (api/owner-auth.ts) and refuse `machine`, so a remote request never
 *   reaches them: the plan names local paths (#740, #735/D3). Every answer is built from named fields; a failure answers our text and a
 *   closed reason, never a detail of the process (decision 0026).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { MEMORY_ACTIONS, type MemoryActionId, type MemoryActionPlan, type MemoryActions } from '../memory/actions.ts';
import type { MemoryReadFailure } from '../memory/memory.ts';
import type { ToolJob } from '../tools/executor.ts';
import { ACKNOWLEDGMENT_FIELD, ACKNOWLEDGMENT_TEXT, consentText, keepsText, noticesOf, NOT_OFFERED_TEXT } from './memory-actions-text.ts';

export const MEMORY_PLAN_ROUTE = '/api/memory/plan';
const MEMORY_ACTIONS_PREFIX = '/api/memory/actions/';
const ACTION_ROUTE = new RegExp(`^/api/memory/actions/(${MEMORY_ACTIONS.join('|')})$`);
const PLAN_DIGEST = /^[0-9a-f]{16}$/;
const MAX_BODY = 2048;
const READ_ERROR = 'não deu para ler a memória agora';
const BODY_KEYS: readonly string[] = ['planDigest', ACKNOWLEDGMENT_FIELD];

export type MemoryActionsRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export interface MemoryActionsRouteOptions {
  actions: MemoryActions;
}

export function isMemoryActionsRoute(pathname: string): boolean {
  return pathname === MEMORY_PLAN_ROUTE || pathname.startsWith(MEMORY_ACTIONS_PREFIX);
}

/** Every non-GET request under `/api/memory/actions/` is a memory write and goes through `memoryWriteAllowed` only (#740/AC-6). */
export function isMemoryWrite(req: Pick<IncomingMessage, 'method'>, pathname: string): boolean {
  return req.method !== 'GET' && pathname.startsWith(MEMORY_ACTIONS_PREFIX);
}

/** The strict same-origin gate of the memory writes: our Host, the exact raw path with POST, `Origin` exactly `http://<Host>`; no Origin is refused (#740/AC-6). */
export function memoryWriteAllowed(req: Pick<IncomingMessage, 'method' | 'url' | 'headers'>, port: number): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (req.method !== 'POST' || !ACTION_ROUTE.test(req.url ?? '')) return false;
  return req.headers.origin === `http://${host}`;
}

const isAction = (id: string): id is MemoryActionId => (MEMORY_ACTIONS as readonly string[]).includes(id);

function refuse(res: ServerResponse, status: number, reason: string, error: string, extra: Record<string, unknown> = {}): void {
  send(res, status, { error, reason, ...extra });
}

/** The plan as the screen reads it, field by field; the consent only for activate, the acknowledgment only where it is asked (#740). */
function planView(plan: MemoryActionPlan): Record<string, unknown> {
  return {
    actionId: plan.actionId,
    label: plan.label,
    steps: plan.steps.map((step) => ({ display: step.display, account: step.account })),
    timeoutSeconds: plan.timeoutSeconds,
    planDigest: plan.planDigest,
    ...(plan.actionId === 'activate'
      ? {
          accounts: plan.accounts.map((account) => ({ dir: account.dir, setup: account.setup })),
          service: plan.service,
          dataDir: plan.dataDir,
          consent: consentText(plan.dataDir),
        }
      : {}),
    ...(plan.actionId === 'delete-data' ? { deletes: plan.deletes, keeps: keepsText(plan.keeps), acknowledgment: { field: ACKNOWLEDGMENT_FIELD, text: ACKNOWLEDGMENT_TEXT } } : {}),
    notices: noticesOf(plan),
  };
}

function jobView(job: ToolJob): Record<string, unknown> {
  return {
    id: job.id,
    toolId: job.toolId,
    actionId: job.actionId,
    label: job.label,
    state: job.state,
    steps: job.steps,
    step: job.step,
    phase: job.phase,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    timeoutSeconds: job.timeoutSeconds,
  };
}

function unreadable(res: ServerResponse, reason: MemoryReadFailure): void {
  refuse(res, reason === 'unavailable' ? 503 : 502, reason, READ_ERROR);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', reject);
  });
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
  } catch {
    return null;
  }
}

/** The names in the query: only `action`, once; a `machine` is its own refusal (#740). */
function queryRefusal(res: ServerResponse, url: URL): boolean {
  const names = [...url.searchParams.keys()];
  if (names.includes('machine')) return refuse(res, 400, 'local-only', 'a memória é lida e mudada só nesta máquina'), true;
  if (names.some((name) => name !== 'action') || names.length > 1) return refuse(res, 400, 'invalid-query', 'parâmetros inválidos'), true;
  return false;
}

export function createMemoryActionsRoute({ actions }: MemoryActionsRouteOptions): MemoryActionsRoute {
  async function plan(res: ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get('action') ?? '';
    if (!isAction(id)) return send(res, 404, { error: 'ação desconhecida' });
    const result = await actions.plan(id);
    if (result.kind === 'not-offered') return refuse(res, 409, result.reason, NOT_OFFERED_TEXT[result.reason]);
    if (result.kind === 'unreadable') return unreadable(res, result.reason);
    send(res, 200, { plan: planView(result.plan) });
  }

  async function confirm(req: IncomingMessage, res: ServerResponse, id: MemoryActionId): Promise<void> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, { error: 'use application/json' });
    }
    const text = await readBody(req);
    if (text === null) return send(res, 413, { error: 'corpo grande demais' });
    const body = parseBody(text);
    if (body === null) return send(res, 400, { error: 'JSON inválido: envie um objeto' });
    if ('machine' in body) return refuse(res, 400, 'local-only', 'a memória é mudada só nesta máquina');
    const { planDigest } = body;
    const acknowledged = body[ACKNOWLEDGMENT_FIELD];
    if (Object.keys(body).some((key) => !BODY_KEYS.includes(key)) || typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest) || (acknowledged !== undefined && typeof acknowledged !== 'boolean')) {
      return refuse(res, 400, 'invalid-body', 'informe o planDigest do plano mostrado na tela');
    }
    const result = await actions.act(id, planDigest, acknowledged === true);
    switch (result.kind) {
      case 'not-offered':
        return refuse(res, 409, result.reason, NOT_OFFERED_TEXT[result.reason]);
      case 'unreadable':
        return unreadable(res, result.reason);
      case 'stale':
        return refuse(res, 409, 'stale-plan', 'o plano mudou desde que a tela o mostrou; confira o novo plano', { plan: planView(result.plan) });
      case 'acknowledgment-required':
        return refuse(res, 400, 'acknowledgment-required', 'confirme que entende que os dados apagados não podem ser recuperados', { plan: planView(result.plan) });
      case 'queued':
        return send(res, 202, { job: jobView(result.job) });
    }
  }

  return async (req, res, url) => {
    const path = url.pathname;
    if (path === MEMORY_PLAN_ROUTE) {
      req.resume();
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      return queryRefusal(res, url) ? undefined : plan(res, url);
    }
    const id = ACTION_ROUTE.exec(path)?.[1];
    if (id === undefined || !isAction(id)) {
      req.resume();
      return send(res, 404, { error: 'não encontrado' });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'use POST' });
    }
    return confirm(req, res, id);
  };
}
