// The PATH the tools are looked up in (#280, decision 0014 section 2): the user's login shell's, as
// in the desktop app (apps/desktop/src-tauri/src/shell_path.rs) and decision 0012. An app opened from
// the Finder inherits launchd's minimal PATH and would find neither fnm's Node nor ~/.local/bin.
//
// - Read once and cached: `$SHELL -ilc printf…` with a fixed argv (the only `$PATH` is the shell's own
//   expansion inside this fixed string; nothing from the request or a file reaches it), 5 s, through
//   the injected runner. Merged with ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and the process
//   PATH; when the shell fails, the process PATH plus those.
// - `which` is JS (no `which` process): the first executable file named so in the PATH, with
//   PATHEXT on Windows.
// - `~/` in a catalog path is expanded here, in code.

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Platform } from './catalog.ts';
import { PROBE_TIMEOUT_MS, toolsEnv, type ToolRunner } from './runner.ts';

export const PATH_MARKER = '__AHRENA_PATH__';

// `${PATH}` with braces: right before the marker, a bare `$PATH` would read as the variable `PATH__AHRENA_PATH__`.
export function loginShellArgv(shell: string): string[] {
  return [shell, '-ilc', `printf '%s' "${PATH_MARKER}\${PATH}${PATH_MARKER}"`];
}

/** The PATH between the markers (an interactive shell may print a banner around it). */
export function parseLoginPath(out: string): string | null {
  const start = out.indexOf(PATH_MARKER);
  if (start < 0) return null;
  const from = start + PATH_MARKER.length;
  const end = out.indexOf(PATH_MARKER, from);
  return end < 0 ? null : out.slice(from, end);
}

export function mergePaths(delimiter: string, ...lists: (string | null | undefined)[]): string {
  const parts: string[] = [];
  for (const list of lists)
    for (const p of (list ?? '').split(delimiter)) if (p && !parts.includes(p)) parts.push(p);
  return parts.join(delimiter);
}

export interface LoginPathOptions {
  run: ToolRunner;
  platform?: Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
}

export async function readLoginPath(o: LoginPathOptions): Promise<string> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? (process.platform as Platform);
  if (platform === 'win32') return env.Path ?? env.PATH ?? '';
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const r = await o.run(loginShellArgv(shell), { timeoutMs: PROBE_TIMEOUT_MS, env: toolsEnv(null, env) }).catch(() => null);
  const fromShell = r ? parseLoginPath(r.stdout) : null;
  return mergePaths(':', fromShell, `${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin`, env.PATH);
}

/** Reads the login PATH once; every later call gets the same answer. */
export class LoginPath {
  private value: Promise<string> | null = null;
  private readonly o: LoginPathOptions;
  constructor(options: LoginPathOptions) {
    this.o = options;
  }
  get(): Promise<string> {
    this.value ??= readLoginPath(this.o);
    return this.value;
  }
}

/** `~` and `~/x` → the home folder; anything else unchanged. */
export function expandHome(p: string, home: string, platform: Platform = process.platform as Platform): string {
  if (p === '~') return home;
  if (!p.startsWith('~/')) return p;
  return (platform === 'win32' ? win32 : posix).join(home, p.slice(2));
}

export type IsExecutable = (path: string) => Promise<boolean>;

export const systemIsExecutable: IsExecutable = async (path) => {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    if (process.platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface WhichOptions {
  platform?: Platform;
  isExecutable?: IsExecutable;
  pathExt?: string;
}

/** The first executable named `name` in `path`; `null` when there is none. */
export async function which(name: string, path: string, o: WhichOptions = {}): Promise<string | null> {
  const platform = o.platform ?? (process.platform as Platform);
  const isExecutable = o.isExecutable ?? systemIsExecutable;
  const P = platform === 'win32' ? win32 : posix;
  if (name.includes('/') || name.includes('\\')) return null;
  // On Windows an extensionless file is npm's sh shim, which cmd cannot run: it counts only when PATHEXT is empty.
  const winExts = platform === 'win32' ? (o.pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [];
  const exts = winExts.length > 0 ? winExts : [''];
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = P.join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
