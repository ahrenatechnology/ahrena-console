/*
 * #507 #531 what the work board's session routes share (api/work-plan.ts, api/work-run.ts): the folder of a
 * repository on this machine, the command to copy, and opening the session in the Desktop or a terminal.
 */

import type { StoragePort } from '../storage-port.ts';
import { desktopNewSessionUrl, isThrowawayFolder, knownFolders } from './new-session.ts';
import { isUsableCwd, shellQuote } from './session-open.ts';
import { planningKeyOfPrompt } from '../github/work-plan.ts';
import { PLANNING_TOOL_FLAGS, type TerminalOpener } from './terminal-launch.ts';
import { gitDoSistema, repoDoRemote, type Git } from './work.ts';

/** The first listed folder (most recent first) whose `origin` is `repo`; `null` when none. */
export async function folderOfRepo(repo: string, folders: readonly { path: string }[], git: Git): Promise<string | null> {
  const want = repo.toLowerCase();
  for (const { path } of folders) {
    const remote = await git(path, ['remote', 'get-url', 'origin']);
    const found = remote ? repoDoRemote(remote) : null;
    if (found && found.toLowerCase() === want) return path;
  }
  return null;
}

/**
 * `cd '<folder>' && claude '<prompt>'` for "Copiar comando"; `claude '<prompt>'` when there is no folder. Each part
 * single-quoted. #515 A planning prompt goes after the tool restriction of the terminal (PLANNING_TOOL_FLAGS),
 * then a bare `--`: the tool lists are variadic and would take the prompt as one more rule.
 */
export const sessionCommand = (folder: string | null, prompt: string): string => {
  const flags = planningKeyOfPrompt(prompt) !== null ? [...PLANNING_TOOL_FLAGS.map(shellQuote), '--'] : [];
  return `${folder === null ? '' : `cd ${shellQuote(folder)} && `}claude ${[...flags, shellQuote(prompt)].join(' ')}`;
};

export interface WorkSessionOpeners {
  storage: Pick<StoragePort, 'listSessions'>;
  openInDesktop?: ((url: string) => Promise<void>) | null;
  openTerminal?: TerminalOpener | null;
  isThrowaway?: (path: string) => boolean;
  git?: Git;
  log?: (message: string) => void;
}

/** The folder of `repo` on this machine, among the folders new-session lists; `null` when none or not a usable path. */
export async function repoFolderOnThisMachine(o: WorkSessionOpeners, repo: string): Promise<string | null> {
  const folders = await knownFolders(o.storage, undefined, o.isThrowaway ?? isThrowawayFolder);
  const folder = await folderOfRepo(repo, folders, o.git ?? gitDoSistema);
  return folder === null || !isUsableCwd(folder) ? null : folder;
}

export type OpenOutcome = { opened: true } | { opened: false; status: 501 | 502; body: Record<string, unknown> };

/**
 * Opens the session as new-session does: `desktop` through the `claude://code/new?folder=…&q=<prompt>`
 * address, `terminal` through the terminal opener with the prompt as its own file. `failureText` is the
 * pt-BR error of a launcher that threw (502); `logLabel` names the route in the log.
 */
export async function openWorkSession(
  o: WorkSessionOpeners,
  { target, folder, prompt, key, failureText, logLabel }: { target: 'desktop' | 'terminal'; folder: string; prompt: string; key: string; failureText: string; logLabel: string },
): Promise<OpenOutcome> {
  const command = sessionCommand(folder, prompt);
  try {
    if (target === 'desktop') {
      if (!o.openInDesktop) return { opened: false, status: 501, body: { error: 'Abrir no Claude Desktop só no macOS, com o Claude Desktop', command } };
      await o.openInDesktop(desktopNewSessionUrl(folder, prompt));
    } else {
      const result = o.openTerminal ? await o.openTerminal({ sessionId: null, cwd: folder, prompt }) : 'unsupported';
      if (result === 'unsupported') return { opened: false, status: 501, body: { error: 'Não há um terminal que o console saiba abrir aqui; copie o comando', command } };
    }
  } catch (err) {
    (o.log ?? (() => {}))(`${logLabel}: opening failed in ${target} for ${key} (${err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err})`);
    return { opened: false, status: 502, body: { error: failureText, command } };
  }
  return { opened: true };
}
