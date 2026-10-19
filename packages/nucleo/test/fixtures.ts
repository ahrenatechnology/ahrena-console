import { emptyTokenCounts, type Agent, type ClaudeAccount, type ModelPricing, type Session, type SessionEvent, type TokenUsage } from '../src/model.ts';

export const T0 = '2026-11-02T12:00:00.000Z';

export function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

export function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'ajuste do login',
    status: 'active',
    cwd: '/repo/app',
    model: 'claude-opus-5-5',
    source: 'startup',
    startedAt: T0,
    endedAt: null,
    awaitingInputSince: null,
    awaitingReason: null,
    updatedAt: T0,
    accountId: null,
    accountSource: null,
    metadata: {},
    ...over,
  };
}

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    sessionId: 's1',
    name: 'principal',
    type: 'main',
    subagentType: null,
    status: 'working',
    task: null,
    currentTool: null,
    parentAgentId: null,
    startedAt: T0,
    endedAt: null,
    updatedAt: T0,
    metadata: {},
    ...over,
  };
}

export function event(over: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    agentId: 'a1',
    type: 'PreToolUse',
    toolName: 'Bash',
    summary: 'npm test',
    data: { command: 'npm test' },
    createdAt: T0,
    ...over,
  };
}

export function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    sessionId: 's1',
    model: 'claude-opus-5-5',
    speed: 'standard',
    inferenceGeo: '',
    serviceTier: 'standard',
    contextSize: '',
    tokens: { input: 1000, output: 500, cacheRead: 20_000, cacheWrite5m: 3000, cacheWrite1h: 4000 },
    webSearchRequests: 0,
    webFetchRequests: 0,
    codeExecutionRequests: 0,
    baseline: emptyTokenCounts(),
    updatedAt: T0,
    ...over,
  };
}

export function pricing(over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    pattern: 'claude-opus-5%',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: null,
    cacheWrite5mPerMTok: null,
    cacheWrite1hPerMTok: null,
    updatedAt: T0,
    ...over,
  };
}

/** Conta sintética: UUIDs do bloco de exemplo, nenhum dado real. */
export function account(over: Partial<ClaudeAccount> & { n?: number } = {}): ClaudeAccount {
  const { n = 1, ...rest } = over;
  const accountUuid = rest.accountUuid ?? `00000000-0000-4000-8000-0000000000a${n}`;
  const organizationUuid = rest.organizationUuid ?? `00000000-0000-4000-8000-0000000000b${n}`;
  return {
    id: `${accountUuid}/${organizationUuid}`,
    accountUuid,
    organizationUuid,
    organizationName: `Org Exemplo ${n}`,
    organizationType: 'claude_max',
    label: `Conta ${n}`,
    color: null,
    configDirs: ['/simulacao/.claude'],
    firstSeenAt: T0,
    lastSeenAt: T0,
    metadata: {},
    ...rest,
  };
}
