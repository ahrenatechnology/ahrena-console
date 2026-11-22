// The runner of the embedded ai-memory (#727, decisions 0012 and 0014 section 3). What it guarantees:
//
// - The binary is the embedded one, by absolute path (`embeddedAiMemoryPath`, #725), never a PATH lookup.
//   With no binary (null) it reports `unavailable` and spawns nothing.
// - The argv is built only from the constants below plus the `--data-dir` the core fixed; the caller names
//   a command from a closed list, never an argument.
// - `spawn(path, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`: its own
//   process group, standard input closed, the child environment without `AI_MEMORY_AUTH_TOKEN` and
//   `AHRENA_CONSOLE_*`.
// - Timeout: SIGTERM to the process group and, after the grace period, SIGKILL to the group.
// - One call at a time, in order.
// - Only stdout is read, bounded. Stderr is drained and dropped: never parsed, logged or returned.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** The commands the core may run on the embedded binary, each with a fixed argv (#727). */
export type MemoryCommand = 'version' | 'setup-plan' | 'status';

// The `--data-dir` option comes first, then the command (#727).
const COMMAND_ARGS: Record<MemoryCommand, readonly string[]> = {
  version: ['--version'],
  'setup-plan': ['setup', '--plan', '--json', '--agent', 'claude-code'],
  status: ['status'],
};

const DATA_DIR_OPTION = '--data-dir';
const TOKEN_VARIABLE = 'AI_MEMORY_AUTH_TOKEN';
const CONSOLE_PREFIX = 'AHRENA_CONSOLE_';

export const MEMORY_TIMEOUT_MS = 10_000;
export const MEMORY_KILL_GRACE_MS = 5_000;
export const MEMORY_MAX_STDOUT_BYTES = 1024 * 1024;

/** How one call ended; nothing in it carries stderr or an error's text (#727). */
export type MemoryRunResult =
  | { kind: 'unavailable' }
  | { kind: 'ok'; stdout: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'timeout' }
  | { kind: 'failed'; reason: 'spawn' | 'output-too-large' };

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** What the runner needs; the tests inject `spawn`, `killGroup` and `env` (#727). */
export interface MemoryRunnerOptions {
  /** The embedded binary's absolute path, or null when this core has none (#725, #727). */
  binaryPath: string | null;
  /** The ai-memory data folder, fixed by the core (#727). */
  dataDir: string;
  /** The core's environment, before the token and `AHRENA_CONSOLE_*` are dropped (#727). */
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  /** Signals a process group; tests record it, nothing real is signaled (#727). */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
}

/** The runner as the memory module uses it (#727). */
export interface MemoryRunner {
  /** False when there is no embedded binary (#727). */
  readonly available: boolean;
  run(command: MemoryCommand): Promise<MemoryRunResult>;
}

/** The core's environment minus `AI_MEMORY_AUTH_TOKEN` (any case) and `AHRENA_CONSOLE_*` (#727/AC-2). */
export function memoryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === TOKEN_VARIABLE || key.startsWith(CONSOLE_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (#727).
  }
}

export function createMemoryRunner(options: MemoryRunnerOptions): MemoryRunner {
  const { binaryPath, dataDir } = options;
  if (!isAbsolute(dataDir)) throw new TypeError('memory data dir must be absolute');
  if (binaryPath !== null && !isAbsolute(binaryPath)) throw new TypeError('memory binary path must be absolute');
  const spawn: Spawn = options.spawn ?? nodeSpawn;
  const killGroup = options.killGroup ?? defaultKillGroup;
  const timeoutMs = options.timeoutMs ?? MEMORY_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? MEMORY_KILL_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? MEMORY_MAX_STDOUT_BYTES;
  const childEnv = memoryEnv(options.env);
  let tail: Promise<unknown> = Promise.resolve();

  function execute(binary: string, command: MemoryCommand): Promise<MemoryRunResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [DATA_DIR_OPTION, dataDir, ...COMMAND_ARGS[command]], {
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
          windowsHide: true,
        });
      } catch {
        return resolve({ kind: 'failed', reason: 'spawn' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let ended: MemoryRunResult | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let killer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: MemoryRunResult): void => {
        if (timer) clearTimeout(timer);
        if (killer) clearTimeout(killer);
        timer = killer = null;
        resolve(result);
      };
      const terminate = (why: MemoryRunResult): void => {
        if (ended) return;
        ended = why;
        if (child.pid !== undefined) killGroup(child.pid, 'SIGTERM');
        killer = setTimeout(() => {
          if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
          settle(why);
        }, killGraceMs);
      };

      timer = setTimeout(() => terminate({ kind: 'timeout' }), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (ended) return;
        size += chunk.length;
        if (size > maxStdoutBytes) return terminate({ kind: 'failed', reason: 'output-too-large' });
        chunks.push(chunk);
      });
      // Stderr is drained so the child never blocks on it, and dropped (#727).
      child.stderr?.on('data', () => {});
      child.on('error', () => settle(ended ?? { kind: 'failed', reason: 'spawn' }));
      child.on('close', (code: number | null) => {
        if (ended) return settle(ended);
        if (code === 0) return settle({ kind: 'ok', stdout: Buffer.concat(chunks).toString('utf8') });
        settle({ kind: 'exit', code });
      });
    });
  }

  return {
    available: binaryPath !== null,
    run(command) {
      if (binaryPath === null) return Promise.resolve({ kind: 'unavailable' });
      const result = tail.then(() => execute(binaryPath, command));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
