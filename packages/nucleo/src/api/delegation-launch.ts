// The adapters behind the delegation Launcher port (#567): the mechanism of opening a Claude session for an
// #567 alert, in the Claude Desktop, in a terminal on this Mac, or over SSH on the Workstation.
//
// #567 The prompt holds third-party text (process names, folders, command output), so it is never shell-parsed:
// #567 - Desktop: the address `claude://code/new?folder=…&q=…` (desktopNewSessionUrl), pre-filled, not sent.
// #567 - Terminal and SSH, "handoff": claude 2.1.325 has no pre-fill flag (`claude "<p>"` sends it), so the prompt
// #567 goes on the Mac clipboard (`pbcopy`, the text on stdin), is printed in the terminal from its own 0600 file
// #567 (`cat`), and `claude` starts with NO prompt: the person pastes and sends. The `.command` (0700) holds only
// #567 fixed text and single-quoted paths; both files remove themselves when it runs, on every exit path
// #567 before `exec` (the prompt file is removed right after `cat`, before `cd` can fail).
// #567 The clipboard keeps the exact prompt; the file `cat` prints is a display copy (terminalDisplayCopy):
// #567 every control but newline and tab (C0, DEL, C1: ESC, CSI U+009B, OSC U+009D) is written as visible `\uXXXX`
// #567 text, so third-party text cannot drive the terminal.
// #567 - SSH first runs a pre-flight (`ssh -o BatchMode=yes -o ConnectTimeout=5 <host> true`): a killed process,
// #567 or ssh's own connect timeout (exit 255 with "timed out" in its stderr), is `ssh-timeout`; any other
// #567 failure `ssh-unreachable`. The stderr is only matched, never returned or logged.
// #567 - Anything but macOS: `unsupported`.
// #567 No shell string is run by Node: every program goes through the runner with an argument list.

import { randomUUID } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Launcher, SshFailure, SshLaunchResult } from '../delegation/delegate.ts';
import { desktopNewSessionUrl } from './new-session.ts';
import { isUsableCwd, shellQuote } from './session-open.ts';
import { checkPrompt, HOUR, privateDir, removeOld, systemRunner, type ProcessRunner } from './terminal-launch.ts';

/** #567 What the terminal prints above the prompt; person-read text (pt-BR). Fixed, no quote in it. */
export const HANDOFF_HEADER = 'O prompt abaixo já está na área de transferência: cole na sessão do claude e envie.';

/** #567 A plain host name or ssh config alias: no leading dash (an option), no space, quote or shell character. */
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** #567 The pre-flight waits for ssh's own connect timeout (5 s) and then a margin before it kills the process. */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/** #567 C0 controls but newline and tab, DEL and the C1 range: what a terminal reads as a command. */
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** #567 The prompt as the terminal prints it: each terminal control becomes visible `\uXXXX` text. */
export function terminalDisplayCopy(prompt: string): string {
  return prompt.replace(TERMINAL_CONTROLS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** #567 ssh's own connect timeout: it exits 255 and says "timed out" on stderr. */
const SSH_CONNECT_TIMED_OUT = /timed out/i;

function checkHost(host: string): string {
  if (!SSH_HOST_PATTERN.test(host)) throw new Error('unusable ssh host');
  return host;
}

export interface HandoffCommand {
  /** #567 The folder `claude` starts in (local); `null` for ssh, where the remote home is the folder. */
  folder: string | null;
  /** #567 The file holding the prompt text; the `.command` prints it and removes it. */
  promptFile: string;
  /** #567 Present for ssh: `claude` runs on this host. */
  sshHost?: string;
}

/** #567 The `.command` of a handoff; throws on a folder or a host it cannot carry. The prompt is not in it. */
export function handoffCommandContent({ folder, promptFile, sshHost }: HandoffCommand): string {
  if (folder !== null && !isUsableCwd(folder)) throw new Error('unusable folder');
  const start = sshHost === undefined ? 'exec claude' : `exec ssh -t ${shellQuote(checkHost(sshHost))} 'claude'`;
  return [
    '#!/bin/sh',
    'rm -f -- "$0"',
    `printf '%s\\n\\n' ${shellQuote(HANDOFF_HEADER)}`,
    `cat -- ${shellQuote(promptFile)}`,
    'status=$?',
    `rm -f -- ${shellQuote(promptFile)}`,
    ...(folder === null ? [] : [`cd -- ${shellQuote(folder)} || exit 1`]),
    '[ "$status" -eq 0 ] || exit 1',
    start,
    '',
  ].join('\n');
}

/** #567 A killed process, or exit 255 whose stderr says "timed out"; the stderr is read here and goes nowhere else. */
function isSshTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { killed, code, stderr } = err as { killed?: unknown; code?: unknown; stderr?: unknown };
  return killed === true || (code === 255 && typeof stderr === 'string' && SSH_CONNECT_TIMED_OUT.test(stderr));
}

export interface DelegationLauncherOptions {
  /** #567 The folder the handoff files go in (macOS); the núcleo owns it (0700). */
  dir: string;
  /** #567 Opens a `claude://` address (macOS `open`); without it the Desktop is `unsupported`. */
  openInDesktop?: ((url: string) => Promise<void>) | null;
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  now?: () => number;
  /** #567 A leftover handoff file older than this is removed. Default an hour. */
  maxAgeMs?: number;
}

export function createDelegationLauncher({ dir, openInDesktop = null, platform = process.platform, runner = systemRunner, now = Date.now, maxAgeMs = HOUR }: DelegationLauncherOptions): Launcher {
  /** #567 Clipboard, files, then the terminal; the files are removed when any step fails. */
  async function handoff(request: Pick<HandoffCommand, 'folder' | 'sshHost'>, prompt: string): Promise<void> {
    const id = randomUUID();
    const promptFile = join(dir, `handoff-${id}.prompt`);
    const file = join(dir, `handoff-${id}.command`);
    const content = handoffCommandContent({ ...request, promptFile });
    await privateDir(dir);
    await removeOld(dir, now(), maxAgeMs);
    await runner.run('pbcopy', [], { input: prompt });
    try {
      await writeFile(promptFile, terminalDisplayCopy(prompt), { mode: 0o600, flag: 'wx' });
      await writeFile(file, content, { mode: 0o700, flag: 'wx' });
      await chmod(file, 0o700);
      await runner.run('open', [file]);
    } catch (err) {
      await rm(promptFile, { force: true });
      await rm(file, { force: true });
      throw new Error('could not open the terminal', { cause: err });
    }
  }

  async function preflight(host: string): Promise<SshFailure | null> {
    try {
      await runner.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true'], { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      return null;
    } catch (err) {
      return isSshTimeout(err) ? 'ssh-timeout' : 'ssh-unreachable';
    }
  }

  return {
    async openDesktop(folder, prompt) {
      if (!openInDesktop) return 'unsupported';
      await openInDesktop(desktopNewSessionUrl(folder, prompt));
      return 'opened';
    },
    async openTerminal(folder, prompt) {
      if (platform !== 'darwin') return 'unsupported';
      if (!isUsableCwd(folder)) throw new Error('unusable folder');
      await handoff({ folder }, checkPrompt(prompt));
      return 'opened';
    },
    async openSsh(host, prompt): Promise<SshLaunchResult> {
      const checked = checkHost(host);
      if (platform !== 'darwin') return 'unsupported';
      checkPrompt(prompt);
      const failed = await preflight(checked);
      if (failed) return { failed };
      await handoff({ folder: null, sshHost: checked }, prompt);
      return 'opened';
    },
  };
}
