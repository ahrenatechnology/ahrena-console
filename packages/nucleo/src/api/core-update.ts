// The Update button's routes (issue 462, decision 0022 section 6), a closed list of three, all behind the server's
// Origin and Host defenses (decision 0003) and, stricter than the other machine writes, WITHOUT the no-Origin
// loopback path: a request with no `Origin` (the tray, a local process) gets 403, because stopping and swapping
// a remote núcleo is the /ui's click and nothing else.
//
// - `POST /api/machines/<id>/update/check`: runs the `--check`. 202 `{ update }`.
// - `POST /api/machines/<id>/update`: updates. 202 `{ update }` (also the state of the one that already runs).
//   409 `check-required` without a good check of the last 5 minutes.
// - `DELETE /api/machines/<id>/update`: Cancel, only in the check phase. 200 `{ update }`; 409 `not-cancelable`
//   or `not-running`.
// - 404 `{ error, reason: 'unknown' }` for an id that is not a remote machine; 409 `{ error, reason }` when the
//   machine cannot update (`not-configured`, `invalid`, `invalid-file`, `invalid-version`).
// - The body and the query are never read; the raw path must be exact (no query, no encoding): the same-origin
//   exception below accepts nothing else. Only the id of the path reaches the updater, which looks it up in the
//   freshest machines.json.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { CoreUpdater, UpdateRefusal, UpdateResult } from '../telemetry/core-update.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import { fromOwnUi } from './same-origin.ts';

const CHECK_ROUTE = /^\/api\/machines\/([^/]+)\/update\/check$/;
const UPDATE_ROUTE = /^\/api\/machines\/([^/]+)\/update$/;
const CHECK_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/update\/check$/;
const UPDATE_RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/update$/;

export type CoreUpdateRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function isCoreUpdateRoute(pathname: string): boolean {
  return CHECK_ROUTE.test(pathname) || UPDATE_ROUTE.test(pathname);
}

/** The /ui's Atualizar: `POST` check and update, `DELETE` update; the exact raw path, `Origin` equal to `http://<Host>`, our Host. */
export function coreUpdateWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  const raw = req.url ?? '';
  if (req.method === 'POST' && (CHECK_RAW_PATH.test(raw) || UPDATE_RAW_PATH.test(raw))) return fromOwnUi(req, port);
  if (req.method === 'DELETE' && UPDATE_RAW_PATH.test(raw)) return fromOwnUi(req, port);
  return false;
}

/** The screen-side words of each refusal (pt-BR); the `reason` is what the screen branches on. */
export const UPDATE_REFUSALS: Record<UpdateRefusal, { status: number; error: string }> = {
  'invalid-file': { status: 409, error: 'O machines.json está inválido; corrija o arquivo para atualizar o núcleo.' },
  'not-configured': { status: 409, error: 'esta máquina não tem o botão Atualizar: adicione "connection.update" a ela no machines.json' },
  invalid: { status: 409, error: 'O connection.update do machines.json está inválido; corrija o arquivo.' },
  'invalid-version': { status: 409, error: 'esta versão do app não é um release publicado; não há o que instalar na máquina' },
  'check-required': { status: 409, error: 'faça a conferência (--check) antes de atualizar; ela vale por 5 minutos' },
  'not-cancelable': { status: 409, error: 'só dá para cancelar durante a conferência; a atualização segue sozinha até o fim' },
  'not-running': { status: 409, error: 'nada da atualização está em andamento nesta máquina' },
};

function answer(res: ServerResponse, r: UpdateResult, ok: number): void {
  if (r.kind === 'refused') {
    const refusal = UPDATE_REFUSALS[r.reason];
    return send(res, refusal.status, { error: refusal.error, reason: r.reason });
  }
  if (r.kind === 'unknown') return send(res, 404, { error: 'máquina desconhecida', reason: 'unknown' });
  send(res, ok, { update: r.update });
}

export function createCoreUpdateRoute(updater: CoreUpdater | null): CoreUpdateRoute {
  return async (req, res, url) => {
    // The body is never read; drained so the connection stays usable.
    req.resume();
    const check = CHECK_ROUTE.exec(url.pathname);
    const update = check ? null : UPDATE_ROUTE.exec(url.pathname);
    const rawId = check?.[1] ?? update?.[1] ?? '';
    if (check && req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    if (update && req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { error: 'use POST ou DELETE' });
    // No loopback-without-Origin path here (see the head of this file); the server's gate already refused a wrong Origin.
    if (typeof req.headers.origin !== 'string') return send(res, 403, { error: 'origem não permitida' });
    const unknown = { error: `máquina desconhecida: ${MACHINE_ID.test(rawId) ? rawId : '(id inválido)'}`, reason: 'unknown' };
    if (!MACHINE_ID.test(rawId) || rawId === LOCAL_MACHINE_ID || !updater) return send(res, 404, unknown);
    if (check) return answer(res, await updater.check(rawId), 202);
    if (req.method === 'DELETE') return answer(res, await updater.cancel(rawId), 200);
    answer(res, await updater.update(rawId), 202);
  };
}
