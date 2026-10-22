// `POST /api/sessions/<id>/open` (#285): the console's "Abrir no Claude Desktop", "Abrir no terminal"
// and "Ir para o terminal". The núcleo looks the session up in its own store and decides the target
// itself (session-open.ts); the request names only the session, and its body is never read for anything.
//
// | Target          | What happens                                                    | Answer                              |
// | --------------- | --------------------------------------------------------------- | ----------------------------------- |
// | `desktop`       | `claude://claude.ai/epitaxy/<local_…>` through `openInDesktop`  | 200 `{ ok, opened: 'desktop' }`     |
// | `terminal`      | a terminal resuming it (terminal-launch.ts)                     | 200 `{ ok, opened: 'terminal' }`    |
// | `terminal-live` | the terminal tab where it runs, brought forward (macOS)         | 200 `{ ok, opened: 'focused' }`     |
// |                 | its pid is gone or is another process now (stale): resumes it   | 200 `{ ok, opened: 'terminal' }`    |
// |                 | as `terminal` does; a tab not found answers 409, never resumes  |                                     |
// | `remote`        | nothing: it runs on another machine                             | 422 `{ error }`                     |
// | `none`          | nothing: no folder to open it in                                | 422 `{ error }`                     |
//
// Without the launcher (another platform, the demo) or when it finds nothing: 501 (open) or 409 (focus),
// with `command`, the resume line the screen offers to copy. The folder of a `terminal` must still be
// an absolute folder that exists (422 otherwise). Same-origin only (decision 0003): server.ts lets the
// /ui in only with `Origin` exactly `http://<Host>` and the exact raw path, the UUID and no query; here,
// `Content-Type: application/json` (415) and the UUID again (400). The `error` texts are pt-BR: the
// screen shows them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { send } from '../ingest/hooks/receiver.ts';
import type { StoragePort } from '../storage-port.ts';
import { isUsableCwd, resumeCommand, SESSION_ID_PATTERN, type SessionOpenDescriber } from './session-open.ts';
import type { TerminalFocuser, TerminalOpener } from './terminal-launch.ts';

export const SESSION_OPEN_ROUTE = /^\/api\/sessions\/([^/]+)\/open$/;
/** The raw URL the /ui posts: the UUID and nothing else (decision 0003). */
export const SESSION_OPEN_FROM_UI = /^\/api\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/open$/i;

export type OpenedAs = 'desktop' | 'terminal' | 'focused';

export interface SessionOpenRouteOptions {
  storage: Pick<StoragePort, 'getSession'>;
  /** The Claude Desktop's `local_…` of a session, its index already refreshed; `null` when it does not know it. */
  localOf: (sessionId: string) => Promise<string | null> | string | null;
  describer: SessionOpenDescriber;
  /** Opens a `claude://` address (macOS `open`); without it, a Desktop session gets 501. */
  openInDesktop?: ((url: string) => Promise<void>) | null;
  openTerminal?: TerminalOpener | null;
  focusTerminal?: TerminalFocuser | null;
  /** The session is one a remote machine reported (#176): it is not opened here. */
  isRemote?: (sessionId: string) => boolean;
  isDirectory?: (path: string) => Promise<boolean>;
  log?: (message: string) => void;
}

async function isDirectoryOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type SessionOpenRoute = (req: IncomingMessage, res: ServerResponse, rawId: string) => Promise<void>;

export function createSessionOpenRoute(o: SessionOpenRouteOptions): SessionOpenRoute {
  const log = o.log ?? (() => {});
  const isDirectory = o.isDirectory ?? isDirectoryOnDisk;

  return async (req, res, rawId) => {
    req.resume();
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    if ((req.url ?? '').includes('?')) return send(res, 403, { error: 'origem não permitida' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    if (!SESSION_ID_PATTERN.test(rawId)) return send(res, 400, { error: 'id de sessão inválido' });
    const sessionId = rawId;

    const session = await o.storage.getSession(sessionId);
    if (!session) {
      if (o.isRemote?.(sessionId)) return send(res, 422, { error: 'A sessão roda em outra máquina' });
      return send(res, 404, { error: 'o núcleo não conhece esta sessão' });
    }
    await o.describer.refresh();
    const local = await o.localOf(sessionId);
    const proc = o.describer.liveProcess(sessionId);
    const cwd = session.cwd ?? proc?.cwd ?? null;
    const open = o.describer.describe({ sessionId, cwd, local });
    const command = resumeCommand(cwd, sessionId);

    async function resume() {
      if (!isUsableCwd(cwd) || !(await isDirectory(cwd))) return send(res, 422, { error: 'A pasta da sessão não existe mais', command });
      const result = o.openTerminal ? await o.openTerminal({ sessionId, cwd }) : 'unsupported';
      if (result === 'unsupported') return send(res, 501, { error: 'Não há um terminal que o console saiba abrir aqui; copie o comando', command });
      log(`session ${sessionId} opened in a terminal`);
      return send(res, 200, { ok: true, opened: 'terminal' satisfies OpenedAs });
    }

    try {
      switch (open.target) {
        case 'remote':
          return send(res, 422, { error: 'A sessão roda em outra máquina' });
        case 'none':
          return send(res, 422, { error: 'Esta sessão não tem uma pasta onde abrir' });
        case 'desktop': {
          if (!o.openInDesktop) return send(res, 501, { error: 'Abrir no Claude Desktop só no macOS, com o Claude Desktop', command });
          await o.openInDesktop(`claude://claude.ai/epitaxy/${local}`);
          log(`session ${sessionId} opened in the Claude Desktop`);
          return send(res, 200, { ok: true, opened: 'desktop' satisfies OpenedAs });
        }
        case 'terminal':
          return await resume();
        case 'terminal-live': {
          const focused = proc && o.focusTerminal ? await o.focusTerminal(proc) : 'not-found';
          // The pid file outlived its `claude` (or the pid is another process now): nothing runs the
          // session, so resuming it is safe and is what the button can still do.
          if (focused === 'stale') {
            log(`session ${sessionId}: its process is gone, resuming instead`);
            return await resume();
          }
          if (focused === 'not-found') {
            log(`session ${sessionId}: its terminal was not found`);
            return send(res, 409, { error: 'Não achei a janela do terminal desta sessão; copie o comando', command });
          }
          log(`session ${sessionId}: its terminal brought forward`);
          return send(res, 200, { ok: true, opened: 'focused' satisfies OpenedAs });
        }
      }
    } catch (err) {
      log(`session ${sessionId}: opening failed (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
      return send(res, 502, { error: 'Não deu para abrir a sessão', command });
    }
  };
}
