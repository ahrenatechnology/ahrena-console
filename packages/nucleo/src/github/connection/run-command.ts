// Runs a vault tool (`security`, `secret-tool`) by its path, without a shell, with an optional stdin.
// The output is handed back to the adapter and never logged: it may hold a secret.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface CommandResult {
  /** The exit code; `null` when killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommand = (bin: string, args: readonly string[], options?: { input?: string; timeoutMs?: number }) => Promise<CommandResult>;

export const runCommand: RunCommand = (bin, args, { input, timeoutMs = 15_000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, timeout: timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    // The message of a spawn error names the path only.
    child.on('error', (e: NodeJS.ErrnoException) => reject(new Error(`could not run ${bin} (${e.code ?? 'error'})`)));
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    child.stdin.on('error', () => undefined); // the process may exit before reading
    child.stdin.end(input ?? '');
  });

/** Whether `path` is an executable file. Never runs it. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `name` on `PATH` for which `exists` says yes, or `null`. Never runs it. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = isExecutable): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}
