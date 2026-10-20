// SQLite schema of the context meter (item 1.7). It joins the adapter's migration list
// (adapters/sqlite/migrations.ts) as a migration of its own, additive: it does not touch existing tables.

export const CONTEXT_MIGRATION_DESCRIPTION = 'medidor de contexto e estouros por sessão e agente (item 1.7)';

// `agent_key` is the meter's agent, with '' in place of the main one (the primary key does not accept null).
export const CONTEXT_MIGRATION_SQL = `
  CREATE TABLE context_meters (
    session_id TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    model TEXT,
    used_tokens INTEGER NOT NULL CHECK (used_tokens >= 0),
    window_tokens INTEGER NOT NULL CHECK (window_tokens > 0),
    window_source TEXT NOT NULL CHECK (window_source IN ('modelo', 'sufixo', 'observado')),
    compactions INTEGER NOT NULL CHECK (compactions >= 0),
    compactions_transcript INTEGER NOT NULL CHECK (compactions_transcript >= 0),
    compactions_hook INTEGER NOT NULL CHECK (compactions_hook >= 0),
    manual_compactions INTEGER NOT NULL CHECK (manual_compactions >= 0),
    manual_compactions_transcript INTEGER NOT NULL CHECK (manual_compactions_transcript >= 0),
    manual_compactions_hook INTEGER NOT NULL CHECK (manual_compactions_hook >= 0),
    last_compaction_at TEXT,
    last_compaction_trigger TEXT CHECK (last_compaction_trigger IN ('auto', 'manual')),
    measured_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, agent_key)
  ) STRICT;
`;
