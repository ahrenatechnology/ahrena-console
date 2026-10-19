// Adaptador SQLite da porta de armazenamento, com o `node:sqlite` embutido no Node (sem módulo nativo).

import { DatabaseSync } from 'node:sqlite';
import {
  validateAgent,
  validateEvent,
  validateModelPricing,
  validateSession,
  validateTokenUsage,
  type Agent,
  type ModelPricing,
  type Session,
  type SessionEvent,
  type TokenUsage,
} from '../../model.ts';
import {
  pageSize,
  type ListEventsQuery,
  type ListSessionsQuery,
  type Page,
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

function toSession(r: Row): Session {
  return {
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

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  async putSession(s: Session): Promise<void> {
    validateSession(s);
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, status, cwd, model, source, started_at, ended_at,
           awaiting_input_since, awaiting_reason, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, status = excluded.status, cwd = excluded.cwd, model = excluded.model,
           source = excluded.source, started_at = excluded.started_at, ended_at = excluded.ended_at,
           awaiting_input_since = excluded.awaiting_input_since, awaiting_reason = excluded.awaiting_reason,
           updated_at = excluded.updated_at, metadata = excluded.metadata`,
      )
      .run(
        s.id, s.name, s.status, s.cwd, s.model, s.source, s.startedAt, s.endedAt,
        s.awaitingInputSince, s.awaitingReason, s.updatedAt, json(s.metadata),
      );
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? toSession(row) : null;
  }

  async listSessions(query: ListSessionsQuery = {}): Promise<Page<Session>> {
    const limit = pageSize(query.limit);
    const where: string[] = [];
    const params: (string | number)[] = [];
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

  async putAgent(a: Agent): Promise<void> {
    validateAgent(a);
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

  async appendEvent(e: SessionEvent): Promise<boolean> {
    validateEvent(e);
    const result = this.db
      .prepare(
        `INSERT INTO events (id, session_id, agent_id, type, tool_name, summary, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        e.id, e.sessionId, e.agentId, e.type, e.toolName, e.summary,
        e.data === undefined || e.data === null ? null : JSON.stringify(e.data), e.createdAt,
      );
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
