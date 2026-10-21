// How the Tools module runs a process and reads a URL (#280, decision 0014 sections 2 and 3). Both
// are injected everywhere (probe.ts, latest.ts, service.ts), so tests never run or download anything.
//
// - `execFile` with the argv list: no shell, standard input closed at once (a command that asks
//   something fails instead of waiting), a timeout, and the núcleo's environment minus the console's
//   own variables (`AHRENA_CONSOLE_*`), with the login shell's PATH, `NONINTERACTIVE=1` and
//   `HOMEBREW_NO_AUTO_UPDATE=1` (Homebrew reads its local API cache; `brew update` only on a check).
// - HTTP: `fetch` with an abort timeout; a non-2xx answer is an error.

import { execFile } from 'node:child_process';

export interface RunResult {
  /** `null` when the process did not exit on its own (not found, timed out, killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT`, `timeout`… or `null`. */
  error: string | null;
}

export interface RunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Working directory; default the núcleo's. */
  cwd?: string;
}

export type ToolRunner = (argv: readonly string[], options: RunOptions) => Promise<RunResult>;
export type FetchText = (url: string, timeoutMs: number) => Promise<string>;

export const PROBE_TIMEOUT_MS = 5_000;
export const LATEST_TIMEOUT_MS = 20_000;
export const FETCH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The environment of every tools process: the núcleo's, minus `AHRENA_CONSOLE_*`, with the login PATH. */
export function toolsEnv(path: string | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('AHRENA_CONSOLE_')) continue;
    out[k] = v;
  }
  if (path) out.PATH = path;
  out.NONINTERACTIVE = '1';
  out.HOMEBREW_NO_AUTO_UPDATE = '1';
  return out;
}

export const systemToolRunner: ToolRunner = (argv, options) =>
  new Promise((resolve) => {
    if (argv.length === 0) return resolve({ code: null, stdout: '', stderr: '', error: 'empty' });
    let child;
    try {
      child = execFile(
        argv[0]!,
        argv.slice(1),
        { shell: false, ...(options.cwd ? { cwd: options.cwd } : {}), timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, env: options.env ?? toolsEnv(null), windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr, error: null });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          const timedOut = e.killed === true;
          resolve({
            code: typeof e.code === 'number' ? e.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: timedOut ? 'timeout' : typeof e.code === 'string' ? e.code : typeof e.code === 'number' ? null : 'error',
          });
        },
      );
    } catch (err) {
      return resolve({ code: null, stdout: '', stderr: '', error: (err as NodeJS.ErrnoException).code ?? 'error' });
    }
    child.stdin?.end();
  });

export const systemFetchText: FetchText = async (url, timeoutMs) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'application/json, text/plain, */*' } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.text();
};
