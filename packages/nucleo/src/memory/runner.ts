/*
 * The runner of the embedded ai-memory (#727, decisions 0012 and 0014 section 3). What it guarantees:
 * - The binary is the embedded one, by absolute path (`embeddedAiMemoryPath`, #725), never a PATH lookup.
 *   With no binary (null) it reports `unavailable` and spawns nothing.
 * - The argv is built only from the constants below, plus a `--data-dir` only when a test injects one (absent: ai-memory's own default folder, #735); the caller names
 *   a command from a closed list. The one value a caller supplies is the project of `handoffs` and `recent`
 *   (#733): it must match PROJECT_FORMAT (no leading dash, no slash, no whitespace) or nothing is spawned,
 *   and it follows the constant `--project`; the workspace is the constant `default`.
 * - `spawn(path, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`: its own
 *   process group, standard input closed, the child environment built from the embedded binary's allowlist (`embeddedAiMemoryEnv`, #733):
 *   no credential, no `AI_MEMORY_*` and no `AHRENA_CONSOLE_*` reaches it (#727).
 * - Timeout: SIGTERM to the process group and, after the grace period, SIGKILL to the group, even when
 *   the leader closes first, so a descendant that ignores SIGTERM does not outlive the call.
 * - One call at a time, in order.
 * - `close()` (the core's shutdown, decision 0014): the queue is refused, the running group gets SIGTERM and,
 *   after the grace period, SIGKILL; nothing starts after. Wiring it into the core's shutdown is left to the
 *   sub-issue that wires the module, nothing imports it yet (#727).
 * - Only stdout is read, bounded. Stderr is drained and dropped: never logged or returned. The one reading of it
 *   (#733): for `handoffs` and `recent`, on a non-zero exit, its first 4 KiB is searched for the fixed sentence
 *   `project '<P>' not found in workspace 'default'`, built from the values the runner passed, and only a
 *   boolean leaves, as the kind `not-found`.
 * - The log line names the command and the result kind, never stderr, an error's text, a path or env (#727).
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { embeddedAiMemoryEnv } from '../tools/embedded-ai-memory.ts';

/** The commands with no caller value (#727, #733). */
export type MemoryGlobalCommand = 'version' | 'setup-plan' | 'status';
/** The commands that take a project (#733). */
export type MemoryProjectCommand = 'handoffs' | 'recent';
/** The commands the core may run on the embedded binary, each with a fixed argv (#727, #733). */
export type MemoryCommand = MemoryGlobalCommand | MemoryProjectCommand;

// The optional `--data-dir` (tests only, #735) comes first, then the command (#727).
const GLOBAL_ARGS: Record<MemoryGlobalCommand, readonly string[]> = {
  version: ['--version'],
  'setup-plan': ['setup', '--plan', '--json', '--agent', 'claude-code'],
  status: ['status', '--json'],
};

// The workspace is a constant: the core has one (#733).
const WORKSPACE = 'default';
// The one caller value: it never starts with a dash, so it cannot read as an option, and it holds no slash or whitespace (#733).
export const PROJECT_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NOT_FOUND_WINDOW_BYTES = 4096;

function isProjectCommand(command: MemoryCommand): command is MemoryProjectCommand {
  return command === 'handoffs' || command === 'recent';
}

function argsFor(command: MemoryCommand, project: string | undefined): readonly string[] | null {
  if (!isProjectCommand(command)) return GLOBAL_ARGS[command];
  if (project === undefined || !PROJECT_FORMAT.test(project)) return null;
  return [command, '--workspace', WORKSPACE, '--project', project, '--json'];
}

const DATA_DIR_OPTION = '--data-dir';

export const MEMORY_TIMEOUT_MS = 10_000;
export const MEMORY_KILL_GRACE_MS = 5_000;
export const MEMORY_MAX_STDOUT_BYTES = 1024 * 1024;

/** How one call ended; nothing in it carries stderr or an error's text (#727). */
export type MemoryRunResult =
  | { kind: 'unavailable' }
  | { kind: 'ok'; stdout: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'timeout' }
  | { kind: 'not-found' }
  | { kind: 'failed'; reason: 'spawn' | 'output-too-large' | 'closed' | 'invalid-project' };

export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** What the runner needs; the tests inject `spawn`, `killGroup` and `env` (#727). */
export interface MemoryRunnerOptions {
  /** The embedded binary's absolute path, or null when this core has none (#725, #727). */
  binaryPath: string | null;
  /** Optional, for tests with a temporary folder: absolute, and absent means no `--data-dir`, so ai-memory uses its default folder (#735). */
  dataDir?: string;
  /** The core's environment, before `embeddedAiMemoryEnv` keeps only the allowlist (#727). */
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  /** Signals a process group; tests record it, nothing real is signaled (#727). */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Internal log; receives the command and the result kind only, never stderr, an error's text, a path or env (#727). */
  log?: (message: string) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
}

/** The runner as the memory module uses it (#727). */
export interface MemoryRunner {
  /** False when there is no embedded binary (#727). */
  readonly available: boolean;
  run(command: MemoryGlobalCommand): Promise<MemoryRunResult>;
  /** The project is checked against PROJECT_FORMAT before anything is spawned (#733). */
  run(command: MemoryProjectCommand, project: string): Promise<MemoryRunResult>;
  /** Refuses queued and future calls and ends the running group; resolves when the queue is empty (#727). */
  close(): Promise<void>;
}

const CLOSED: MemoryRunResult = { kind: 'failed', reason: 'closed' };

export function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone (#727).
  }
}

export function createMemoryRunner(options: MemoryRunnerOptions): MemoryRunner {
  const { binaryPath, dataDir } = options;
  if (dataDir !== undefined && !isAbsolute(dataDir)) throw new TypeError('memory data dir must be absolute');
  if (binaryPath !== null && !isAbsolute(binaryPath)) throw new TypeError('memory binary path must be absolute');
  const dataDirArgs = dataDir === undefined ? [] : [DATA_DIR_OPTION, dataDir];
  const spawn: Spawn = options.spawn ?? nodeSpawn;
  const killGroup = options.killGroup ?? defaultKillGroup;
  const timeoutMs = options.timeoutMs ?? MEMORY_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? MEMORY_KILL_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? MEMORY_MAX_STDOUT_BYTES;
  const log = options.log;
  const childEnv = embeddedAiMemoryEnv(options.env);
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let stopRunning: (() => void) | null = null;

  function execute(binary: string, command: MemoryCommand, args: readonly string[], notFoundText: string | null): Promise<MemoryRunResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [...dataDirArgs, ...args], {
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
          windowsHide: true,
        });
      } catch {
        log?.(`memory: ${command} failed spawn`);
        return resolve({ kind: 'failed', reason: 'spawn' });
      }
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let errSize = 0;
      let size = 0;
      let ended: MemoryRunResult | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let killer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      // After a terminate the killer stays armed, so SIGKILL reaches the group even when the leader closes first (#727).
      const settle = (result: MemoryRunResult, keepKiller = false): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (killer && !keepKiller) clearTimeout(killer);
        if (!keepKiller) killer = null;
        if (result.kind === 'timeout') log?.(`memory: ${command} timeout`);
        if (result.kind === 'not-found') log?.(`memory: ${command} not-found`);
        if (result.kind === 'failed') log?.(`memory: ${command} failed ${result.reason}`);
        if (result.kind === 'exit') log?.(`memory: ${command} exit ${result.code ?? 'signal'}`);
        stopRunning = null;
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
      stopRunning = () => terminate({ kind: 'failed', reason: 'closed' });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (ended) return;
        size += chunk.length;
        if (size > maxStdoutBytes) return terminate({ kind: 'failed', reason: 'output-too-large' });
        chunks.push(chunk);
      });
      // Stderr is drained so the child never blocks on it; only its first 4 KiB is kept, and only to look for the not-found sentence (#727, #733).
      child.stderr?.on('data', (chunk: Buffer) => {
        if (notFoundText === null || errSize >= NOT_FOUND_WINDOW_BYTES) return;
        errChunks.push(chunk.subarray(0, NOT_FOUND_WINDOW_BYTES - errSize));
        errSize += errChunks.at(-1)!.length;
      });
      child.on('error', () => settle(ended ?? { kind: 'failed', reason: 'spawn' }, ended !== null));
      child.on('close', (code: number | null) => {
        if (ended) return settle(ended, true);
        if (code === 0) return settle({ kind: 'ok', stdout: Buffer.concat(chunks).toString('utf8') });
        if (code !== null && notFoundText !== null && Buffer.concat(errChunks).toString('utf8').includes(notFoundText)) return settle({ kind: 'not-found' });
        settle({ kind: 'exit', code });
      });
    });
  }

  return {
    available: binaryPath !== null,
    run(command: MemoryCommand, project?: string): Promise<MemoryRunResult> {
      if (binaryPath === null) return Promise.resolve({ kind: 'unavailable' });
      if (closing) return Promise.resolve(CLOSED);
      const args = argsFor(command, project);
      if (args === null) {
        log?.(`memory: ${command} failed invalid-project`);
        return Promise.resolve({ kind: 'failed', reason: 'invalid-project' });
      }
      const notFoundText = isProjectCommand(command) ? `project '${project}' not found in workspace '${WORKSPACE}'` : null;
      const result = tail.then((): Promise<MemoryRunResult> => (closing ? Promise.resolve(CLOSED) : execute(binaryPath, command, args, notFoundText)));
      tail = result.catch(() => undefined);
      return result;
    },
    async close() {
      closing = true;
      stopRunning?.();
      await tail;
    },
  };
}
