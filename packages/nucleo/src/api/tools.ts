// The Tools routes (#280, decision 0014).
//
// The read, behind the server's Origin and Host defenses (decision 0003) like the other reads:
//
// - `GET /api/tools?machine=<id>`: the screen's whole state (src/tools/service.ts, `ToolsOverview`,
//   with `jobs` from the executor). `machine` defaults to `local`; an invalid id gives 400; a machine
//   this núcleo does not serve, 404 (the Workstation through the tunnel is layer 4).
// - Without the service wired in (the --demo núcleo): 404.
//
// The writes (layer 2), the executor's (src/tools/executor.ts):
//
// - `POST /api/tools/<toolId>/actions/<actionId>` `{ planDigest, machine }`: 202 `{ job }`; 404 for an
//   unknown machine, tool or action; 409 `{ error, plan }` when the digest is not the plan's now (the
//   new plan) or the action is not offered now (`plan: null`); 403 `{ error, plan }` for an admin plan
//   and 409 for another reason it is not runnable (invalid version, offline, no manager). Nothing runs
//   on any of these.
// - `DELETE /api/tools/jobs/<jobId>`: Cancel. 200 `{ job }` (`canceled`); 404 unknown; 409 `{ error,
//   job }` when it already ended (or is only verifying).
// - `POST /api/tools/checks` `{ machine }`: Verificar agora. 200 with the body when the check ended
//   within the wait, 202 with the current body otherwise (a `tools` change follows when it ends).
// - `POST /api/tools/mcp/checks`: reserved for layer 3 (the same gate already covers it).
//
// Every non-GET request under `/api/tools` goes through `toolsWriteAllowed` INSTEAD of the server's
// usual gate: `Origin` exactly `http://<Host>`, Host `127.0.0.1:<port>` or `localhost:<port>`, the
// exact raw path (no query, no encoding) of one of the routes above with its method. A request with
// NO Origin gets 403 (stricter than decision 0012's reconnect), unless the executor's
// `acceptNoOriginActions()` says so (layer 4, `tools.acceptRemoteActions`). `Origin: null` or any
// other Origin: 403. Then `Content-Type: application/json` is required (415) on all of them, and the
// body is capped (413).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import { JOB_ID, type ToolsControl } from '../tools/executor.ts';

export const TOOLS_ROUTE = '/api/tools';
export const TOOLS_ACTION_ROUTE = /^\/api\/tools\/([^/]+)\/actions\/([^/]+)$/;
export const TOOLS_JOB_ROUTE = /^\/api\/tools\/jobs\/([^/]+)$/;
export const TOOLS_CHECKS_ROUTE = '/api/tools/checks';
/** Layer 3's Verificar conexões (`claude mcp list`); the gate already knows it. */
export const TOOLS_MCP_CHECKS_ROUTE = '/api/tools/mcp/checks';

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLAN_DIGEST = /^[0-9a-f]{16}$/;
const MAX_BODY = 4096;

/** The exact raw paths and methods of the writes. */
const WRITES: [RegExp, string][] = [
  [/^\/api\/tools\/[a-z0-9][a-z0-9-]{0,63}\/actions\/(?:install|update|start|stop)$/, 'POST'],
  [/^\/api\/tools\/jobs\/[a-f0-9]{12}$/, 'DELETE'],
  [/^\/api\/tools\/checks$/, 'POST'],
  [/^\/api\/tools\/mcp\/checks$/, 'POST'],
];

export function isToolsRoute(pathname: string): boolean {
  return pathname === TOOLS_ROUTE;
}

/** Every non-GET request under `/api/tools` is a Tools write and goes through `toolsWriteAllowed` only. */
export function isToolsWrite(req: IncomingMessage, pathname: string): boolean {
  return req.method !== 'GET' && (pathname === TOOLS_ROUTE || pathname.startsWith(`${TOOLS_ROUTE}/`));
}

/**
 * The strict same-origin gate of the Tools writes: our Host, the exact raw path with its method, and
 * `Origin` exactly `http://<Host>`. No Origin passes only when `acceptNoOrigin` (layer 4's hook).
 */
export function toolsWriteAllowed(req: IncomingMessage, port: number, acceptNoOrigin = false): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const raw = req.url ?? '';
  if (!WRITES.some(([path, method]) => path.test(raw) && req.method === method)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return acceptNoOrigin;
  return origin === `http://${host}`;
}

export async function respondTools(res: ServerResponse, url: URL, tools: Pick<ToolsControl, 'overview'> | null | undefined): Promise<void> {
  if (!tools) return send(res, 404, NO_TOOLS);
  const machine = url.searchParams.get('machine') || LOCAL_MACHINE_ID;
  if (!MACHINE_ID.test(machine)) return send(res, 400, { error: INVALID_MACHINE });
  const body = await tools.overview(machine);
  if (!body) return send(res, 404, { error: `máquina desconhecida: ${machine}` });
  send(res, 200, body);
}

/** A Tools write, reached only after `toolsWriteAllowed`. */
export async function respondToolsWrite(req: IncomingMessage, res: ServerResponse, url: URL, tools: ToolsControl | null | undefined): Promise<void> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    return send(res, 415, { error: 'use application/json' });
  }
  const text = await readBody(req);
  if (text === null) return send(res, 413, { error: 'corpo grande demais' });
  if (!tools) return send(res, 404, NO_TOOLS);

  const job = TOOLS_JOB_ROUTE.exec(url.pathname);
  if (job) {
    if (!tools.cancel || !JOB_ID.test(job[1]!)) return send(res, 404, UNKNOWN_JOB);
    const r = tools.cancel(job[1]!);
    if (r.kind === 'unknown') return send(res, 404, UNKNOWN_JOB);
    if (r.kind === 'ended') return send(res, 409, { error: 'esta ação já terminou', job: r.job });
    return send(res, 200, { job: r.job });
  }

  const body = parseBody(text);
  if (body === null) return send(res, 400, { error: 'JSON inválido: envie um objeto' });
  const machine = body.machine ?? LOCAL_MACHINE_ID;
  if (typeof machine !== 'string' || !MACHINE_ID.test(machine)) return send(res, 400, { error: INVALID_MACHINE });

  if (url.pathname === TOOLS_CHECKS_ROUTE) {
    if (!tools.checkNow) return send(res, 404, NO_TOOLS);
    const r = await tools.checkNow(machine);
    if (r.kind === 'unknown-machine') return send(res, 404, { error: `máquina desconhecida: ${machine}` });
    return send(res, r.kind === 'done' ? 200 : 202, r.body);
  }

  const action = TOOLS_ACTION_ROUTE.exec(url.pathname);
  if (action && tools.act) {
    const [, toolId, actionId] = action as unknown as [string, string, string];
    if (!TOOL_ID.test(toolId)) return send(res, 404, { error: 'ferramenta desconhecida' });
    if (typeof body.planDigest !== 'string' || !PLAN_DIGEST.test(body.planDigest)) return send(res, 400, { error: 'informe o planDigest do plano mostrado na tela' });
    const r = await tools.act(machine, toolId, actionId, body.planDigest);
    switch (r.kind) {
      case 'unknown-machine':
        return send(res, 404, { error: `máquina desconhecida: ${machine}` });
      case 'unknown':
        return send(res, 404, { error: `ação desconhecida: ${toolId} ${actionId}` });
      case 'not-offered':
        return send(res, 409, { error: 'esta ação não está disponível agora; a tela vai mostrar o estado atual', plan: null });
      case 'stale':
        return send(res, 409, { error: 'o plano mudou desde que a tela o mostrou; confira o novo plano', plan: r.plan });
      case 'blocked':
        return send(res, r.plan.blockedReason === 'admin' ? 403 : 409, { error: BLOCKED[r.plan.blockedReason ?? 'admin'] ?? BLOCKED.admin, plan: r.plan });
      case 'queued':
        return send(res, 202, { job: r.job });
    }
  }
  // Layer 3's `POST /api/tools/mcp/checks`, and the writes of a núcleo without the executor.
  send(res, 404, { error: 'não encontrado' });
}

const NO_TOOLS = { error: 'o núcleo subiu sem a tela Ferramentas' };
const INVALID_MACHINE = 'machine inválida: letras minúsculas, números e hífen';
const UNKNOWN_JOB = { error: 'ação desconhecida' };
const BLOCKED: Record<string, string> = {
  admin: 'esta ação pede senha de administrador: o console não a roda; copie o comando e rode no Terminal',
  'invalid-version': 'não há uma versão válida para esta ação; rode Verificar agora',
  offline: 'sem rede: a ação fica para quando a máquina estiver online',
  'no-manager': 'o gerenciador desta ação não está instalado nesta máquina',
  'remote-read-only': 'esta máquina não aceita ações remotas',
};

function parseBody(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The request body, or `null` past `MAX_BODY`. */
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
