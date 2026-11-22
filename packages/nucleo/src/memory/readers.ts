/*
 * Field-by-field readers for what the real ai-memory 3.5.1 binary confirmed (#727/AC-3). Each reader
 * builds a new object from the fields it names; anything else in the input is dropped, and an input
 * that does not fit is an error that carries a code, never the input.
 */

/** Why a reader refused its input; the error holds the code only (#727). */
export class MemoryReadError extends Error {
  readonly code: 'malformed-version' | 'malformed-plan' | 'unsupported-format';
  constructor(code: MemoryReadError['code']) {
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
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new MemoryReadError('malformed-plan');
  }
  const plan = asRecord(raw);
  if (plan.format !== SUPPORTED_PLAN_FORMAT) throw new MemoryReadError('unsupported-format');
  const service = asRecord(plan.service);
  return {
    data_dir: asString(plan.data_dir),
    config_path: asString(plan.config_path),
    fresh: asBoolean(plan.fresh),
    service: { action: asString(service.action), manager: asString(service.manager), path: asNullableString(service.path) },
    agents: asArray(plan.agents).map((item) => {
      const agent = asRecord(item);
      return { agent: asString(agent.agent), found: asBoolean(agent.found), wiring: asNullableString(agent.wiring) };
    }),
    other_agents: asArray(plan.other_agents).map(asString),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MemoryReadError('malformed-plan');
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new MemoryReadError('malformed-plan');
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryReadError('malformed-plan');
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new MemoryReadError('malformed-plan');
  return value;
}
