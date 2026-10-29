// "Nova sessão": start a new Claude Code session in a folder, in the Claude Desktop or in a terminal.
//
// | Route                              | What                                                                  |
// | ---------------------------------- | --------------------------------------------------------------------- |
// | `GET /api/new-session/folders`     | `{ folders: [{ path, name }], targets: { desktop, terminal } }`       |
// | `POST /api/new-session`            | `{ folder, target: 'desktop' \| 'terminal' }` → 200 `{ ok, opened }` |
//
// The folders are the ones this machine's sessions ran in, most recent first, a worktree folded into its
// repository (`<repo>/.claude/worktrees/<name>` → `<repo>`, as the Claude Desktop does), without the
// throwaway ones (the Claude Desktop's scratch workspaces, the temporary folders), only those that still
// exist, up to MAX_FOLDERS. The write takes only a folder of that list: the console never starts
// `claude` in a path the screen made up.
//
// - `desktop`: `claude://code/new?folder=<path>` through `openInDesktop` (the Desktop opens a new Code
//   session in that folder).
// - `terminal`: the terminal opener (terminal-launch.ts) with no session, so it runs `claude` there.
//
// Without the launcher (another platform, the demo) or when it finds no terminal: 501 with `command`,
// `cd '<folder>' && claude`, for the screen's "Copiar comando". Same-origin only (decision 0003): server.ts
// lets the /ui in only with `Origin` exactly `http://<Host>` and the exact raw path; here,
// `Content-Type: application/json` (415). The `error` texts are pt-BR: the screen shows them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { send } from '../ingest/hooks/receiver.ts';
import type { StoragePort } from '../storage-port.ts';
import { readJsonBody } from './connections-route.ts';
import { isUsableCwd, shellQuote } from './session-open.ts';
import type { TerminalOpener } from './terminal-launch.ts';

export const NEW_SESSION_ROUTE = '/api/new-session';
export const NEW_SESSION_FOLDERS_ROUTE = '/api/new-session/folders';

export const NEW_SESSION_TARGETS = ['desktop', 'terminal'] as const;
export type NewSessionTarget = (typeof NEW_SESSION_TARGETS)[number];

/** How many folders the list offers. */
export const MAX_FOLDERS = 20;
/** How many recent sessions the list looks at. */
const SCAN_SESSIONS = 500;

export interface NewSessionFolder {
  path: string;
  /** The folder's last segment, what the screen shows first. */
  name: string;
}

/** `<repo>/.claude/worktrees/<name>[/…]` → `<repo>`; any other folder as it is. */
export function projectFolder(cwd: string): string {
  const parts = cwd.split(sep);
  for (let i = 1; i + 2 < parts.length; i++) {
    if (parts[i] === '.claude' && parts[i + 1] === 'worktrees') return parts.slice(0, i).join(sep) || sep;
  }
  return cwd;
}

/** A folder nobody starts a session in on purpose: the Desktop's scratch workspaces, the temporary ones. */
const THROWAWAY = [/\/Library\/Application Support\/Claude\/scratch-workspaces\//, /^\/(private\/)?tmp\//, /^\/private\/var\/folders\//, /^\/var\/folders\//];

export function isThrowawayFolder(path: string): boolean {
  return THROWAWAY.some((re) => re.test(`${path}/`));
}

/** The line the screen copies when nothing could open: `cd '<folder>' && claude`. */
export function newSessionCommand(folder: string): string | null {
  return isUsableCwd(folder) ? `cd ${shellQuote(folder)} && claude` : null;
}

/** The Claude Desktop's address for a new Code session in the folder. */
export function desktopNewSessionUrl(folder: string): string {
  return `claude://code/new?folder=${encodeURIComponent(folder)}`;
}

async function isDirectoryOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface NewSessionRouteOptions {
  storage: Pick<StoragePort, 'listSessions'>;
  /** Opens a `claude://` address (macOS `open`); without it, `desktop` answers 501. */
  openInDesktop?: ((url: string) => Promise<void>) | null;
  openTerminal?: TerminalOpener | null;
  isDirectory?: (path: string) => Promise<boolean>;
  /** A folder the list leaves out; default `isThrowawayFolder`. */
  isThrowaway?: (path: string) => boolean;
  log?: (message: string) => void;
}

/** The folders a new session can start in: recent first, distinct, existing. */
export async function knownFolders(
  storage: Pick<StoragePort, 'listSessions'>,
  isDirectory: (path: string) => Promise<boolean> = isDirectoryOnDisk,
  isThrowaway: (path: string) => boolean = isThrowawayFolder,
): Promise<NewSessionFolder[]> {
  const page = await storage.listSessions({ limit: SCAN_SESSIONS });
  const seen = new Set<string>();
  const folders: NewSessionFolder[] = [];
  for (const s of page.items) {
    if (!isUsableCwd(s.cwd)) continue;
    const path = projectFolder(s.cwd);
    if (seen.has(path) || isThrowaway(path)) continue;
    seen.add(path);
    if (!(await isDirectory(path))) continue;
    folders.push({ path, name: basename(path) || path });
    if (folders.length >= MAX_FOLDERS) break;
  }
  return folders;
}

export type NewSessionRoute = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;

export function createNewSessionRoute(o: NewSessionRouteOptions): NewSessionRoute {
  const log = o.log ?? (() => {});
  const isDirectory = o.isDirectory ?? isDirectoryOnDisk;
  const list = () => knownFolders(o.storage, isDirectory, o.isThrowaway ?? isThrowawayFolder);

  async function folders(req: IncomingMessage, res: ServerResponse) {
    req.resume();
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
    return send(res, 200, { folders: await list(), targets: { desktop: Boolean(o.openInDesktop), terminal: Boolean(o.openTerminal) } });
  }

  async function start(req: IncomingMessage, res: ServerResponse) {
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
    const { folder, target } = (body.value ?? {}) as { folder?: unknown; target?: unknown };
    if (typeof target !== 'string' || !(NEW_SESSION_TARGETS as readonly string[]).includes(target)) return send(res, 400, { error: 'Escolha Claude Desktop ou terminal' });
    if (typeof folder !== 'string' || !isUsableCwd(folder)) return send(res, 400, { error: 'pasta inválida' });
    // Only a folder of the list: the screen never picks a path of its own.
    const known = await list();
    if (!known.some((f) => f.path === folder)) return send(res, 422, { error: 'O console não conhece esta pasta' });
    const command = newSessionCommand(folder);

    try {
      if (target === 'desktop') {
        if (!o.openInDesktop) return send(res, 501, { error: 'Abrir no Claude Desktop só no macOS, com o Claude Desktop', command });
        await o.openInDesktop(desktopNewSessionUrl(folder));
        log('new session opened in the Claude Desktop');
        return send(res, 200, { ok: true, opened: 'desktop' });
      }
      const result = o.openTerminal ? await o.openTerminal({ sessionId: null, cwd: folder }) : 'unsupported';
      if (result === 'unsupported') return send(res, 501, { error: 'Não há um terminal que o console saiba abrir aqui; copie o comando', command });
      log('new session opened in a terminal');
      return send(res, 200, { ok: true, opened: 'terminal' });
    } catch (err) {
      log(`new session: opening failed (${err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err})`);
      return send(res, 502, { error: 'Não deu para abrir a sessão nova', command });
    }
  }

  return (req, res, pathname) => (pathname === NEW_SESSION_FOLDERS_ROUTE ? folders(req, res) : start(req, res));
}
