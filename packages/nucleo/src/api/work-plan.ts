/*
 * #507 "Planejar" on the work board: `POST /api/work/plan` opens a planning-only Athena session for an
 * issue, in the folder of its repository on this machine (epic #467).
 *
 * | Body                                                                                    | Answer                            |
 * | --------------------------------------------------------------------------------------- | --------------------------------- |
 * | `{ repo: 'owner/name', number, target: 'desktop' \| 'terminal', replan?: boolean }`     | 200 `{ ok, opened, key }`         |
 *
 * - The issue is read through layer 1's use case (#506): an epic or an initiative is refused (422), a missing
 *   issue is 404, GitHub down with nothing stored 502 with the `reason` code, `--no-github` 503.
 * - The folder is one of `knownFolders` (new-session.ts: the folders this machine's sessions ran in, a
 *   worktree folded into its repository) whose `origin` remote is `repo`, the first one in that order (the
 *   most recent); `claude` never starts anywhere else. None: 501 with `command`, `claude '<prompt>'`, to run
 *   in the repository's folder.
 * - The session opens as new-session does: `desktop` through the `claude://code/new?folder=…&q=<prompt>`
 *   address (the Desktop pre-fills the composer, the person sends the prompt); `terminal` through the
 *   terminal opener with the prompt as its own file (terminal-launch.ts). Without the launcher: 501 with
 *   `command`, `cd '<folder>' && claude '<prompt>'`, each part single-quoted.
 * - The prompt (work-plan.ts) holds the issue's `owner/repo#N` and, on `replan`, the numbers of its current
 *   Plan steps; no title, body or comment ever enters it, a command or an address (AC-6). `repo` and `number`
 *   are validated before anything is read or run.
 * - The run is recorded (work-plan-runs.ts) once the session opened, with the start taken before opening so
 *   the session is never older than its run. A second request while a run is active is 409 (isPlanRunActive).
 * - The account is the current one, read-only: no parameter chooses it (#126).
 *
 * Same-origin and JSON as new-session (server.ts lets only the /ui in; `Content-Type: application/json`
 * 415, a query 403, 400 and 413 for the body). The `error` texts are pt-BR: the screen shows them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import { WorkIssueNotFoundError, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo, isPlanRunActive, planningPrompt, type PlanTarget, type WorkPlanRuns } from '../github/work-plan.ts';
import { levelOf, workKey } from '../github/work.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { StoragePort } from '../storage-port.ts';
import { readJsonBody } from './connections-route.ts';
import { desktopNewSessionUrl, isThrowawayFolder, knownFolders, NEW_SESSION_TARGETS } from './new-session.ts';
import { isUsableCwd, shellQuote } from './session-open.ts';
import type { TerminalOpener } from './terminal-launch.ts';
import { gitDoSistema, repoDoRemote, type Git } from './work.ts';

export const WORK_PLAN_ROUTE = '/api/work/plan';

export interface WorkPlanRouteOptions {
  /** #506 the issue detail use case; `null` under --no-github: the route answers 503. */
  issues: Pick<WorkIssueService, 'issue'> | null;
  runs: WorkPlanRuns;
  /** Where a folder's remote is read; injected so the tests need no git. */
  git?: Git;
  now?: () => number;
}

export interface WorkPlanRouteDeps extends WorkPlanRouteOptions {
  storage: Pick<StoragePort, 'listSessions'>;
  openInDesktop?: ((url: string) => Promise<void>) | null;
  openTerminal?: TerminalOpener | null;
  isThrowaway?: (path: string) => boolean;
  log?: (message: string) => void;
}

export type WorkPlanRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The first listed folder (most recent first) whose `origin` is `repo`; `null` when none. */
async function folderOfRepo(repo: string, folders: readonly { path: string }[], git: Git): Promise<string | null> {
  const want = repo.toLowerCase();
  for (const { path } of folders) {
    const remote = await git(path, ['remote', 'get-url', 'origin']);
    const found = remote ? repoDoRemote(remote) : null;
    if (found && found.toLowerCase() === want) return path;
  }
  return null;
}

/** `cd '<folder>' && claude '<prompt>'` for "Copiar comando"; `claude '<prompt>'` when there is no folder. */
const planCommand = (folder: string | null, prompt: string): string => `${folder === null ? '' : `cd ${shellQuote(folder)} && `}claude ${shellQuote(prompt)}`;

export function createWorkPlanRoute(o: WorkPlanRouteDeps | null): WorkPlanRoute {
  return async function workPlanRoute(req, res) {
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
    const { repo, number, target, replan } = (body.value ?? {}) as Record<string, unknown>;
    if (typeof target !== 'string' || !(NEW_SESSION_TARGETS as readonly string[]).includes(target)) return send(res, 400, { error: 'Escolha Claude Desktop ou terminal' });
    if (typeof repo !== 'string' || !isPlanRepo(repo) || !isPlanNumber(number) || (replan !== undefined && typeof replan !== 'boolean')) return send(res, 400, { error: 'pedido inválido' });
    if (!o || !o.issues) return send(res, 503, { error: 'O GitHub está desligado neste console' });

    const log = o.log ?? (() => {});
    const now = o.now ?? Date.now;
    const key = workKey(repo, number);
    let issue;
    try {
      issue = await o.issues.issue(key);
    } catch (err) {
      if (err instanceof WorkIssueNotFoundError) return send(res, 404, { error: 'Não achei esta issue no GitHub' });
      if (err instanceof NoDataError) return send(res, 502, { error: 'Não deu para ler a issue no GitHub', reason: githubFailureOf(err) });
      throw err;
    }
    const level = levelOf(issue.type, null);
    if (level === 'epic' || level === 'initiative') return send(res, 422, { error: 'Épicos e iniciativas não se planejam aqui: planeje as histórias deles' });
    const previous = await o.runs.get(key);
    if (previous && isPlanRunActive(previous, now())) return send(res, 409, { error: 'Já há um planejamento em andamento para esta issue' });

    const replacing = replan === true;
    const prompt = planningPrompt({ repo, number, ...(replacing ? { replaceSteps: issue.plan.steps.map((s) => s.number) } : {}) });
    const folders = await knownFolders(o.storage, undefined, o.isThrowaway ?? isThrowawayFolder);
    const folder = await folderOfRepo(repo, folders, o.git ?? gitDoSistema);
    if (folder === null || !isUsableCwd(folder)) {
      return send(res, 501, { error: `Não achei uma pasta de ${repo} nesta máquina; copie o comando e rode na pasta do repositório`, command: planCommand(null, prompt) });
    }
    const command = planCommand(folder, prompt);
    const startedAt = new Date(now()).toISOString();

    try {
      if (target === 'desktop') {
        if (!o.openInDesktop) return send(res, 501, { error: 'Abrir no Claude Desktop só no macOS, com o Claude Desktop', command });
        await o.openInDesktop(desktopNewSessionUrl(folder, prompt));
      } else {
        const result = o.openTerminal ? await o.openTerminal({ sessionId: null, cwd: folder, prompt }) : 'unsupported';
        if (result === 'unsupported') return send(res, 501, { error: 'Não há um terminal que o console saiba abrir aqui; copie o comando', command });
      }
    } catch (err) {
      log(`work plan: opening failed (${err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err})`);
      return send(res, 502, { error: 'Não deu para abrir a sessão de planejamento', command });
    }
    await o.runs.save({ key: key.toLowerCase(), target: target as PlanTarget, startedAt, replan: replacing, sessionId: null, outcome: 'running', failure: null, finishedAt: null });
    log(`work plan: planning session opened in ${target} for ${key}`);
    return send(res, 200, { ok: true, opened: target, key });
  };
}
