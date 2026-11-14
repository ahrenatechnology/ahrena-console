/*
 * #531 "Executar plano" on the work board: `POST /api/work/run` opens the Athena session that executes an
 * issue's plan, in the folder of its repository on this machine (epic #468), the sibling of
 * `POST /api/work/plan` (api/work-plan.ts, #507).
 *
 * | Body                                                                                    | Answer                                      |
 * | --------------------------------------------------------------------------------------- | ------------------------------------------- |
 * | `{ repo: 'owner/name', number, target: 'desktop' \| 'terminal', force?: boolean }`      | 200 `{ ok, opened, key }`                   |
 * |                                                                                         | 409 `{ error, running, limit }` at the limit |
 *
 * - The issue is read through the issue use case (#506): an epic or an initiative is refused (422), and so
 *   is an issue with no sub-issue of any type (no plan, #467); a missing issue is 404, GitHub down with
 *   nothing stored 502 with the `reason` code, `--no-github` 503.
 * - The limit: with `EXECUTION_LIMIT` (2) or more cards in Em execução (booting runs included, counted by
 *   `running`) the answer is 409 with the reason and the count, unless `force` is true. When the count
 *   cannot be read the answer is 502 unless `force`.
 * - Folder, opening and the command to copy are the plan route's (work-session-open.ts). No folder: 501 with
 *   `command`, and no run is recorded (AC-4).
 * - The prompt (work-execution.ts) holds the issue's `owner/repo#N` and the numbers of its Plan-typed steps;
 *   no title, body or comment ever enters it, a command or an address (AC-5). `repo` and `number` are
 *   validated before anything is read, counted or run.
 * - The run is recorded (work-execution-runs.ts) once the session opened, with the start taken before opening
 *   so the session is never older than its run. A second request while a run is booting is 409.
 * - The account is the current one, read-only: no parameter chooses it (#126).
 *
 * Same-origin and JSON as /api/work/plan. The `error` texts are pt-BR: the screen shows them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubFailureOf, NoDataError } from '../github/cache.ts';
import { EXECUTION_LIMIT, executionPrompt, isExecutionRunActive, isOverExecutionLimit, type RunningCards, type WorkExecutionRuns } from '../github/work-execution.ts';
import { WorkIssueNotFoundError, type WorkIssueService } from '../github/work-issue-service.ts';
import { isPlanNumber, isPlanRepo, type PlanTarget } from '../github/work-plan.ts';
import { levelOf, workKey } from '../github/work.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { StoragePort } from '../storage-port.ts';
import { readJsonBody } from './connections-route.ts';
import { NEW_SESSION_TARGETS } from './new-session.ts';
import type { TerminalOpener } from './terminal-launch.ts';
import type { Git } from './work.ts';
import { openWorkSession, repoFolderOnThisMachine, sessionCommand } from './work-session-open.ts';

export const WORK_RUN_ROUTE = '/api/work/run';

export interface WorkRunRouteOptions {
  /** #506 the issue detail use case; `null` under --no-github: the route answers 503. */
  issues: Pick<WorkIssueService, 'issue'> | null;
  runs: WorkExecutionRuns;
  /** #531 counts the cards in Em execução; the board service implements it. */
  running: RunningCards;
  /** Where a folder's remote is read; injected so the tests need no git. */
  git?: Git;
  now?: () => number;
}

export interface WorkRunRouteDeps extends WorkRunRouteOptions {
  storage: Pick<StoragePort, 'listSessions'>;
  openInDesktop?: ((url: string) => Promise<void>) | null;
  openTerminal?: TerminalOpener | null;
  isThrowaway?: (path: string) => boolean;
  log?: (message: string) => void;
}

export type WorkRunRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createWorkRunRoute(o: WorkRunRouteDeps | null): WorkRunRoute {
  return async function workRunRoute(req, res) {
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
    const { repo, number, target, force } = (body.value ?? {}) as Record<string, unknown>;
    if (typeof target !== 'string' || !(NEW_SESSION_TARGETS as readonly string[]).includes(target)) return send(res, 400, { error: 'Escolha Claude Desktop ou terminal' });
    if (typeof repo !== 'string' || !isPlanRepo(repo) || !isPlanNumber(number) || (force !== undefined && typeof force !== 'boolean')) return send(res, 400, { error: 'pedido inválido' });
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
    if (level === 'epic' || level === 'initiative') return send(res, 422, { error: 'Épicos e iniciativas não se executam aqui: execute as histórias deles' });
    // #531 "has a plan" is the TOTAL sub-issue count, the card's meaning (#467); the prompt lists the Plan-typed steps only.
    if (issue.subIssues.length === 0) return send(res, 422, { error: 'Esta issue não tem plano: planeje antes de executar' });
    const previous = await o.runs.get(key);
    if (previous && isExecutionRunActive(previous, now())) return send(res, 409, { error: 'Já há uma execução subindo para esta issue' });

    if (force !== true) {
      let running: number;
      try {
        running = await o.running.runningCount();
      } catch (err) {
        if (err instanceof NoDataError) return send(res, 502, { error: 'Não deu para contar os cards em execução', reason: githubFailureOf(err) });
        throw err;
      }
      if (isOverExecutionLimit(running, false)) {
        return send(res, 409, { error: `Já há ${running} cards em execução (o limite é ${EXECUTION_LIMIT}); execute mesmo assim se quiser`, running, limit: EXECUTION_LIMIT });
      }
    }

    const prompt = executionPrompt({ repo, number, steps: issue.plan.steps.map((s) => s.number) });
    const folder = await repoFolderOnThisMachine(o, repo);
    if (folder === null) {
      return send(res, 501, { error: `Não achei uma pasta de ${repo} nesta máquina; copie o comando e rode na pasta do repositório`, command: sessionCommand(null, prompt) });
    }
    const startedAt = new Date(now()).toISOString();

    const opening = await openWorkSession(o, { target: target as PlanTarget, folder, prompt, key, failureText: 'Não deu para abrir a sessão de execução', logLabel: 'work run' });
    if (!opening.opened) return send(res, opening.status, opening.body);
    await o.runs.save({ key: key.toLowerCase(), target: target as PlanTarget, startedAt, state: 'booting', sessionId: null, finishedAt: null });
    log(`work run: execution session opened in ${target} for ${key}`);
    return send(res, 200, { ok: true, opened: target, key });
  };
}
