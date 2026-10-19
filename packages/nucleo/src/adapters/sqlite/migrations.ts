// Migrações do esquema SQLite. A versão aplicada fica em `PRAGMA user_version`.
// Regra: migração publicada não muda; mudança de esquema é uma migração nova no fim da lista.

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'sessões, agentes, eventos, uso de tokens e preços',
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'error', 'abandoned')),
        cwd TEXT,
        model TEXT,
        source TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        awaiting_input_since TEXT,
        awaiting_reason TEXT CHECK (awaiting_reason IN ('notification', 'interrupted', 'stop', 'session_start')),
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX sessions_by_updated ON sessions (updated_at DESC, id DESC);
      CREATE INDEX sessions_by_status ON sessions (status, updated_at DESC);

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT,
        type TEXT NOT NULL CHECK (type IN ('main', 'subagent')),
        subagent_type TEXT,
        status TEXT NOT NULL CHECK (status IN ('working', 'waiting', 'completed', 'error')),
        task TEXT,
        current_tool TEXT,
        parent_agent_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX agents_by_session ON agents (session_id, started_at, id);

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        type TEXT NOT NULL,
        tool_name TEXT,
        summary TEXT,
        data TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX events_by_session ON events (session_id, created_at, id);

      CREATE TABLE token_usage (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        speed TEXT NOT NULL,
        inference_geo TEXT NOT NULL,
        service_tier TEXT NOT NULL,
        context_size TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_5m_tokens INTEGER NOT NULL,
        cache_write_1h_tokens INTEGER NOT NULL,
        web_search_requests INTEGER NOT NULL,
        web_fetch_requests INTEGER NOT NULL,
        code_execution_requests INTEGER NOT NULL,
        baseline_input_tokens INTEGER NOT NULL,
        baseline_output_tokens INTEGER NOT NULL,
        baseline_cache_read_tokens INTEGER NOT NULL,
        baseline_cache_write_5m_tokens INTEGER NOT NULL,
        baseline_cache_write_1h_tokens INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, model, speed, inference_geo, service_tier, context_size)
      ) STRICT;

      CREATE TABLE model_pricing (
        pattern TEXT PRIMARY KEY,
        input_per_mtok REAL NOT NULL,
        output_per_mtok REAL NOT NULL,
        cache_read_per_mtok REAL,
        cache_write_5m_per_mtok REAL,
        cache_write_1h_per_mtok REAL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    description: 'contas do Claude e a conta de cada sessão (decisão 0006)',
    // Aditiva: as sessões que já existem ficam em "Sem conta" (account_id e account_source nulos).
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        account_uuid TEXT NOT NULL,
        organization_uuid TEXT NOT NULL,
        organization_name TEXT,
        organization_type TEXT,
        label TEXT,
        color TEXT,
        config_dirs TEXT NOT NULL DEFAULT '[]',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX accounts_by_first_seen ON accounts (first_seen_at, id);

      ALTER TABLE sessions ADD COLUMN account_id TEXT;
      ALTER TABLE sessions ADD COLUMN account_source TEXT
        CHECK (account_source IN ('env', 'config', 'transcript', 'desktop', 'profile'));
      CREATE INDEX sessions_by_account ON sessions (account_id, updated_at DESC, id DESC);
    `,
  },
  {
    version: 3,
    description: 'plano da sessão (item 1.9)',
    // Aditiva: tabela nova, um plano por sessão; os passos ficam em JSON, na ordem do plano.
    sql: `
      CREATE TABLE session_plans (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('TodoWrite', 'Task', 'update_plan')),
        steps TEXT NOT NULL DEFAULT '[]',
        done INTEGER NOT NULL,
        total INTEGER NOT NULL,
        current_step_id TEXT,
        changed_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
    `,
  },
];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * Aplica, em ordem, as migrações acima da versão do banco. Cada uma roda na sua transação:
 * se falhar, o banco fica na versão anterior. Devolve as versões aplicadas.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const current = schemaVersion(db);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (current > latest) {
    throw new Error(`banco na versão ${current}, mais nova que a deste código (${latest})`);
  }
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migração ${m.version} (${m.description}) falhou: ${(err as Error).message}`, { cause: err });
    }
    applied.push(m.version);
  }
  return applied;
}
