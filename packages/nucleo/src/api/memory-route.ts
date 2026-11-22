/*
 * The read routes of the embedded ai-memory (#735, #719): the server's state, the open handoffs and the recent pages of a project, and one session's capture.
 *
 * - `GET /api/memory`: the state, the bind, the auth posture, the LLM and embeddings status, the counts and the alerts (api/memory-view.ts).
 * - `GET /api/memory/handoffs?project=<p>`: the project's open handoffs, with no body. Read through the mcp-bridge, only after `status` confirms 127.0.0.1.
 * - `GET /api/memory/pages?project=<p>`: the project's recent pages, with no snippet. Read with the CLI.
 * - `GET /api/memory/sessions/<id>?project=<p>`: whether the session was captured and the handoffs it opened. Through the bridge, with the same bind check.
 *
 * Read only. The routes are local: they are not in the remote credential's closed list (api/owner-auth.ts), and `machine` is refused, so a remote
 * request never reaches them (#735/D3). Every answer is built from named fields; a failure answers our text and a closed reason, never a detail of
 * the process (decision 0026).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { MemoryModule } from '../memory/memory.ts';
import { SESSION_FORMAT } from '../memory/memory.ts';
import { PROJECT_FORMAT } from '../memory/runner.ts';
import { bindAlert, handoffView, isLoopbackBind, pageView, serverView } from './memory-view.ts';

export const MEMORY_ROUTE = '/api/memory';
export const MEMORY_HANDOFFS_ROUTE = '/api/memory/handoffs';
export const MEMORY_PAGES_ROUTE = '/api/memory/pages';
const MEMORY_SESSION_ROUTE = /^\/api\/memory\/sessions\/([^/]+)$/;

/** What the routes read from the memory module (#735). */
export type MemoryReads = Pick<MemoryModule, 'status' | 'statusWithLocal' | 'recent' | 'bridgeHandoffsWithLocal' | 'sessionHandoffsWithLocal' | 'sessionCaptured'>;

export interface MemoryRouteOptions {
  memory: MemoryReads;
}

export type MemoryRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function isMemoryRoute(pathname: string): boolean {
  return pathname === MEMORY_ROUTE || pathname.startsWith(`${MEMORY_ROUTE}/`);
}

const NO_MEMORY = { error: 'o núcleo subiu sem a memória' };
const READ_ERROR = 'não deu para ler a memória agora';

/** The answer a route gives when no memory module is wired (`--demo`) (#735). */
export function respondNoMemory(res: ServerResponse): void {
  send(res, 404, NO_MEMORY);
}

function refuse(res: ServerResponse, status: number, reason: string, error: string, extra: Record<string, unknown> = {}): void {
  send(res, status, { error, reason, ...extra });
}

/** The one value of a query parameter, or null when it is missing, repeated or empty (#735). */
function single(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== '' ? values[0]! : null;
}

/** Checks the names in the query: only `allowed`, each at most once; a `machine` is its own refusal (#735/D3). */
function queryRefusal(res: ServerResponse, url: URL, allowed: readonly string[]): boolean {
  const names = [...url.searchParams.keys()];
  if (names.includes('machine')) {
    refuse(res, 400, 'local-only', 'a memória é lida só desta máquina');
    return true;
  }
  if (names.some((name) => !allowed.includes(name)) || new Set(names).size !== names.length) {
    refuse(res, 400, 'invalid-query', 'parâmetros inválidos');
    return true;
  }
  return false;
}

function projectOf(res: ServerResponse, url: URL): string | null {
  const project = single(url, 'project');
  if (project !== null && PROJECT_FORMAT.test(project)) return project;
  refuse(res, 400, 'invalid-project', 'projeto inválido: use letras, números, ponto, hífen e sublinhado');
  return null;
}

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A failed read: 503 when there is no binary, 502 otherwise, with the closed reason and no detail (#735). */
function readFailed(res: ServerResponse, reason: string): void {
  refuse(res, reason === 'unavailable' ? 503 : 502, reason, READ_ERROR);
}

export function createMemoryRoute({ memory }: MemoryRouteOptions): MemoryRoute {
  /** The bridge is called only after `status` confirms the bind 127.0.0.1; otherwise the route refuses and the bridge stays untouched (#735/D1, #719/AC-6). */
  async function bridgeAllowed(res: ServerResponse): Promise<boolean> {
    const read = await memory.status();
    if (read.state !== 'running' || !read.status) {
      refuse(res, 503, 'not-running', 'a memória não está rodando');
      return false;
    }
    if (!isLoopbackBind(read.status.bind)) {
      const alert = bindAlert();
      refuse(res, 409, 'bind-not-loopback', alert.text, { alert });
      return false;
    }
    return true;
  }

  async function state(res: ServerResponse): Promise<void> {
    send(res, 200, serverView(await memory.statusWithLocal()));
  }

  async function handoffs(res: ServerResponse, project: string): Promise<void> {
    if (!(await bridgeAllowed(res))) return;
    const read = await memory.bridgeHandoffsWithLocal(project);
    if (!read.ok) return readFailed(res, read.reason);
    const { handoffs: list, local } = read.value;
    send(res, 200, { project, handoffs: list.map((handoff) => handoffView(handoff, local.find((item) => item.id === handoff.id))) });
  }

  async function pages(res: ServerResponse, project: string): Promise<void> {
    const read = await memory.recent(project);
    if (!read.ok) return readFailed(res, read.reason);
    send(res, 200, { project, pages: read.value.map(pageView) });
  }

  async function session(res: ServerResponse, project: string, sessionId: string): Promise<void> {
    if (!(await bridgeAllowed(res))) return;
    const captured = await memory.sessionCaptured(project, sessionId);
    if (!captured.ok) return readFailed(res, captured.reason);
    const opened = await memory.sessionHandoffsWithLocal(project, sessionId);
    if (!opened.ok) return readFailed(res, opened.reason);
    const { opened: list, local } = opened.value;
    send(res, 200, { project, session_id: sessionId, captured: captured.value, opened: list.map((handoff) => handoffView(handoff, local.find((item) => item.id === handoff.id))) });
  }

  return async (req, res, url) => {
    req.resume();
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    const path = url.pathname;
    if (path === MEMORY_ROUTE) return queryRefusal(res, url, []) ? undefined : state(res);
    if (path === MEMORY_HANDOFFS_ROUTE || path === MEMORY_PAGES_ROUTE) {
      if (queryRefusal(res, url, ['project'])) return;
      const project = projectOf(res, url);
      if (project === null) return;
      return path === MEMORY_HANDOFFS_ROUTE ? handoffs(res, project) : pages(res, project);
    }
    const sessionMatch = MEMORY_SESSION_ROUTE.exec(path);
    if (sessionMatch) {
      if (queryRefusal(res, url, ['project'])) return;
      const sessionId = decoded(sessionMatch[1]!);
      if (sessionId === null || !SESSION_FORMAT.test(sessionId)) return refuse(res, 400, 'invalid-session-id', 'id de sessão inválido');
      const project = projectOf(res, url);
      if (project === null) return;
      return session(res, project, sessionId);
    }
    send(res, 404, { error: 'não encontrado' });
  };
}
