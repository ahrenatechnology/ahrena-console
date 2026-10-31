import { legacySessionIdentity, unknownCapabilities, validateIdentity, isLegacyIdentity, scopedEntityPrefix, validateProviderMetadata, type SessionIdentity } from '../../identity.ts';
// Adaptador SQLite da porta de armazenamento, com o `node:sqlite` embutido no Node (sem módulo nativo).

import { DatabaseSync } from 'node:sqlite';
import {
  validateAgent,
  validateProviderAccount,
  validateEvent,
  validateModelPricing,
  validateSession,
  validateTokenUsage,
  type Agent,
  type ProviderAccount,
  type ModelPricing,
  type Session,
  type SessionEvent,
  type TokenUsage,
} from '../../model.ts';
import { validatePlan, validatePlanRecord, type PlanRecord, type SessionPlan } from '../../plan/model.ts';
import { validateContextMeter, type ContextMeter } from '../../context/model.ts';
import {
  pageSize,
  type EventFacets,
  type ListEventsQuery,
  type ListRecentEventsQuery,
  type ListSessionsQuery,
  type Page,
  type RecentEventsPage,
  type StoragePort,
} from '../../storage-port.ts';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from './migrations.ts';

export interface SqliteStorageOptions {
  /** Caminho do arquivo, ou `:memory:`. */
  path: string;
  /** Só para testes; o padrão é a lista oficial. */
  migrations?: readonly Migration[];
}

type Row = Record<string, unknown>;
function identityParts(i: SessionIdentity): (string | null)[] {
  return [i.provider, i.providerSessionId, i.profileId, i.machineId, i.environmentId];
}

function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

function decodeCursor(cursor: string, size: number): string[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === size && parts.every((p) => typeof p === 'string')) return parts;
  } catch {
    // cai no erro abaixo
  }
  throw new RangeError('cursor inválido');
}

const json = (v: unknown): string => JSON.stringify(v ?? {});

/**
 * Cursor do feed (#94): a posição `seq` de gravação e, na página para trás, o último `createdAt`/`id`
 * mostrado. No ao vivo vale só o `seq`; na página para trás, o `seq` é o maior que existia no
 * primeiro pedido (o que entrou depois vem pelo ao vivo).
 */
interface PosicaoDoFeed {
  seq: number;
  createdAt: string | null;
  id: string | null;
}

const encodeFeedCursor = (seq: number, createdAt: string | null = null, id: string | null = null): string =>
  encodeCursor(['f', String(seq), createdAt ?? '', id ?? '']);

function decodeFeedCursor(cursor: string): PosicaoDoFeed {
  const [marca, seq, createdAt, id] = decodeCursor(cursor, 4);
  if (marca !== 'f' || !/^\d{1,15}$/.test(seq) || (createdAt === '') !== (id === '')) throw new RangeError('cursor inválido');
  return { seq: Number(seq), createdAt: createdAt || null, id: id || null };
}

/** `%`, `_` e `\` viram literais no LIKE (com `ESCAPE '\'`). */
const literalNoLike = (texto: string): string => `%${texto.replace(/[\\%_]/g, '\\$&')}%`;

function filtrosDoFeed(q: ListRecentEventsQuery): { where: string[]; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (q.sessionId !== undefined) {
    where.push('session_id = ?');
    params.push(q.sessionId);
  }
  if (q.types) {
    where.push(q.types.length ? `type IN (${q.types.map(() => '?').join(', ')})` : '0');
    params.push(...q.types);
  }
  if (q.excludeTypes?.length) {
    where.push(`type NOT IN (${q.excludeTypes.map(() => '?').join(', ')})`);
    params.push(...q.excludeTypes);
  }
  if (q.toolName !== undefined) {
    where.push('tool_name = ?');
    params.push(q.toolName);
  }
  if (q.text) {
    where.push(`(summary LIKE ? ESCAPE '\\' OR tool_name LIKE ? ESCAPE '\\')`);
    params.push(literalNoLike(q.text), literalNoLike(q.text));
  }
  if (q.createdFrom !== undefined) {
    where.push('created_at >= ?');
    params.push(q.createdFrom);
  }
  if (q.createdUntil !== undefined) {
    where.push('created_at < ?');
    params.push(q.createdUntil);
  }
  return { where, params };
}

const maisNovoPrimeiro = (a: SessionEvent, b: SessionEvent): number =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1;

function toSession(r: Row): Session {
  return {
    identity: r.identity ? JSON.parse(r.identity as string) : legacySessionIdentity(r.id as string),
    capabilities: r.capabilities ? JSON.parse(r.capabilities as string) : unknownCapabilities(),
    accountConfidence: r.account_confidence as Session['accountConfidence'] ?? 'unknown',
    id: r.id as string,
    name: r.name as string | null,
    status: r.status as Session['status'],
    cwd: r.cwd as string | null,
    model: r.model as string | null,
    source: r.source as string | null,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    awaitingInputSince: r.awaiting_input_since as string | null,
    awaitingReason: r.awaiting_reason as Session['awaitingReason'],
    updatedAt: r.updated_at as string,
    accountId: r.account_id as string | null,
    accountSource: r.account_source as Session['accountSource'],
    metadata: JSON.parse(r.metadata as string),
  };
}

function toAccount(r: Row): ProviderAccount {
  return {
    identity: r.identity ? JSON.parse(r.identity as string) : undefined,
    confidence: r.confidence as ProviderAccount['confidence'] ?? 'unknown',
    id: r.id as string,
    accountUuid: r.account_uuid as string,
    organizationUuid: r.identity && JSON.parse(r.identity as string).organizationId === null ? null : r.organization_uuid as string,
    organizationName: r.organization_name as string | null,
    organizationType: r.organization_type as string | null,
    label: r.label as string | null,
    color: r.color as string | null,
    configDirs: JSON.parse(r.config_dirs as string),
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
    metadata: JSON.parse(r.metadata as string),
  };
}

function toAgent(r: Row): Agent {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    name: r.name as string | null,
    type: r.type as Agent['type'],
    subagentType: r.subagent_type as string | null,
    status: r.status as Agent['status'],
    task: r.task as string | null,
    currentTool: r.current_tool as string | null,
    parentAgentId: r.parent_agent_id as string | null,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    updatedAt: r.updated_at as string,
    metadata: JSON.parse(r.metadata as string),
  };
}

function toEvent(r: Row): SessionEvent {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentId: r.agent_id as string | null,
    type: r.type as string,
    toolName: r.tool_name as string | null,
    summary: r.summary as string | null,
    data: r.data === null ? null : JSON.parse(r.data as string),
    createdAt: r.created_at as string,
  };
}

function toTokenUsage(r: Row): TokenUsage {
  return {
    sessionId: r.session_id as string,
    model: r.model as string,
    speed: r.speed as string,
    inferenceGeo: r.inference_geo as string,
    serviceTier: r.service_tier as string,
    contextSize: r.context_size as string,
    tokens: {
      input: r.input_tokens as number,
      output: r.output_tokens as number,
      cacheRead: r.cache_read_tokens as number,
      cacheWrite5m: r.cache_write_5m_tokens as number,
      cacheWrite1h: r.cache_write_1h_tokens as number,
    },
    webSearchRequests: r.web_search_requests as number,
    webFetchRequests: r.web_fetch_requests as number,
    codeExecutionRequests: r.code_execution_requests as number,
    baseline: {
      input: r.baseline_input_tokens as number,
      output: r.baseline_output_tokens as number,
      cacheRead: r.baseline_cache_read_tokens as number,
      cacheWrite5m: r.baseline_cache_write_5m_tokens as number,
      cacheWrite1h: r.baseline_cache_write_1h_tokens as number,
    },
    updatedAt: r.updated_at as string,
  };
}

function toPlan(r: Row): SessionPlan {
  return {
    sessionId: r.session_id as string,
    source: r.source as SessionPlan['source'],
    steps: JSON.parse(r.steps as string),
    done: r.done as number,
    total: r.total as number,
    currentStepId: r.current_step_id as string | null,
    changedAt: r.changed_at as string,
    metadata: JSON.parse(r.metadata as string),
  };
}

function toPlanRecord(r: Row): PlanRecord {
  return {
    sessionId: r.session_id as string,
    seq: r.seq as number,
    source: r.source as PlanRecord['source'],
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    result: r.result as PlanRecord['result'],
    steps: JSON.parse(r.steps as string),
    done: r.done as number,
    total: r.total as number,
    currentStepId: r.current_step_id as string | null,
    changedAt: r.changed_at as string,
    metadata: JSON.parse(r.metadata as string),
  };
}

function toContextMeter(r: Row): ContextMeter {
  return {
    sessionId: r.session_id as string,
    agentId: r.agent_key === '' ? null : (r.agent_key as string),
    model: r.model as string | null,
    usedTokens: r.used_tokens as number,
    windowTokens: r.window_tokens as number,
    windowSource: r.window_source as ContextMeter['windowSource'],
    compactions: r.compactions as number,
    compactionsTranscript: r.compactions_transcript as number,
    compactionsHook: r.compactions_hook as number,
    manualCompactions: r.manual_compactions as number,
    manualCompactionsTranscript: r.manual_compactions_transcript as number,
    manualCompactionsHook: r.manual_compactions_hook as number,
    lastCompactionAt: r.last_compaction_at as string | null,
    lastCompactionTrigger: r.last_compaction_trigger as ContextMeter['lastCompactionTrigger'],
    measuredAt: r.measured_at as string | null,
    updatedAt: r.updated_at as string,
  };
}

function toModelPricing(r: Row): ModelPricing {
  return {
    pattern: r.pattern as string,
    inputPerMTok: r.input_per_mtok as number,
    outputPerMTok: r.output_per_mtok as number,
    cacheReadPerMTok: r.cache_read_per_mtok as number | null,
    cacheWrite5mPerMTok: r.cache_write_5m_per_mtok as number | null,
    cacheWrite1hPerMTok: r.cache_write_1h_per_mtok as number | null,
    updatedAt: r.updated_at as string,
  };
}

export class SqliteStorage implements StoragePort {
  readonly db: DatabaseSync;

  constructor(options: SqliteStorageOptions) {
    this.db = new DatabaseSync(options.path);
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    migrate(this.db, options.migrations ?? MIGRATIONS);
  }

  /** Was this data reprocessing already done in this database? Local adapter only, outside the port. */
  isReprocessed(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM reprocessings WHERE name = ?').get(name) !== undefined;
  }

  markReprocessed(name: string, doneAt: string): void {
    this.db.prepare('INSERT OR REPLACE INTO reprocessings (name, done_at) VALUES (?, ?)').run(name, doneAt);
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  async putSession(s: Session): Promise<void> {
    validateSession(s);
    const identity = s.identity ?? legacySessionIdentity(s.id);
    const existing = this.db.prepare('SELECT identity FROM sessions WHERE id = ?').get(s.id);
    if (existing?.identity && JSON.stringify(identityParts(JSON.parse(existing.identity as string))) !== JSON.stringify(identityParts(identity))) throw new Error('Session identity is immutable');
    if (s.accountId) {
      const account = this.db.prepare('SELECT identity FROM accounts WHERE id = ?').get(s.accountId);
      if (account?.identity) {
        const a = JSON.parse(account.identity as string);
        if (['provider', 'profileId', 'machineId', 'environmentId'].some(k => a[k] !== identity[k as keyof SessionIdentity])) throw new Error('Account scope differs from session');
      } else if (!isLegacyIdentity(identity) || s.accountId.startsWith('account:')) throw new Error('Scoped session requires an identified account');
    }
    if (!existing && (s.id.startsWith('session:') || !isLegacyIdentity(identity))) {
      for (const table of ['events', 'agents']) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? LIMIT 1`).get(s.id)) throw new Error('Cannot adopt orphan entities into a scoped session');
      }
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, status, cwd, model, source, started_at, ended_at,
           awaiting_input_since, awaiting_reason, updated_at, account_id, account_source, metadata, identity, capabilities, account_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, status = excluded.status, cwd = excluded.cwd, model = excluded.model,
           source = excluded.source, started_at = excluded.started_at, ended_at = excluded.ended_at,
           awaiting_input_since = excluded.awaiting_input_since, awaiting_reason = excluded.awaiting_reason,
           updated_at = excluded.updated_at, account_id = excluded.account_id,
           account_source = excluded.account_source, metadata = excluded.metadata,
           identity = excluded.identity, capabilities = excluded.capabilities, account_confidence = excluded.account_confidence`,
      )
      .run(
        s.id, s.name, s.status, s.cwd, s.model, s.source, s.startedAt, s.endedAt,
        s.awaitingInputSince, s.awaitingReason, s.updatedAt, s.accountId, s.accountSource, json(s.metadata),
        json(identity), json(s.capabilities ?? unknownCapabilities()), s.accountConfidence ?? 'unknown',
      );
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? toSession(row) : null;
  }

  async getSessionByIdentity(identity: SessionIdentity): Promise<Session | null> {
    validateIdentity(identity);
    const row = this.db.prepare(`SELECT * FROM sessions WHERE json_extract(identity, '$.provider') = ?
      AND json_extract(identity, '$.providerSessionId') = ?
      AND json_extract(identity, '$.profileId') IS ? AND json_extract(identity, '$.machineId') IS ?
      AND json_extract(identity, '$.environmentId') IS ?`).get(...identityParts(identity));
    return row ? toSession(row) : null;
  }

  async listSessions(query: ListSessionsQuery = {}): Promise<Page<Session>> {
    const limit = pageSize(query.limit);
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of ['provider', 'profileId', 'machineId', 'environmentId'] as const) {
      if (query[key] !== undefined) { where.push(`json_extract(identity, '$.${key}') IS ?`); params.push(query[key]!); }
    }
    if (query.status) {
      if (query.status.length === 0) return { items: [], nextCursor: null };
      where.push(`status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.awaiting !== undefined) {
      where.push(query.awaiting ? 'awaiting_input_since IS NOT NULL' : 'awaiting_input_since IS NULL');
    }
    if (query.cwd !== undefined) {
      where.push('cwd = ?');
      params.push(query.cwd);
    }
    if (query.accountIds) {
      if (query.accountIds.length === 0) return { items: [], nextCursor: null };
      const ids = query.accountIds.filter((id): id is string => id !== null);
      const any: string[] = [];
      if (ids.length) any.push(`account_id IN (${ids.map(() => '?').join(', ')})`);
      if (ids.length < query.accountIds.length) any.push('account_id IS NULL');
      where.push(`(${any.join(' OR ')})`);
      params.push(...ids);
    }
    if (query.cursor) {
      const [updatedAt, id] = decodeCursor(query.cursor, 2);
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(updatedAt, updatedAt, id);
    }
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(toSession);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor([last.updatedAt, last.id]) : null };
  }

  async putAccount(a: ProviderAccount): Promise<void> {
    validateProviderAccount(a);
    const identity = a.identity ?? { provider: 'claude', providerAccountId: a.accountUuid, organizationId: a.organizationUuid, profileId: null, machineId: null, environmentId: null };
    const existing = this.db.prepare('SELECT identity FROM accounts WHERE id = ?').get(a.id);
    if (existing?.identity) {
      const old = JSON.parse(existing.identity as string);
      if (Object.keys(identity).some(k => old[k] !== identity[k as keyof typeof identity])) throw new Error('Account identity is immutable');
    }
    this.db
      .prepare(
        `INSERT INTO accounts (id, account_uuid, organization_uuid, organization_name, organization_type,
           label, color, config_dirs, first_seen_at, last_seen_at, metadata, identity, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           account_uuid = excluded.account_uuid, organization_uuid = excluded.organization_uuid,
           organization_name = excluded.organization_name, organization_type = excluded.organization_type,
           label = excluded.label, color = excluded.color, config_dirs = excluded.config_dirs,
           first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at,
           metadata = excluded.metadata, identity = excluded.identity, confidence = excluded.confidence`,
      )
      .run(
        a.id, a.accountUuid, a.organizationUuid ?? '', a.organizationName, a.organizationType,
        a.label, a.color, JSON.stringify(a.configDirs), a.firstSeenAt, a.lastSeenAt, json(a.metadata), json(identity), a.confidence ?? 'unknown',
      );
  }

  async getAccount(id: string): Promise<ProviderAccount | null> {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? toAccount(row) : null;
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    return this.db.prepare('SELECT * FROM accounts ORDER BY first_seen_at, id').all().map(toAccount);
  }

  async putAgent(a: Agent): Promise<void> {
    validateAgent(a);
    this.validateEntityScope(a.sessionId, a.id, 'agent');
    this.validateAgentReference(a.sessionId, a.parentAgentId);
    if (a.sessionId.startsWith('session:')) validateProviderMetadata(a.metadata);
    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool,
           parent_agent_id, started_at, ended_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           session_id = excluded.session_id, name = excluded.name, type = excluded.type,
           subagent_type = excluded.subagent_type, status = excluded.status, task = excluded.task,
           current_tool = excluded.current_tool, parent_agent_id = excluded.parent_agent_id,
           started_at = excluded.started_at, ended_at = excluded.ended_at,
           updated_at = excluded.updated_at, metadata = excluded.metadata`,
      )
      .run(
        a.id, a.sessionId, a.name, a.type, a.subagentType, a.status, a.task, a.currentTool,
        a.parentAgentId, a.startedAt, a.endedAt, a.updatedAt, json(a.metadata),
      );
  }

  async getAgent(id: string): Promise<Agent | null> {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? toAgent(row) : null;
  }

  async listAgents(sessionId: string): Promise<Agent[]> {
    return this.db
      .prepare('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at, id')
      .all(sessionId)
      .map(toAgent);
  }

  private validateEntityScope(sessionId: string, id: string, kind: 'event' | 'agent'): void {
    const row = this.db.prepare('SELECT identity FROM sessions WHERE id = ?').get(sessionId);
    const scoped = sessionId.startsWith('session:') || (row?.identity && !isLegacyIdentity(JSON.parse(row.identity as string)));
    if (scoped) {
      if (!row) throw new Error('Scoped entities require an existing session');
      const prefix = scopedEntityPrefix(sessionId, kind);
      if (!id.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(id.slice(prefix.length))) throw new Error(`Scoped session requires a session-scoped ${kind} id`);
    }
    const table = kind === 'event' ? 'events' : 'agents';
    const existing = this.db.prepare(`SELECT session_id FROM ${table} WHERE id = ?`).get(id);
    if (existing && existing.session_id !== sessionId && (scoped || kind === 'agent' || String(existing.session_id).startsWith('session:'))) throw new Error(`${kind} belongs to another session`);
  }

  private validateAgentReference(sessionId: string, agentId: string | null): void {
    if (agentId === null) return;
    const agent = this.db.prepare('SELECT session_id FROM agents WHERE id = ?').get(agentId);
    if (agent && agent.session_id !== sessionId) throw new Error('Agent reference belongs to another session');
    if (sessionId.startsWith('session:')) this.validateEntityScope(sessionId, agentId, 'agent');
    else if (agentId.startsWith('agent:')) throw new Error('Scoped agent reference requires its session');
  }

  async appendEvent(e: SessionEvent): Promise<boolean> {
    validateEvent(e);
    this.validateEntityScope(e.sessionId, e.id, 'event');
    this.validateAgentReference(e.sessionId, e.agentId);
    const result = this.db
      .prepare(
        `INSERT INTO events (id, session_id, agent_id, type, tool_name, summary, data, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events)) ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        e.id, e.sessionId, e.agentId, e.type, e.toolName, e.summary,
        e.data === undefined || e.data === null ? null : JSON.stringify(e.data), e.createdAt,
      );
    return Number(result.changes) === 1;
  }

  async setEventText(id: string, text: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE events SET data = json_set(CASE WHEN json_type(data) = 'object' THEN data ELSE '{}' END, '$.text', ?) WHERE id = ?`,
      )
      .run(text, id);
    return Number(result.changes) === 1;
  }

  async listEvents(sessionId: string, query: ListEventsQuery = {}): Promise<Page<SessionEvent>> {
    const limit = pageSize(query.limit);
    const params: string[] = [sessionId];
    let after = '';
    if (query.cursor) {
      const [createdAt, id] = decodeCursor(query.cursor, 2);
      after = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(createdAt, createdAt, id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ${after} ORDER BY created_at, id LIMIT ?`)
      .all(...params, limit + 1);
    const items = rows.slice(0, limit).map(toEvent);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null };
  }

  // Tudo síncrono, sem `await` no meio: o maior `seq` e a página saem do mesmo instante do banco.
  async listRecentEvents(query: ListRecentEventsQuery = {}): Promise<RecentEventsPage> {
    const limit = pageSize(query.limit);
    if (query.after && query.before) throw new RangeError('after e before não combinam');
    const after = query.after ? decodeFeedCursor(query.after) : null;
    const before = query.before ? decodeFeedCursor(query.before) : null;
    const { where, params } = filtrosDoFeed(query);
    const maior = (this.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null }).m;

    if (after && query.after) {
      if (maior === null || maior <= after.seq) return { items: [], liveCursor: query.after, nextCursor: null };
      const rows = this.db
        .prepare(`SELECT * FROM events WHERE ${['seq > ?', ...where].join(' AND ')} ORDER BY seq LIMIT ?`)
        .all(after.seq, ...params, limit + 1);
      const lote = rows.slice(0, limit);
      // Mais novos que o limite: o cursor para no último entregue e o próximo pedido busca o resto.
      const ate = rows.length > limit ? (lote.at(-1)?.seq as number) : maior;
      return { items: lote.map(toEvent).sort(maisNovoPrimeiro), liveCursor: encodeFeedCursor(ate), nextCursor: null };
    }

    // Banco vazio: o ao vivo começa da posição 0, para o primeiro lote não virar uma página inicial.
    if (maior === null) return { items: [], liveCursor: encodeFeedCursor(0), nextCursor: null };
    const retrato = before ? before.seq : maior;
    const todos = ['seq <= ?', ...where];
    const antes: string[] = [];
    if (before?.createdAt && before.id) {
      todos.push('(created_at < ? OR (created_at = ? AND id < ?))');
      antes.push(before.createdAt, before.createdAt, before.id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${todos.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(retrato, ...params, ...antes, limit + 1);
    const items = rows.slice(0, limit).map(toEvent);
    const ultimo = items.at(-1);
    return {
      items,
      liveCursor: encodeFeedCursor(retrato),
      nextCursor: rows.length > limit && ultimo ? encodeFeedCursor(retrato, ultimo.createdAt, ultimo.id) : null,
    };
  }

  async listEventFacets(limit = 100): Promise<EventFacets> {
    const n = pageSize(limit);
    const types = this.db.prepare('SELECT DISTINCT type AS v FROM events ORDER BY type LIMIT ?').all(n);
    const tools = this.db.prepare('SELECT DISTINCT tool_name AS v FROM events WHERE tool_name IS NOT NULL ORDER BY tool_name LIMIT ?').all(n);
    return { types: types.map((r) => r.v as string), toolNames: tools.map((r) => r.v as string) };
  }

  async putTokenUsage(u: TokenUsage): Promise<void> {
    validateTokenUsage(u);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO token_usage (session_id, model, speed, inference_geo, service_tier, context_size,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
           web_search_requests, web_fetch_requests, code_execution_requests,
           baseline_input_tokens, baseline_output_tokens, baseline_cache_read_tokens,
           baseline_cache_write_5m_tokens, baseline_cache_write_1h_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.sessionId, u.model, u.speed, u.inferenceGeo, u.serviceTier, u.contextSize,
        u.tokens.input, u.tokens.output, u.tokens.cacheRead, u.tokens.cacheWrite5m, u.tokens.cacheWrite1h,
        u.webSearchRequests, u.webFetchRequests, u.codeExecutionRequests,
        u.baseline.input, u.baseline.output, u.baseline.cacheRead, u.baseline.cacheWrite5m, u.baseline.cacheWrite1h,
        u.updatedAt,
      );
  }

  async listTokenUsage(sessionId: string): Promise<TokenUsage[]> {
    return this.db
      .prepare(
        `SELECT * FROM token_usage WHERE session_id = ?
         ORDER BY model, speed, inference_geo, service_tier, context_size`,
      )
      .all(sessionId)
      .map(toTokenUsage);
  }

  async putPlan(p: SessionPlan): Promise<void> {
    validatePlan(p);
    this.db
      .prepare(
        `INSERT INTO session_plans (session_id, source, steps, done, total, current_step_id, changed_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           source = excluded.source, steps = excluded.steps, done = excluded.done, total = excluded.total,
           current_step_id = excluded.current_step_id, changed_at = excluded.changed_at, metadata = excluded.metadata`,
      )
      .run(p.sessionId, p.source, JSON.stringify(p.steps), p.done, p.total, p.currentStepId, p.changedAt, json(p.metadata));
  }

  async getPlan(sessionId: string): Promise<SessionPlan | null> {
    const row = this.db.prepare('SELECT * FROM session_plans WHERE session_id = ?').get(sessionId);
    return row ? toPlan(row) : null;
  }

  async putPlanRecord(r: PlanRecord): Promise<void> {
    validatePlanRecord(r);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_plan_history (session_id, seq, source, started_at, ended_at, result, steps, done, total,
           current_step_id, changed_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.sessionId, r.seq, r.source, r.startedAt, r.endedAt, r.result, JSON.stringify(r.steps), r.done, r.total,
        r.currentStepId, r.changedAt, json(r.metadata),
      );
  }

  async listPlanRecords(sessionId: string): Promise<PlanRecord[]> {
    return this.db.prepare('SELECT * FROM session_plan_history WHERE session_id = ? ORDER BY seq DESC').all(sessionId).map(toPlanRecord);
  }

  async deletePlanRecords(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM session_plan_history WHERE session_id = ?').run(sessionId);
  }

  async putContextMeter(m: ContextMeter): Promise<void> {
    validateContextMeter(m);
    this.db
      .prepare(
        `INSERT INTO context_meters (session_id, agent_key, model, used_tokens, window_tokens, window_source, compactions,
           compactions_transcript, compactions_hook, manual_compactions, manual_compactions_transcript, manual_compactions_hook,
           last_compaction_at, last_compaction_trigger, measured_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, agent_key) DO UPDATE SET
           model = excluded.model, used_tokens = excluded.used_tokens, window_tokens = excluded.window_tokens,
           window_source = excluded.window_source, compactions = excluded.compactions,
           compactions_transcript = excluded.compactions_transcript, compactions_hook = excluded.compactions_hook,
           manual_compactions = excluded.manual_compactions, manual_compactions_transcript = excluded.manual_compactions_transcript,
           manual_compactions_hook = excluded.manual_compactions_hook,
           last_compaction_at = excluded.last_compaction_at, last_compaction_trigger = excluded.last_compaction_trigger,
           measured_at = excluded.measured_at, updated_at = excluded.updated_at`,
      )
      .run(
        m.sessionId, m.agentId ?? '', m.model, m.usedTokens, m.windowTokens, m.windowSource, m.compactions,
        m.compactionsTranscript, m.compactionsHook, m.manualCompactions, m.manualCompactionsTranscript, m.manualCompactionsHook,
        m.lastCompactionAt, m.lastCompactionTrigger, m.measuredAt, m.updatedAt,
      );
  }

  async listContextMeters(sessionId: string): Promise<ContextMeter[]> {
    return this.db
      .prepare('SELECT * FROM context_meters WHERE session_id = ? ORDER BY agent_key')
      .all(sessionId)
      .map(toContextMeter);
  }

  async deleteContextMeters(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM context_meters WHERE session_id = ?').run(sessionId);
  }

  async putModelPricing(p: ModelPricing): Promise<void> {
    validateModelPricing(p);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO model_pricing (pattern, input_per_mtok, output_per_mtok, cache_read_per_mtok,
           cache_write_5m_per_mtok, cache_write_1h_per_mtok, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.pattern, p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok,
        p.cacheWrite5mPerMTok, p.cacheWrite1hPerMTok, p.updatedAt,
      );
  }

  async listModelPricing(): Promise<ModelPricing[]> {
    return this.db.prepare('SELECT * FROM model_pricing ORDER BY pattern').all().map(toModelPricing);
  }

  async deleteModelPricing(pattern: string): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM model_pricing WHERE pattern = ?').run(pattern).changes) === 1;
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}

export function openSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return new SqliteStorage(options);
}
