// The Docker routes (#288, decision 0017), on the Tools executor's queue and the same strict gate.
//
// - `GET /api/docker?machine=<id>`: the screen's state (src/docker/service.ts `DockerView`, wrapped as
//   `{ status: 'ok', ...view }`). `machine` defaults to `local`. A remote id is read from the remote
//   núcleo through its tunnel port and re-projected (src/docker/remote.ts): `{ status: 'unreachable',
//   machine, reason }` when the tunnel does not answer, `{ status: 'unsupported', machine }` when the
//   remote núcleo has no Docker route (older). An id this núcleo does not know: 404.
// - `GET /api/docker/plan?machine=<id>&action=<actionId>&target=<id>`: the plan a dialog shows (the argv,
//   the timeout, the `planDigest`, what it touches), built from a fresh read. 404 unknown, 409
//   `{ error, reason }` when the action is not offered now.
// - `POST /api/docker/actions/<actionId>` `{ machine?, target?, planDigest }`: 202 `{ job }`; 404 unknown
//   machine, action or target; 409 `{ error, plan }` when the digest is not the plan's now (the new
//   plan) or `{ error, reason }` when not offered; 403 `{ error, plan }` for an admin plan (the Docker of
//   the system: shown to copy, never run). Nothing runs on any of these.
// - `DELETE /api/docker/jobs/<jobId>` `{ machine? }`: Cancel. 200 `{ job }`; 404; 409 `{ error, job }`.
// - A remote machine: the Mac forwards the same ids as a local request (no `Origin`) and the remote núcleo
//   builds and runs the command from its own catalog. That núcleo accepts a no-`Origin` write only when
//   its own `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1` says so; otherwise it answers 403 and the Mac
//   answers 403 `{ reason: 'remote-actions-disabled' }`, and the screen shows Copiar comando.
//
// Every non-GET request under `/api/docker` goes through `dockerWriteAllowed` INSTEAD of the server's
// usual gate: our Host (`127.0.0.1:<port>` or `localhost:<port>`), the exact raw path of one of the
// writes with its method, and `Origin` exactly `http://<Host>`. No Origin passes only for a núcleo that
// accepts remote actions. `Content-Type: application/json` is required (415) and the body is capped (413).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';
import type { RemoteWrite } from '../clouds/remote-connectors.ts';
import { DOCKER_ACTIONS, PLAN_DIGEST, STACK_NAME, type BlockedReason } from '../docker/catalog.ts';
import { sanitizeDockerView, sanitizeJob, sanitizePlan } from '../docker/remote.ts';
import type { DockerService } from '../docker/service.ts';
import { JOB_ID, type CancelJobResult } from '../tools/executor.ts';

export const DOCKER_ROUTE = '/api/docker';
export const DOCKER_PLAN_ROUTE = '/api/docker/plan';
const DOCKER_ACTION_ROUTE = /^\/api\/docker\/actions\/([a-z-]+)$/;
const DOCKER_JOB_ROUTE = /^\/api\/docker\/jobs\/([a-f0-9]{12})$/;
const MAX_BODY = 2048;
/** The target of an action: a Compose project, a 12-character id, a clean kind or a daemon kind. */
const TARGET = STACK_NAME;

const WRITES: [RegExp, string][] = [
  [new RegExp(`^/api/docker/actions/(?:${DOCKER_ACTIONS.join('|')})$`), 'POST'],
  [/^\/api\/docker\/jobs\/[a-f0-9]{12}$/, 'DELETE'],
];

export interface DockerRouteOptions {
  service: DockerService | null;
  cancel: (jobId: string) => CancelJobResult;
  /** Whether this núcleo takes a no-`Origin` write (the tunnel): `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`. */
  acceptNoOriginActions: () => boolean;
  remote?: { port: (machineId: string) => number | undefined; get: RemoteGet; write: RemoteWrite } | null;
}

export type DockerRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function isDockerRoute(pathname: string): boolean {
  return pathname === DOCKER_ROUTE || pathname.startsWith(`${DOCKER_ROUTE}/`);
}

/** Every non-GET request under `/api/docker` is a Docker write and goes through `dockerWriteAllowed` only. */
export function isDockerWrite(req: IncomingMessage, pathname: string): boolean {
  return req.method !== 'GET' && isDockerRoute(pathname);
}

export function dockerWriteAllowed(req: IncomingMessage, port: number, acceptNoOrigin = false): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const raw = req.url ?? '';
  if (!WRITES.some(([path, method]) => path.test(raw) && req.method === method)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return acceptNoOrigin;
  return origin === `http://${host}`;
}

const REASONS: Record<BlockedReason, string> = {
  admin: 'esta ação pede senha de administrador: o console não a roda; copie o comando e rode no Terminal',
  'stack-present': 'a stack ainda tem containers: remova a stack antes dos volumes',
  'nothing-to-do': 'não há nada a fazer agora; a tela vai mostrar o estado atual',
  'no-runtime': 'não há um Docker que o console possa reiniciar nesta máquina',
};

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
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const unknownMachine = (id: string) => ({ error: `máquina desconhecida: ${id}` });

export function createDockerRoute(o: DockerRouteOptions): DockerRoute {
  const remotePort = (id: string): number | undefined => (id !== LOCAL_MACHINE_ID ? o.remote?.port(id) : undefined);

  return async (req, res, url) => {
    const path = url.pathname;
    if (!o.service) {
      req.resume();
      return send(res, 404, { error: 'o núcleo subiu sem a tela Docker' });
    }

    if (req.method === 'GET') {
      req.resume();
      const machine = url.searchParams.get('machine') || LOCAL_MACHINE_ID;
      if (!MACHINE_ID.test(machine)) return send(res, 400, { error: 'machine inválida: letras minúsculas, números e hífen' });
      const port = remotePort(machine);
      if (machine !== LOCAL_MACHINE_ID && port === undefined) return send(res, 404, unknownMachine(machine));

      if (path === DOCKER_ROUTE) {
        if (port === undefined) {
          const view = await o.service.view(machine);
          return view ? send(res, 200, { status: 'ok', ...view }) : send(res, 404, unknownMachine(machine));
        }
        const r = await o.remote!.get(port, DOCKER_ROUTE);
        if (r.kind === 'unreachable') return send(res, 200, { status: 'unreachable', machine, reason: r.reason });
        const view = r.status === 200 ? sanitizeDockerView(r.body, machine) : null;
        return send(res, 200, view ? { ...view, status: 'ok' } : { status: 'unsupported', machine });
      }

      if (path === DOCKER_PLAN_ROUTE) {
        const action = url.searchParams.get('action') ?? '';
        const target = url.searchParams.get('target');
        if (!(DOCKER_ACTIONS as readonly string[]).includes(action) || (target !== null && !TARGET.test(target) && !/^[a-f0-9]{12}$/.test(target))) return send(res, 404, { error: 'ação desconhecida' });
        if (port === undefined) {
          const r = await o.service.plan(machine, action, target);
          if (r.kind === 'unknown') return send(res, 404, { error: 'alvo desconhecido: o Docker mudou desde que a tela leu' });
          if (r.kind === 'not-offered') return send(res, 409, { error: REASONS[r.reason], reason: r.reason });
          return send(res, 200, { plan: r.plan });
        }
        const q = `action=${action}${target === null ? '' : `&target=${target}`}`;
        const r = await o.remote!.get(port, `${DOCKER_PLAN_ROUTE}?${q}`);
        if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
        const body = (r.body ?? {}) as { plan?: unknown; reason?: unknown };
        const plan = sanitizePlan(body.plan);
        if (r.status === 200 && plan) return send(res, 200, { plan });
        const reason = typeof body.reason === 'string' && body.reason in REASONS ? (body.reason as BlockedReason) : null;
        if (r.status === 409 && reason) return send(res, 409, { error: REASONS[reason], reason });
        return send(res, r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'alvo desconhecido: o Docker mudou desde que a tela leu' : 'resposta inesperada da máquina' });
      }
      return send(res, 404, { error: 'não encontrado' });
    }

    // The writes: reached only after `dockerWriteAllowed`.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return send(res, 415, { error: 'use application/json' });
    }
    const text = await readBody(req);
    if (text === null) return send(res, 413, { error: 'corpo grande demais' });
    const body = parseBody(text);
    if (body === null) return send(res, 400, { error: 'JSON inválido: envie um objeto' });
    const machine = body.machine ?? LOCAL_MACHINE_ID;
    if (typeof machine !== 'string' || !MACHINE_ID.test(machine)) return send(res, 400, { error: 'machine inválida: letras minúsculas, números e hífen' });
    const port = remotePort(machine);
    if (machine !== LOCAL_MACHINE_ID && port === undefined) return send(res, 404, unknownMachine(machine));

    const job = DOCKER_JOB_ROUTE.exec(path);
    if (job) {
      const id = job[1]!;
      if (!JOB_ID.test(id)) return send(res, 404, { error: 'ação desconhecida' });
      if (port !== undefined) {
        const r = await o.remote!.write(port, 'DELETE', `/api/tools/jobs/${id}`, null);
        if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
        const j = sanitizeJob((r.body as { job?: unknown } | undefined)?.job);
        if (r.status === 403) return send(res, 403, { error: 'a máquina não aceita ações remotas', reason: 'remote-actions-disabled' });
        if (r.status === 200 && j) return send(res, 200, { job: j });
        if (r.status === 409 && j) return send(res, 409, { error: 'esta ação já terminou', job: j });
        return send(res, r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'ação desconhecida' : 'resposta inesperada da máquina' });
      }
      const r = o.cancel(id);
      if (r.kind === 'unknown') return send(res, 404, { error: 'ação desconhecida' });
      if (r.kind === 'ended') return send(res, 409, { error: 'esta ação já terminou', job: r.job });
      return send(res, 200, { job: r.job });
    }

    const action = DOCKER_ACTION_ROUTE.exec(path)?.[1];
    if (!action || !(DOCKER_ACTIONS as readonly string[]).includes(action)) return send(res, 404, { error: 'não encontrado' });
    if (typeof body.planDigest !== 'string' || !PLAN_DIGEST.test(body.planDigest)) return send(res, 400, { error: 'informe o planDigest do plano mostrado na tela' });
    const target = body.target === undefined || body.target === null ? null : body.target;
    if (target !== null && (typeof target !== 'string' || (!TARGET.test(target) && !/^[a-f0-9]{12}$/.test(target)))) return send(res, 400, { error: 'alvo inválido' });

    if (port !== undefined) {
      const forwarded = JSON.stringify({ target, planDigest: body.planDigest });
      const r = await o.remote!.write(port, 'POST', `${DOCKER_ROUTE}/actions/${action}`, forwarded);
      if (r.kind === 'unreachable') return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
      const answer = (r.body ?? {}) as { job?: unknown; plan?: unknown; reason?: unknown };
      if (r.status === 403 && answer.plan === undefined) return send(res, 403, { error: 'a máquina não aceita ações remotas: ligue AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1 lá, ou copie o comando', reason: 'remote-actions-disabled' });
      const j = sanitizeJob(answer.job);
      const plan = sanitizePlan(answer.plan);
      if (r.status === 202 && j) return send(res, 202, { job: j });
      if (r.status === 403 && plan) return send(res, 403, { error: REASONS.admin, plan });
      if (r.status === 409 && plan) return send(res, 409, { error: 'o plano mudou desde que a tela o mostrou; confira o novo plano', plan });
      const reason = typeof answer.reason === 'string' && answer.reason in REASONS ? (answer.reason as BlockedReason) : null;
      if (r.status === 409 && reason) return send(res, 409, { error: REASONS[reason], reason });
      return send(res, r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'alvo desconhecido: o Docker mudou desde que a tela leu' : 'resposta inesperada da máquina' });
    }

    const r = await o.service.act(machine, action, target, body.planDigest);
    switch (r.kind) {
      case 'unknown':
        return send(res, 404, { error: 'alvo desconhecido: o Docker mudou desde que a tela leu' });
      case 'not-offered':
        return send(res, 409, { error: REASONS[r.reason], reason: r.reason });
      case 'stale':
        return send(res, 409, { error: 'o plano mudou desde que a tela o mostrou; confira o novo plano', plan: r.plan });
      case 'blocked':
        return send(res, r.plan.blockedReason === 'admin' ? 403 : 409, { error: REASONS[r.plan.blockedReason ?? 'admin'], plan: r.plan });
      case 'queued':
        return send(res, 202, { job: r.job });
    }
  };
}
