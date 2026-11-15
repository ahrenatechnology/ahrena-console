/*
 * "Delegar ao Claude" (#567, epic #563): hand an open saturation alert to a new Claude session. The use cases
 * are src/delegation (preview, then open); this file is the HTTP edge. The contract is docs/contracts/core-api.openapi.json (#662).
 *
 * | Operation                                                  | Answer                                                              |
 * | ---------------------------------------------------------- | ------------------------------------------------------------------- |
 * | `GET /api/delegations/preview?machine=&alert=`             | 200 `{ prompt, size, truncated, takenAt }`                          |
 * | `POST /api/delegations` `{ machine, alertId, via, takenAt }` | 200 `{ ok: true, opened: via }`                                     |
 *
 * | Status | When                                                                                                         |
 * | ------ | ------------------------------------------------------------------------------------------------------------ |
 * | 400    | a bad query or body field; a `via` the machine does not take (`desktop`/`terminal` for `local`, `ssh` for the others) |
 * | 403    | a query on the POST                                                                                          |
 * | 404    | `{ error, reason }`, `reason` `unknown-machine` or `alert-not-open`                                          |
 * | 405    | another method                                                                                               |
 * | 409    | `{ error, reason: 'diagnosis-changed' }`: the `takenAt` is not the one of the last preview held (none, expired, replaced) |
 * | 413 / 415 | the body is too large / is not `application/json`                                                         |
 * | 422    | `{ error, reason: 'too-large' }`: the stored prompt no longer fits the Desktop address                       |
 * | 501    | `{ error }`: no way to open here (no Desktop, no terminal, not macOS); `{ error: 'delegation-unsupported' }` when the route is not wired |
 * | 502    | `{ error, reason }`: `ssh-unreachable` or `ssh-timeout` (the pre-flight), or `open-failed` (the launcher threw) |
 *
 * - The mould is work-plan.ts: 405, a query 403, `Content-Type: application/json` 415, 400 and 413 for the body,
 *   pt-BR `error` texts the screen shows. server.ts lets only the /ui in (`sameOriginDelegations`).
 * - #567 What a caller receives is the `error` (pt-BR) and a stable `reason` code, never a dependency's own text: the
 *   ssh stderr, a thrown error's message and the prompt stay out of every answer and every log line. The log says
 *   the machine, the via and, on a failure, the reason code or the error's name.
 * - #567 The 501 body is `error` only, with no `command`: the screen already holds the prompt from the preview and
 *   offers "Copiar o prompt" (D8), so the answer never carries it again.
 * - #567 Nothing here runs the prompt, kills a process or deletes data.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { delegate, previewDelegation, type DelegateRequest, type DelegateResult, type DelegationDeps, type SshFailure } from '../delegation/delegate.ts';
import { isVia, VIAS, type Via } from '../delegation/model.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import { readJsonBody } from './connections-route.ts';
import { isAlertIdParam, readDiagnosisQuery, type DiagnosisReader } from './diagnosis.ts';

export const DELEGATIONS_ROUTE = '/api/delegations';
export const DELEGATIONS_PREVIEW_ROUTE = '/api/delegations/preview';

const UNSUPPORTED = { error: 'delegation-unsupported' };
const TAKEN_AT_MAX = 64;

export type DelegationsRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** A núcleo with no delegation wired answers both routes with this stable 501. */
export function respondDelegationsUnsupported(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  send(res, 501, UNSUPPORTED);
}

/** The delegation's diagnosis port over the diagnosis reader: a failure or a not-diagnosable alert is `unavailable` (#567). */
export function delegationDiagnosis(read: DiagnosisReader): DelegationDeps['diagnosis'] {
  return async (machine, alertId) => {
    const r = await read(machine, alertId);
    if (r.kind === 'ok' || r.kind === 'unknown-machine' || r.kind === 'alert-not-open') return r;
    return { kind: 'unavailable' };
  };
}

const unknownMachine = (res: ServerResponse, machine: string) => send(res, 404, { error: `máquina desconhecida: ${machine}`, reason: 'unknown-machine' });
const alertNotOpen = (res: ServerResponse) => send(res, 404, { error: 'o alerta não está aberto nesta máquina', reason: 'alert-not-open' });

const VIA_NOT_ACCEPTED = {
  local: 'Esta máquina abre pelo Claude Desktop ou pelo terminal: use via desktop ou terminal',
  remote: 'Esta máquina só abre por uma sessão SSH: use via ssh',
};
const SSH_FAILED: Record<SshFailure, string> = {
  'ssh-unreachable': 'Não deu para chegar na Workstation por SSH; copie o prompt',
  'ssh-timeout': 'A Workstation não respondeu por SSH a tempo; copie o prompt',
};
const UNSUPPORTED_VIA: Record<Via, string> = {
  desktop: 'Abrir no Claude Desktop só no macOS, com o Claude Desktop; copie o prompt',
  terminal: 'Não há um terminal que o console saiba abrir aqui; copie o prompt',
  ssh: 'Não há um terminal que o console saiba abrir aqui; copie o prompt',
};

/** #567 The body of the POST, checked field by field; the error message of the first one that is wrong. */
function readBody(value: unknown): DelegateRequest | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'pedido inválido';
  const { machine, alertId, via, takenAt } = value as Record<string, unknown>;
  if (typeof machine !== 'string' || !MACHINE_ID.test(machine)) return 'machine inválida: informe com letras minúsculas, números e hífen';
  if (!isAlertIdParam(alertId)) return 'alertId inválido: informe o id de um alerta aberto';
  if (typeof takenAt !== 'string' || takenAt.length > TAKEN_AT_MAX || Number.isNaN(Date.parse(takenAt))) return 'takenAt inválido: informe o instante da prévia mostrada';
  if (!isVia(via)) return `via inválida: use ${VIAS.join(', ')}`;
  return { machine, alertId, via, takenAt };
}

export function createDelegationsRoute(deps: DelegationDeps, log: (message: string) => void = () => {}): DelegationsRoute {
  async function preview(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    req.resume();
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    const query = readDiagnosisQuery(url.searchParams);
    if (typeof query === 'string') return send(res, 400, { error: query });
    const r = await previewDelegation(query, deps);
    if (r.kind === 'unknown-machine') return unknownMachine(res, query.machine);
    if (r.kind === 'alert-not-open') return alertNotOpen(res);
    return send(res, 200, { prompt: r.prompt, size: r.size, truncated: r.truncated, takenAt: r.takenAt });
  }

  function answer(res: ServerResponse, request: DelegateRequest, result: DelegateResult): void {
    const label = `${request.machine} via ${request.via}`;
    switch (result.kind) {
      case 'opened':
        log(`delegation: ${label} opened for ${request.alertId}`);
        return send(res, 200, { ok: true, opened: result.via });
      case 'unknown-machine':
        return unknownMachine(res, request.machine);
      case 'alert-not-open':
        return alertNotOpen(res);
      case 'via-not-accepted':
        return send(res, 400, { error: request.machine === LOCAL_MACHINE_ID ? VIA_NOT_ACCEPTED.local : VIA_NOT_ACCEPTED.remote });
      case 'stale':
        return send(res, 409, { error: 'O diagnóstico mudou desde a prévia; veja a prévia de novo antes de abrir', reason: 'diagnosis-changed' });
      case 'too-large':
        return send(res, 422, { error: 'O prompt não cabe no endereço do Claude Desktop; abra pelo terminal ou copie o prompt', reason: 'too-large' });
      case 'unsupported':
        return send(res, 501, { error: UNSUPPORTED_VIA[request.via] });
      case 'ssh-failed':
        log(`delegation: ${label} failed: ${result.reason}`);
        return send(res, 502, { error: SSH_FAILED[result.reason], reason: result.reason });
    }
  }

  async function open(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const body = await readJsonBody(req);
    if (!body.ok) return send(res, body.error === 'too-large' ? 413 : 400, { error: 'pedido inválido' });
    const request = readBody(body.value ?? {});
    if (typeof request === 'string') return send(res, 400, { error: request });
    try {
      return answer(res, request, await delegate(request, deps));
    } catch (err) {
      log(`delegation: ${request.machine} via ${request.via} failed to open (${err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err})`);
      return send(res, 502, { error: 'Não deu para abrir a sessão; copie o prompt', reason: 'open-failed' });
    }
  }

  return (req, res, url) => (url.pathname === DELEGATIONS_PREVIEW_ROUTE ? preview(req, res, url) : open(req, res));
}
