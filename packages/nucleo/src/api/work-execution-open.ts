/*
 * #531 #477 the use case that opens an execution session for an issue's plan: the prompt, the folder of the
 * repository on this machine, the session in the Desktop or a terminal, and the run recorded. "Executar plano"
 * (api/work-run.ts) and the queue's puller (api/work-queue-puller.ts) both call it, so the two open a session
 * the same way. What each checks before (trust, limit, the issue) stays with the caller.
 *
 * - A key whose session is being opened right now, or whose run is booting, is refused 409 (`running`): two
 *   callers cannot launch the same issue at once, whatever their order. The guard is in this process, where
 *   every opener lives.
 * - No folder: 501 with the command to copy, and no run is recorded.
 * - The run is recorded once the session opened (the write is tried twice; if both fail, `RunNotRecordedError`: the session is
 *   open and no run points to it), with the start taken before opening so the session is never
 *   older than its run. `origin` says who asked: the person (`manual`) or the queue (`queue`).
 */

import { executionPrompt, isExecutionRunActive, type ExecutionOrigin, type ExecutionTarget, type WorkExecutionRuns } from '../github/work-execution.ts';
import type { WorkIssueResult } from '../github/work-issue-service.ts';
import { levelOf, workKey } from '../github/work.ts';
import { openWorkSession, repoFolderOnThisMachine, sessionCommand, type WorkSessionOpeners } from './work-session-open.ts';

export interface ExecutionOpenDeps extends WorkSessionOpeners {
  runs: WorkExecutionRuns;
  now?: () => number;
}

export interface ExecutionOpenInput {
  repo: string;
  number: number;
  target: ExecutionTarget;
  issue: Pick<WorkIssueResult, 'plan'>;
  origin: ExecutionOrigin;
}

export type ExecutionOpenOutcome = { opened: true; key: string } | { opened: false; status: number; body: Record<string, unknown> };

/** The issue keys whose session is being opened right now. */
const opening = new Set<string>();

/** The session opened but its run could not be recorded (twice): there is a session no run points to, so nothing may open it again. */
export class RunNotRecordedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('the execution session opened but its run was not recorded', options);
    this.name = 'RunNotRecordedError';
  }
}

export const ALREADY_BOOTING = { error: 'Já há uma execução subindo para esta issue' } as const;

/** Why an issue has nothing to execute (an epic, an initiative, no plan); `null` when it can run. Total sub-issue count is "has a plan" (#467). */
export function unrunnableReason(issue: Pick<WorkIssueResult, 'type' | 'subIssues'>): string | null {
  const level = levelOf(issue.type, null);
  if (level === 'epic' || level === 'initiative') return 'Épicos e iniciativas não se executam aqui: execute as histórias deles';
  if (issue.subIssues.length === 0) return 'Esta issue não tem plano: planeje antes de executar';
  return null;
}

/** Opens the session and records the run. Throws what a failed record throws (the session is then already open). */
export async function openExecution(o: ExecutionOpenDeps, { repo, number, target, issue, origin }: ExecutionOpenInput): Promise<ExecutionOpenOutcome> {
  const key = workKey(repo, number);
  const lower = key.toLowerCase();
  const now = o.now ?? Date.now;
  if (opening.has(lower)) return { opened: false, status: 409, body: { ...ALREADY_BOOTING } };
  opening.add(lower);
  try {
    const previous = await o.runs.get(lower);
    if (previous && isExecutionRunActive(previous, now())) return { opened: false, status: 409, body: { ...ALREADY_BOOTING } };

    const prompt = executionPrompt({ repo, number, steps: issue.plan.steps.map((s) => s.number) });
    const folder = await repoFolderOnThisMachine(o, repo);
    if (folder === null) {
      return { opened: false, status: 501, body: { error: `Não achei uma pasta de ${repo} nesta máquina; copie o comando e rode na pasta do repositório`, command: sessionCommand(null, prompt) } };
    }
    const startedAt = new Date(now()).toISOString();
    const outcome = await openWorkSession(o, { target, folder, prompt, key, failureText: 'Não deu para abrir a sessão de execução', logLabel: 'work run' });
    if (!outcome.opened) return { opened: false, status: outcome.status, body: outcome.body };
    const run = { key: lower, target, startedAt, state: 'booting' as const, sessionId: null, finishedAt: null, origin };
    try {
      await o.runs.save(run);
    } catch {
      // a lock or a full disk for one write: the session is open, so try once more before giving up
      try {
        await o.runs.save(run);
      } catch (err) {
        throw new RunNotRecordedError({ cause: err });
      }
    }
    return { opened: true, key };
  } finally {
    opening.delete(lower);
  }
}
