/*
 * Field-by-field readers for what the real ai-memory 3.5.1 binary confirmed (#727/AC-3). Each reader
 * builds a new object from the fields it names; anything else in the input is dropped, and an input
 * that does not fit is an error that carries a code, never the input.
 */

/** The closed list of reasons a reader refuses (#727, #733). */
export type MemoryReadCode = 'malformed-version' | 'malformed-plan' | 'unsupported-format' | 'malformed-status' | 'malformed-handoffs' | 'malformed-recent';

/** Why a reader refused its input; the error holds the code only (#727). */
export class MemoryReadError extends Error {
  readonly code: MemoryReadCode;
  constructor(code: MemoryReadCode) {
    super(code);
    this.name = 'MemoryReadError';
    this.code = code;
  }
}

/** `ai-memory --version` (#727). */
export interface MemoryVersion {
  version: string;
}

/** The service part of `setup --plan --json` (#727). */
export interface MemoryServicePlan {
  action: string;
  manager: string;
  path: string | null;
}

/** One agent of `setup --plan --json` (#727). */
export interface MemoryAgentPlan {
  agent: string;
  found: boolean;
  wiring: string | null;
}

/** `setup --plan --json --agent claude-code`, format 1 (#727). */
export interface MemorySetupPlan {
  data_dir: string;
  config_path: string;
  fresh: boolean;
  service: MemoryServicePlan;
  agents: MemoryAgentPlan[];
  other_agents: string[];
}

const SUPPORTED_PLAN_FORMAT = 1;
const VERSION_LINE = /^ai-memory (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/** `ai-memory 3.5.1` -> `{ version: '3.5.1' }` (#727). */
export function readVersion(stdout: string): MemoryVersion {
  const match = VERSION_LINE.exec(stdout.trim());
  if (!match) throw new MemoryReadError('malformed-version');
  return { version: match[1]! };
}

/** Reprojects a format 1 setup plan; any other format or a malformed one throws (#727). */
export function readSetupPlan(stdout: string): MemorySetupPlan {
  const check = checks('malformed-plan');
  const plan = check.record(parseJson(stdout, 'malformed-plan'));
  if (plan.format !== SUPPORTED_PLAN_FORMAT) throw new MemoryReadError('unsupported-format');
  const service = check.record(plan.service);
  return {
    data_dir: check.string(plan.data_dir),
    config_path: check.string(plan.config_path),
    fresh: check.boolean(plan.fresh),
    service: { action: check.string(service.action), manager: check.string(service.manager), path: check.nullableString(service.path) },
    agents: check.array(plan.agents).map((item) => {
      const agent = check.record(item);
      return { agent: check.string(agent.agent), found: check.boolean(agent.found), wiring: check.nullableString(agent.wiring) };
    }),
    other_agents: check.array(plan.other_agents).map(check.string),
  };
}

function parseJson(text: string, code: MemoryReadCode): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MemoryReadError(code);
  }
}

/** The type checks of one reader; each failure carries that reader's code and never the value (#733). */
function checks(code: MemoryReadCode) {
  const fail = (): never => {
    throw new MemoryReadError(code);
  };
  const string = (value: unknown): string => (typeof value === 'string' ? value : fail());
  return {
    record: (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : fail()),
    array: (value: unknown): unknown[] => (Array.isArray(value) ? value : fail()),
    string,
    nullableString: (value: unknown): string | null => (value === null ? null : string(value)),
    boolean: (value: unknown): boolean => (typeof value === 'boolean' ? value : fail()),
    number: (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : fail()),
    nullableNumber: (value: unknown): number | null => (value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : fail()),
    oneOf: <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.find((item) => item === value) ?? fail(),
  };
}

/** A provider's health, as `status` states it (#733). */
export type MemoryProviderStatus = 'disabled' | 'unknown' | 'ok' | 'error';

/** The shareable part of `status --json`: no path, no token, no client auth value (#733/AC-1, #733/AC-4). */
export interface MemoryStatus {
  version: string;
  bind: string;
  counts: { pages_latest: number; pages_all: number; sessions: number; observations: number };
  storage: { database_bytes: number; data_dir_free_bytes: number | null };
  providers: { llm: { status: MemoryProviderStatus; provider: string | null; model: string | null }; embedding: { status: MemoryProviderStatus } };
  capture_mode: 'denylist' | 'allowlist';
  auth_posture: string;
  client_auth: 'on' | 'off';
}

/**
 * Local paths of `status --json`, for the local screen only (#733/AC-1). They must never reach MCP, an exporter, the hub or
 * the remote contract; the routes of #735 enforce that.
 */
export interface MemoryStatusLocal {
  data_dir: string;
  db_path: string;
}

/** What `readStatus` returns: the shareable part and the local-only part, held apart (#733/AC-1). */
export interface MemoryStatusReading {
  status: MemoryStatus;
  local: MemoryStatusLocal;
}

/** One open handoff, without its body (#733/AC-2). */
export interface MemoryHandoff {
  id: string;
  from_agent: string;
  to_agent: string | null;
  cwd: string | null;
  created_at_ms: number;
}

/** One recent page, without its snippet (#733/AC-3). */
export interface MemoryRecentPage {
  path: string;
  title: string;
  updated_at: string;
}

const PROVIDER_STATUSES = ['disabled', 'unknown', 'ok', 'error'] as const;
const CAPTURE_MODES = ['denylist', 'allowlist'] as const;

/** Reprojects `status --json` field by field; `client.auth` becomes "on" or "off" and no token field is read (#733/AC-1, #733/AC-4). */
export function readStatus(stdout: string): MemoryStatusReading {
  const check = checks('malformed-status');
  const raw = check.record(parseJson(stdout, 'malformed-status'));
  const counts = check.record(raw.counts);
  const storage = check.record(raw.storage);
  const providers = check.record(raw.providers);
  const llm = check.record(providers.llm);
  const embedding = check.record(providers.embedding);
  return {
    status: {
      version: check.string(raw.version),
      bind: check.string(raw.bind),
      counts: {
        pages_latest: check.number(counts.pages_latest),
        pages_all: check.number(counts.pages_all),
        sessions: check.number(counts.sessions),
        observations: check.number(counts.observations),
      },
      storage: { database_bytes: check.number(storage.database_bytes), data_dir_free_bytes: check.nullableNumber(storage.data_dir_free_bytes) },
      providers: {
        llm: { status: check.oneOf(llm.status, PROVIDER_STATUSES), provider: check.nullableString(llm.provider), model: check.nullableString(llm.model) },
        embedding: { status: check.oneOf(embedding.status, PROVIDER_STATUSES) },
      },
      capture_mode: check.oneOf(raw.capture_mode, CAPTURE_MODES),
      auth_posture: check.string(check.record(raw.auth_posture).posture),
      client_auth: check.boolean(check.record(raw.client).auth) ? 'on' : 'off',
    },
    local: { data_dir: check.string(raw.data_dir), db_path: check.string(raw.db_path) },
  };
}

/** Reprojects `handoffs --json` to the five listed fields; a handoff's body is never read (#733/AC-2). */
export function readHandoffs(stdout: string): MemoryHandoff[] {
  const check = checks('malformed-handoffs');
  return check.array(parseJson(stdout, 'malformed-handoffs')).map((item) => {
    const handoff = check.record(item);
    return {
      id: check.string(handoff.id),
      from_agent: check.string(handoff.from_agent),
      to_agent: check.nullableString(handoff.to_agent),
      cwd: check.nullableString(handoff.cwd),
      created_at_ms: check.number(handoff.created_at_ms),
    };
  });
}

/** Reprojects `recent --json` to path, title and updated_at; a page's snippet is never read (#733/AC-3). */
export function readRecent(stdout: string): MemoryRecentPage[] {
  const check = checks('malformed-recent');
  return check.array(parseJson(stdout, 'malformed-recent')).map((item) => {
    const page = check.record(item);
    return { path: check.string(page.path), title: check.string(page.title), updated_at: check.string(page.updated_at) };
  });
}
