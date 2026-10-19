// Modelo de dados do núcleo: sessão, agente, evento, uso de tokens e preço.
// Segue o modelo do Claude Code Agent Monitor (benchmark interno do Agent Monitor, seção 3),
// com as regras copiadas, não o código. Datas são strings ISO 8601 em UTC (ordenáveis como texto).

export const SESSION_STATUSES = ['active', 'completed', 'error', 'abandoned'] as const;
/** Status persistido da sessão. "waiting" não é persistido: é uma camada sobre `awaitingInputSince`. */
export type SessionStatus = (typeof SESSION_STATUSES)[number];
/** Status que a interface mostra: o persistido, ou "waiting" quando há espera em aberto. */
export type DisplayStatus = SessionStatus | 'waiting';

export const AGENT_STATUSES = ['working', 'waiting', 'completed', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_TYPES = ['main', 'subagent'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AWAITING_REASONS = ['notification', 'interrupted', 'stop', 'session_start'] as const;
/**
 * Por que a sessão espera:
 * - `notification`: pedido de permissão ou de input; o agente está bloqueado. Urgente.
 * - `interrupted`: Esc, ou o watchdog viu que o turno morreu. Urgente.
 * - `stop`: o turno terminou e a vez é do usuário.
 * - `session_start`: CLI recém-aberta, esperando no prompt vazio.
 */
export type AwaitingReason = (typeof AWAITING_REASONS)[number];
export const URGENT_AWAITING_REASONS: readonly AwaitingReason[] = ['notification', 'interrupted'];

export type Metadata = Record<string, unknown>;

export interface Session {
  id: string;
  name: string | null;
  status: SessionStatus;
  cwd: string | null;
  model: string | null;
  /** Origem da sessão (ex.: `startup`, `resume`, `import`). */
  source: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Preenchido enquanto a sessão espera alguém; vira o status exibido "waiting". */
  awaitingInputSince: string | null;
  awaitingReason: AwaitingReason | null;
  /** Última atividade; ordena as listas. */
  updatedAt: string;
  metadata: Metadata;
}

export interface Agent {
  id: string;
  sessionId: string;
  name: string | null;
  type: AgentType;
  subagentType: string | null;
  status: AgentStatus;
  task: string | null;
  currentTool: string | null;
  parentAgentId: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  metadata: Metadata;
}

/** Tudo que acontece numa sessão. Chamada de ferramenta também é evento. */
export interface SessionEvent {
  /** Identificador estável; gravar o mesmo id duas vezes não duplica o evento. */
  id: string;
  sessionId: string;
  agentId: string | null;
  type: string;
  toolName: string | null;
  summary: string | null;
  data: unknown;
  createdAt: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  /** Escrita de cache com TTL de 5 minutos. */
  cacheWrite5m: number;
  /** Escrita de cache com TTL de 1 hora. */
  cacheWrite1h: number;
}

/**
 * Uso de tokens de uma sessão num bucket de preço.
 * A chave é (sessionId, model, speed, inferenceGeo, serviceTier, contextSize).
 */
export interface TokenUsage {
  sessionId: string;
  model: string;
  /** `standard` ou `fast`. */
  speed: string;
  /** Região de inferência (ex.: `us`); vazio quando não informada. */
  inferenceGeo: string;
  /** `standard`, `batch`, `workflow`... */
  serviceTier: string;
  /** Faixa de contexto quando o preço depende dela; vazio quando não. */
  contextSize: string;
  tokens: TokenCounts;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
  /** Piso acumulado depois de compactações: o total efetivo é `tokens + baseline` e nunca diminui. */
  baseline: TokenCounts;
  updatedAt: string;
}

export type TokenUsageKey = Pick<
  TokenUsage,
  'sessionId' | 'model' | 'speed' | 'inferenceGeo' | 'serviceTier' | 'contextSize'
>;

/**
 * Preço de um modelo, em US$ por milhão de tokens. `pattern` segue o `LIKE` do SQL
 * (`claude-opus-4%`); quando vários casam, vale o padrão mais longo.
 * Preços de cache nulos são derivados do input pelos multiplicadores padrão.
 */
export interface ModelPricing {
  pattern: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  cacheWrite5mPerMTok: number | null;
  cacheWrite1hPerMTok: number | null;
  updatedAt: string;
}

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/** Status que a interface mostra. A espera se sobrepõe ao status persistido, seja ele qual for. */
export function displayStatus(session: Pick<Session, 'status' | 'awaitingInputSince'>): DisplayStatus {
  return session.awaitingInputSince ? 'waiting' : session.status;
}

export function isUrgent(session: Pick<Session, 'awaitingInputSince' | 'awaitingReason'>): boolean {
  return (
    session.awaitingInputSince !== null &&
    session.awaitingReason !== null &&
    URGENT_AWAITING_REASONS.includes(session.awaitingReason)
  );
}

export class InvalidModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelError';
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function fail(entity: string, message: string): never {
  throw new InvalidModelError(`${entity}: ${message}`);
}

function requireId(entity: string, field: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) fail(entity, `${field} é obrigatório`);
}

function requireTimestamp(entity: string, field: string, value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    fail(entity, `${field} precisa ser data ISO 8601 em UTC, recebeu ${JSON.stringify(value)}`);
  }
}

function requireOneOf(entity: string, field: string, value: unknown, allowed: readonly string[], nullable = false): void {
  if (nullable && value === null) return;
  if (!allowed.includes(value as string)) fail(entity, `${field} inválido: ${JSON.stringify(value)}`);
}

function requireCount(entity: string, field: string, value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0) fail(entity, `${field} precisa ser inteiro >= 0`);
}

function requirePrice(entity: string, field: string, value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(entity, `${field} precisa ser número >= 0`);
}

// Os validadores ficam no modelo para que todo adaptador aplique as mesmas regras.

export function validateSession(s: Session): void {
  requireId('Session', 'id', s.id);
  requireOneOf('Session', 'status', s.status, SESSION_STATUSES);
  requireTimestamp('Session', 'startedAt', s.startedAt);
  requireTimestamp('Session', 'endedAt', s.endedAt, true);
  requireTimestamp('Session', 'awaitingInputSince', s.awaitingInputSince, true);
  requireOneOf('Session', 'awaitingReason', s.awaitingReason, AWAITING_REASONS, true);
  if ((s.awaitingInputSince === null) !== (s.awaitingReason === null)) {
    fail('Session', 'awaitingInputSince e awaitingReason andam juntos');
  }
  requireTimestamp('Session', 'updatedAt', s.updatedAt);
}

export function validateAgent(a: Agent): void {
  requireId('Agent', 'id', a.id);
  requireId('Agent', 'sessionId', a.sessionId);
  requireOneOf('Agent', 'type', a.type, AGENT_TYPES);
  requireOneOf('Agent', 'status', a.status, AGENT_STATUSES);
  requireTimestamp('Agent', 'startedAt', a.startedAt);
  requireTimestamp('Agent', 'endedAt', a.endedAt, true);
  requireTimestamp('Agent', 'updatedAt', a.updatedAt);
}

export function validateEvent(e: SessionEvent): void {
  requireId('SessionEvent', 'id', e.id);
  requireId('SessionEvent', 'sessionId', e.sessionId);
  requireId('SessionEvent', 'type', e.type);
  requireTimestamp('SessionEvent', 'createdAt', e.createdAt);
}

function validateCounts(entity: string, prefix: string, c: TokenCounts): void {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
    requireCount(entity, `${prefix}.${k}`, c?.[k]);
  }
}

export function validateTokenUsage(u: TokenUsage): void {
  requireId('TokenUsage', 'sessionId', u.sessionId);
  requireId('TokenUsage', 'model', u.model);
  for (const k of ['speed', 'inferenceGeo', 'serviceTier', 'contextSize'] as const) {
    if (typeof u[k] !== 'string') fail('TokenUsage', `${k} precisa ser texto (vazio quando não se aplica)`);
  }
  validateCounts('TokenUsage', 'tokens', u.tokens);
  validateCounts('TokenUsage', 'baseline', u.baseline);
  requireCount('TokenUsage', 'webSearchRequests', u.webSearchRequests);
  requireCount('TokenUsage', 'webFetchRequests', u.webFetchRequests);
  requireCount('TokenUsage', 'codeExecutionRequests', u.codeExecutionRequests);
  requireTimestamp('TokenUsage', 'updatedAt', u.updatedAt);
}

export function validateModelPricing(p: ModelPricing): void {
  requireId('ModelPricing', 'pattern', p.pattern);
  requirePrice('ModelPricing', 'inputPerMTok', p.inputPerMTok);
  requirePrice('ModelPricing', 'outputPerMTok', p.outputPerMTok);
  requirePrice('ModelPricing', 'cacheReadPerMTok', p.cacheReadPerMTok, true);
  requirePrice('ModelPricing', 'cacheWrite5mPerMTok', p.cacheWrite5mPerMTok, true);
  requirePrice('ModelPricing', 'cacheWrite1hPerMTok', p.cacheWrite1hPerMTok, true);
  requireTimestamp('ModelPricing', 'updatedAt', p.updatedAt);
}
