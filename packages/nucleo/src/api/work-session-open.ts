/*
 * #507 #531 what the work board's session routes share (api/work-plan.ts, api/work-run.ts): the folder of a
 * repository on this machine, the command to copy, and opening the session in the Desktop or a terminal.
 * #594 and the refusal both give for a repository of an owner the installation does not trust.
 */

import type { StoragePort } from '../storage-port.ts';
import { desktopNewSessionUrl, isThrowawayFolder, knownFolders } from './new-session.ts';
import { isUsableCwd, shellQuote } from './session-open.ts';
import type { TerminalOpener } from './terminal-launch.ts';
import { gitDoSistema, repoDoRemote, type Git } from './work.ts';

/** #594 the 403 body of an untrusted repository: the `code` is stable (the screen branches on it), the `error` is what the screen shows. */
export const UNTRUSTED_REPOSITORY = {
  code: 'untrusted-repository',
  error: 'Este repositório não é de um dono confiável nesta instalação; o console não abre sessão para ele',
} as const;

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

/** `cd '<folder>' && claude '<prompt>'` for "Copiar comando"; `claude '<prompt>'` when there is no folder. Each part single-quoted. */
export const sessionCommand = (folder: string | null, prompt: string): string => `${folder === null ? '' : `cd ${shellQuote(folder)} && `}claude ${shellQuote(prompt)}`;

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
