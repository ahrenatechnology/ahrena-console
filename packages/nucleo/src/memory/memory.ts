/*
 * The core's memory module (#727, #733, #734): what the core reads from the embedded ai-memory, through its
 * local CLI (the runner) and its `mcp-bridge` stdio channel (the bridge), field by field (the readers). A local
 * path (data_dir, db_path, config_path, a service path, a handoff's cwd) comes out only of a method whose name ends
 * in `Local` (#734/D1, #734/D2). This module only reads: the actions that change something (setup without --plan, stop, start,
 * deactivate, delete) are memory/actions.ts's, on the Tools queue, and serve is nobody's (#740, #719).
 */

import { embeddedAiMemoryPath, type RegisteredAccountFolder } from '../tools/embedded-ai-memory.ts';
import { createMemoryBridge, type MemoryBridgeResult } from './bridge.ts';
import { matchSession, readBridgeHandoffs, type MemoryBridgeHandoffsReading, type MemorySessionHandoff, type MemorySessionHandoffLocal, type MemorySessionHandoffs } from './bridge-readers.ts';
import {
  MemoryReadError,
  readHandoffs,
  readRecent,
  readSetupPlan,
  readStatus,
  readVersion,
  type MemoryHandoff,
  type MemoryHandoffLocal,
  type MemoryRecentPage,
  type MemorySetupPlan,
  type MemorySetupPlanLocal,
  type MemorySetupPlanReading,
  type MemoryStatus,
  type MemoryStatusLocal,
  type MemoryVersion,
} from './readers.ts';
import { createMemoryRunner, PROJECT_FORMAT, type MemoryCommand, type MemoryRunnerOptions, type MemoryRunResult } from './runner.ts';

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

/** What `status()` answers; a running server carries the shareable value when it fits, never the local part (#733/AC-1, #734/D2). */
export type MemoryStatusState = { state: 'unavailable' | 'stopped' | 'unknown' } | { state: 'running'; status?: MemoryStatus };
/** What `statusWithLocal()` answers: the shareable value and the local part of one run of `status`, for a local route only (#735). */
export type MemoryStatusWithLocalState = { state: 'unavailable' | 'stopped' | 'unknown' } | { state: 'running'; status?: MemoryStatus; local?: MemoryStatusLocal };
/** The handoffs a session opened and their local part (#735). */
export interface MemorySessionHandoffsWithLocal {
  opened: MemorySessionHandoff[];
  local: MemorySessionHandoffLocal[];
}

// An id of a session: a UUID or a harness's native id; no leading dash, no slash, no whitespace (#734/AC-3).
export const SESSION_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The workspace is a constant: the core has one (#733).
const WORKSPACE = 'default';
// The most open handoffs the bridge's list returns upstream; a project with more is read up to this cap (#734).
export const HANDOFF_LIST_LIMIT = 200;
// An offset past any session's observations: the answer proves the session exists and carries none of them (#734/AC-3).
const NO_OBSERVATIONS_OFFSET = 1_000_000;
const HANDOFF_LIST = 'memory_handoff_list';
const READ_OBSERVATIONS = 'memory_read_session_observations';

/** The memory module the core uses (#727). */
export interface MemoryModule {
  readonly available: boolean;
  version(): Promise<MemoryRead<MemoryVersion>>;
  /** The setup plan without any path (#734/D2). */
  setupPlan(): Promise<MemoryRead<MemorySetupPlan>>;
  /** LOCAL ONLY: the plan's data_dir, config_path and service path; never for MCP, an exporter, the hub or the remote contract (#734/D2). */
  setupPlanLocal(): Promise<MemoryRead<MemorySetupPlanLocal>>;
  /** LOCAL ONLY: the setup plan of one registered Claude account folder, with its local part (config_path); for the local actions route only (#740/AC-1). */
  setupPlanWithLocalFor(folder: RegisteredAccountFolder): Promise<MemoryRead<MemorySetupPlanReading>>;
  status(): Promise<MemoryStatusState>;
  /** LOCAL ONLY: data_dir and db_path of a running server; never for MCP, an exporter, the hub or the remote contract (#734/D2). */
  statusLocal(): Promise<MemoryRead<MemoryStatusLocal>>;
  /** LOCAL ONLY: `status()` and `statusLocal()` from one run of `status`; for a local route only (#735). */
  statusWithLocal(): Promise<MemoryStatusWithLocalState>;
  /** The project's open handoffs, five fields each; a project the server does not know is an empty list (#733/AC-2). */
  handoffs(project: string): Promise<MemoryRead<MemoryHandoff[]>>;
  /** LOCAL ONLY: the cwd of each open handoff, by id (#734/D1). */
  handoffsLocal(project: string): Promise<MemoryRead<MemoryHandoffLocal[]>>;
  /** The project's recent pages, without snippet; a project the server does not know is an empty list (#733/AC-3). */
  recent(project: string): Promise<MemoryRead<MemoryRecentPage[]>>;
  /** The project's open handoffs through the bridge, without any body field and without cwd (#734/AC-2). */
  bridgeHandoffs(project: string): Promise<MemoryRead<MemorySessionHandoff[]>>;
  /** LOCAL ONLY: the cwd, owner_user and accepted_by_user of each handoff the bridge lists, by id (#734/D1, #735/D2). */
  bridgeHandoffsLocal(project: string): Promise<MemoryRead<MemorySessionHandoffLocal[]>>;
  /** LOCAL ONLY: `bridgeHandoffs` and `bridgeHandoffsLocal` from one bridge call; for a local route only (#735). */
  bridgeHandoffsWithLocal(project: string): Promise<MemoryRead<MemoryBridgeHandoffsReading>>;
  /** The handoffs a session opened, matched by `from_session_id` only (#734). */
  sessionHandoffs(project: string, sessionId: string): Promise<MemoryRead<MemorySessionHandoffs>>;
  /** LOCAL ONLY: `sessionHandoffs` with the local part of those handoffs, from one bridge call; for a local route only (#735). */
  sessionHandoffsWithLocal(project: string, sessionId: string): Promise<MemoryRead<MemorySessionHandoffsWithLocal>>;
  /** Whether the session was captured; never its observations (#734/AC-3). */
  sessionCaptured(project: string, sessionId: string): Promise<MemoryRead<boolean>>;
  /** The core's shutdown: ends the running call and refuses the rest; wiring it in is the next sub-issue's (#727). */
  close(): Promise<void>;
}

export function createMemoryModule(options: MemoryModuleOptions): MemoryModule {
  const binaryPath = options.binaryPath === undefined ? embeddedAiMemoryPath() : options.binaryPath;
  const runner = createMemoryRunner({ ...options, binaryPath });
  const bridge = createMemoryBridge({ ...options, binaryPath });

  function interpret<T>(command: string, result: MemoryRunResult, reader: (stdout: string) => T, onNotFound?: T): MemoryRead<T> {
    if (result.kind === 'not-found' && onNotFound !== undefined) return { ok: true, value: onNotFound };
    if (result.kind !== 'ok') return { ok: false, reason: failure(result) };
    return reading(command, () => reader(result.stdout));
  }

  function reading<T>(command: string, read: () => T): MemoryRead<T> {
    try {
      return { ok: true, value: read() };
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
  const readStatusLocal = async (): Promise<MemoryRead<MemoryStatusLocal>> => {
    const result = await runner.run('status');
    const value = interpret('status', result, readStatus);
    return value.ok ? { ok: true, value: value.value.local } : value;
  };

  /** The ids a bridge call carries are checked before anything is spawned (#734/AC-3). */
  function validIds(tool: string, project: string, sessionId?: string): boolean {
    const valid = PROJECT_FORMAT.test(project) && (sessionId === undefined || SESSION_FORMAT.test(sessionId));
    if (!valid) options.log?.(`memory: bridge ${tool} failed invalid-argument`);
    return valid;
  }

  /** The project's open handoffs through the bridge, reprojected (#734/AC-2). */
  async function listHandoffs(project: string, sessionId?: string): Promise<MemoryRead<MemoryBridgeHandoffsReading>> {
    if (!validIds(HANDOFF_LIST, project, sessionId)) return { ok: false, reason: 'failed' };
    const result = await bridge.call(HANDOFF_LIST, { workspace: WORKSPACE, project, limit: HANDOFF_LIST_LIMIT });
    if (result.kind !== 'ok') return { ok: false, reason: bridgeFailure(result) };
    return reading(HANDOFF_LIST, () => readBridgeHandoffs(result.text));
  }

  /** One run of `status`: the state, and for a running server the value and the local part (#727/AC-3, #735). */
  async function readState(): Promise<MemoryStatusWithLocalState> {
    const result = await runner.run('status');
    if (result.kind === 'unavailable') return { state: 'unavailable' };
    if (result.kind === 'exit' && result.code !== null) return { state: 'stopped' };
    if (result.kind !== 'ok') return { state: 'unknown' };
    const reading = interpret('status', result, readStatus);
    return reading.ok ? { state: 'running', status: reading.value.status, local: reading.value.local } : { state: 'running' };
  }

  return {
    available: runner.available,
    close: async () => {
      await Promise.all([runner.close(), bridge.close()]);
    },
    version: () => read('version', readVersion),
    setupPlan: async () => {
      const result = await read('setup-plan', readSetupPlan);
      return result.ok ? { ok: true, value: result.value.plan } : result;
    },
    setupPlanLocal: async () => {
      const result = await read('setup-plan', readSetupPlan);
      return result.ok ? { ok: true, value: result.value.local } : result;
    },
    setupPlanWithLocalFor: async (folder) => interpret('setup-plan', await runner.runSetupPlanFor(folder), readSetupPlan),
    handoffs: async (project) => {
      const result = await readProject('handoffs', project, readHandoffs, { handoffs: [], local: [] });
      return result.ok ? { ok: true, value: result.value.handoffs } : result;
    },
    handoffsLocal: async (project) => {
      const result = await readProject('handoffs', project, readHandoffs, { handoffs: [], local: [] });
      return result.ok ? { ok: true, value: result.value.local } : result;
    },
    recent: (project) => readProject('recent', project, readRecent, []),
    statusLocal: readStatusLocal,
    status: async () => {
      const state = await readState();
      return state.state === 'running' ? { state: 'running', ...(state.status ? { status: state.status } : {}) } : state;
    },
    statusWithLocal: readState,
    bridgeHandoffs: async (project) => {
      const result = await listHandoffs(project);
      return result.ok ? { ok: true, value: result.value.handoffs } : result;
    },
    bridgeHandoffsLocal: async (project) => {
      const result = await listHandoffs(project);
      return result.ok ? { ok: true, value: result.value.local } : result;
    },
    bridgeHandoffsWithLocal: (project) => listHandoffs(project),
    sessionHandoffsWithLocal: async (project, sessionId) => {
      const result = await listHandoffs(project, sessionId);
      if (!result.ok) return result;
      const opened = matchSession(result.value.handoffs, sessionId).opened;
      const ids = new Set(opened.map((handoff) => handoff.id));
      return { ok: true, value: { opened, local: result.value.local.filter((item) => ids.has(item.id)) } };
    },
    sessionHandoffs: async (project, sessionId) => {
      const result = await listHandoffs(project, sessionId);
      return result.ok ? { ok: true, value: matchSession(result.value.handoffs, sessionId) } : result;
    },
    sessionCaptured: async (project, sessionId) => {
      if (!validIds(READ_OBSERVATIONS, project, sessionId)) return { ok: false, reason: 'failed' };
      const result = await bridge.call(
        READ_OBSERVATIONS,
        { workspace: WORKSPACE, project, session_id: sessionId, limit: 1, offset: NO_OBSERVATIONS_OFFSET },
        { expectedErrorMessage: `session ${sessionId} not found in ${WORKSPACE}/${project}`, discardResult: true },
      );
      if (result.kind === 'ok') return { ok: true, value: true };
      if (result.kind === 'rpc-error' && result.code === NOT_FOUND_CODE && result.expected) return { ok: true, value: false };
      return { ok: false, reason: bridgeFailure(result) };
    },
  };
}

// JSON-RPC "invalid params", the code of "session X not found" (#734/AC-3).
const NOT_FOUND_CODE = -32602;

function bridgeFailure(result: Exclude<MemoryBridgeResult, { kind: 'ok' }>): MemoryReadFailure {
  if (result.kind === 'unavailable' || result.kind === 'timeout') return result.kind;
  return result.kind === 'failed' && result.reason === 'exit' ? 'exit' : 'failed';
}

function failure(result: Exclude<MemoryRunResult, { kind: 'ok' }>): MemoryReadFailure {
  return result.kind === 'exit' || result.kind === 'timeout' || result.kind === 'unavailable' ? result.kind : 'failed';
}
