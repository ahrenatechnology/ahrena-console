// SQLite schema of the decisions. It goes into the adapter's migration list (adapters/sqlite/migrations.ts)
// as a migration of its own, additive: it does not touch the tables that already exist.

export const DECISIONS_MIGRATION_DESCRIPTION = 'decisões da sessão e ligação de sessões em família (#99)';

export const DECISIONS_MIGRATION_SQL = `
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    family_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    repo TEXT,
    branch TEXT,
    topic TEXT,
    context TEXT,
    choice TEXT NOT NULL,
    alternatives TEXT NOT NULL DEFAULT '[]',
    decided_by TEXT NOT NULL CHECK (decided_by IN ('usuario', 'agente')),
    origin TEXT NOT NULL CHECK (origin IN ('pergunta', 'plano', 'permissao', 'correcao', 'sugerida')),
    inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('vigente', 'substituida', 'revertida', 'a_confirmar', 'descartada')),
    scope TEXT NOT NULL CHECK (scope IN ('sessao', 'familia', 'branch')),
    supersedes TEXT,
    superseded_by TEXT,
    message_uuid TEXT,
    message_tool_use_id TEXT,
    message_transcript_path TEXT,
    text_released INTEGER NOT NULL CHECK (text_released IN (0, 1)),
    promoted_to TEXT,
    decided_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
  CREATE INDEX decisions_by_session ON decisions (session_id, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_family ON decisions (family_id, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_branch ON decisions (branch, repo, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_family_seq ON decisions (family_id, seq);

  CREATE TABLE session_links (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('clear', 'compact', 'resume', 'filha')),
    linked_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX session_links_by_family ON session_links (family_id, linked_at, session_id);
`;
