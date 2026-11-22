/*
 * The core's memory module (#727, #733): what the core reads from the embedded ai-memory, and only
 * through its local CLI (the runner), field by field (the readers). No route, no write action: setup
 * without --plan, serve, start, stop, deactivate and delete are not here (#719).
 */

import { embeddedAiMemoryPath } from '../tools/embedded-ai-memory.ts';
import {
  MemoryReadError,
  readHandoffs,
  readRecent,
  readSetupPlan,
  readStatus,
  readVersion,
  type MemoryHandoff,
  type MemoryRecentPage,
  type MemorySetupPlan,
  type MemoryStatus,
  type MemoryStatusLocal,
  type MemoryVersion,
} from './readers.ts';
import { createMemoryRunner, type MemoryCommand, type MemoryRunnerOptions, type MemoryRunResult } from './runner.ts';

/** Why a read gave no value (#727). */
export type MemoryReadFailure = 'unavailable' | 'timeout' | 'exit' | 'failed' | 'rejected';
/** A read's answer: the reprojected value, or a reason with no detail of the process (#727). */
export type MemoryRead<T> = { ok: true; value: T } | { ok: false; reason: MemoryReadFailure };
/** The server's state as `status` shows it; only a non-zero exit is confirmed as stopped (#727/AC-3). */
export type MemoryState = 'unavailable' | 'stopped' | 'running' | 'unknown';

export interface MemoryModuleOptions extends Omit<MemoryRunnerOptions, 'binaryPath'> {
  /** Default: the embedded binary (#725). Tests pass a path or null (#727). */
  binaryPath?: string | null;
}

/** What `status()` answers; a running server carries the value when it fits, the local part held apart (#733/AC-1). */
export type MemoryStatusState =
  | { state: 'unavailable' | 'stopped' | 'unknown' }
  | { state: 'running'; status?: MemoryStatus; local?: MemoryStatusLocal };

/** The memory module the core uses (#727). */
export interface MemoryModule {
  readonly available: boolean;
  version(): Promise<MemoryRead<MemoryVersion>>;
  setupPlan(): Promise<MemoryRead<MemorySetupPlan>>;
  status(): Promise<MemoryStatusState>;
  /** The project's open handoffs, five fields each; a project the server does not know is an empty list (#733/AC-2). */
  handoffs(project: string): Promise<MemoryRead<MemoryHandoff[]>>;
  /** The project's recent pages, without snippet; a project the server does not know is an empty list (#733/AC-3). */
  recent(project: string): Promise<MemoryRead<MemoryRecentPage[]>>;
  /** The core's shutdown: ends the running call and refuses the rest; wiring it in is the next sub-issue's (#727). */
  close(): Promise<void>;
}

export function createMemoryModule(options: MemoryModuleOptions): MemoryModule {
  const runner = createMemoryRunner({ ...options, binaryPath: options.binaryPath === undefined ? embeddedAiMemoryPath() : options.binaryPath });

  function interpret<T>(command: MemoryCommand, result: MemoryRunResult, reader: (stdout: string) => T, onNotFound?: T): MemoryRead<T> {
    if (result.kind === 'not-found' && onNotFound !== undefined) return { ok: true, value: onNotFound };
    if (result.kind !== 'ok') return { ok: false, reason: failure(result) };
    try {
      return { ok: true, value: reader(result.stdout) };
    } catch (error) {
      if (error instanceof MemoryReadError) {
        options.log?.(`memory: ${command} rejected ${error.code}`);
        return { ok: false, reason: 'rejected' };
      }
      throw error;
    }
  }

  const read = async <T>(command: 'version' | 'setup-plan', reader: (stdout: string) => T): Promise<MemoryRead<T>> => interpret(command, await runner.run(command), reader);
  const readProject = async <T>(command: 'handoffs' | 'recent', project: string, reader: (stdout: string) => T, empty: T): Promise<MemoryRead<T>> =>
    interpret(command, await runner.run(command, project), reader, empty);

  return {
    available: runner.available,
    close: () => runner.close(),
    version: () => read('version', readVersion),
    setupPlan: () => read('setup-plan', readSetupPlan),
    handoffs: (project) => readProject('handoffs', project, readHandoffs, []),
    recent: (project) => readProject('recent', project, readRecent, []),
    async status() {
      const result = await runner.run('status');
      if (result.kind === 'unavailable') return { state: 'unavailable' };
      if (result.kind === 'exit' && result.code !== null) return { state: 'stopped' };
      if (result.kind !== 'ok') return { state: 'unknown' };
      const reading = interpret('status', result, readStatus);
      return reading.ok ? { state: 'running', status: reading.value.status, local: reading.value.local } : { state: 'running' };
    },
  };
}

function failure(result: Exclude<MemoryRunResult, { kind: 'ok' }>): MemoryReadFailure {
  return result.kind === 'exit' || result.kind === 'timeout' || result.kind === 'unavailable' ? result.kind : 'failed';
}
