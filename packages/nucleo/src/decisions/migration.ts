// SQLite schema of the decisions. It goes into the adapter's migration list (adapters/sqlite/migrations.ts)
// as a migration of its own, additive: it does not touch the tables that already exist.

import type { DatabaseSync } from 'node:sqlite';
import { decisionId } from './registry.ts';

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

// #173 phase 5: the stored values in English. SQLite does not change a CHECK, so both tables are
// rebuilt (new table, copy mapping the values, drop, rename) inside the migration's transaction.
// The topic keys change prefix with the values (`pergunta:` → `question:`); the inferred decisions'
// source key prefix changes too, and with it the decision's id, in `rekeyDecisions`.

export const DECISIONS_ENGLISH_SQL = `
  CREATE TABLE decisions_new (
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
    decided_by TEXT NOT NULL CHECK (decided_by IN ('user', 'agent')),
    origin TEXT NOT NULL CHECK (origin IN ('question', 'plan', 'permission', 'correction', 'suggested')),
    inferred INTEGER NOT NULL CHECK (inferred IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'reverted', 'to_confirm', 'dismissed')),
    scope TEXT NOT NULL CHECK (scope IN ('session', 'family', 'branch')),
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
  INSERT INTO decisions_new
    SELECT id, source_key, session_id, agent_id, family_id, seq, repo, branch,
      CASE
        WHEN topic = 'plano' THEN 'plan'
        WHEN substr(topic, 1, 9) = 'pergunta:' THEN 'question:' || substr(topic, 10)
        WHEN substr(topic, 1, 10) = 'permissao:' THEN 'permission:' || substr(topic, 11)
        WHEN substr(topic, 1, 8) = 'assunto:' THEN 'subject:' || substr(topic, 9)
        WHEN substr(topic, 1, 7) = 'ajuste:' THEN 'adjust:' || substr(topic, 8)
        ELSE topic
      END,
      context, choice, alternatives,
      CASE decided_by WHEN 'usuario' THEN 'user' WHEN 'agente' THEN 'agent' ELSE decided_by END,
      CASE origin
        WHEN 'pergunta' THEN 'question' WHEN 'plano' THEN 'plan' WHEN 'permissao' THEN 'permission'
        WHEN 'correcao' THEN 'correction' WHEN 'sugerida' THEN 'suggested' ELSE origin
      END,
      inferred,
      CASE state
        WHEN 'vigente' THEN 'current' WHEN 'substituida' THEN 'superseded' WHEN 'revertida' THEN 'reverted'
        WHEN 'a_confirmar' THEN 'to_confirm' WHEN 'descartada' THEN 'dismissed' ELSE state
      END,
      CASE scope WHEN 'sessao' THEN 'session' WHEN 'familia' THEN 'family' ELSE scope END,
      supersedes, superseded_by, message_uuid, message_tool_use_id, message_transcript_path,
      text_released, promoted_to, decided_at, updated_at, metadata
    FROM decisions;
  DROP TABLE decisions;
  ALTER TABLE decisions_new RENAME TO decisions;
  CREATE INDEX decisions_by_session ON decisions (session_id, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_family ON decisions (family_id, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_branch ON decisions (branch, repo, decided_at DESC, id DESC);
  CREATE INDEX decisions_by_family_seq ON decisions (family_id, seq);

  CREATE TABLE session_links_new (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('clear', 'compact', 'resume', 'child')),
    linked_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO session_links_new
    SELECT session_id, parent_session_id, family_id, CASE reason WHEN 'filha' THEN 'child' ELSE reason END, linked_at
    FROM session_links;
  DROP TABLE session_links;
  ALTER TABLE session_links_new RENAME TO session_links;
  CREATE INDEX session_links_by_family ON session_links (family_id, linked_at, session_id);
`;

/**
 * Source key prefixes, old → new. The panel's Adjust (`painel:<id>:<time>`) keeps its prefix: the
 * source key only feeds the hash of the id, and the id of a new adjustment is part of the API answer
 * the legacy goldens freeze.
 */
export const SOURCE_KEY_PREFIXES: Readonly<Record<string, string>> = { 'inferida:': 'inferred:' };

/**
 * The source keys with a Portuguese prefix (`inferida:<uuid>`) get the English one. The id comes from the source key (`decisionId`), so it changes with it, and so do the
 * references to it: `supersedes`, `superseded_by` and the ids the panel wrote in the metadata.
 */
export function rekeyDecisions(db: DatabaseSync): void {
  const setKey = db.prepare('UPDATE decisions SET id = ?, source_key = ? WHERE id = ?');
  const setSupersedes = db.prepare('UPDATE decisions SET supersedes = ? WHERE supersedes = ?');
  const setSupersededBy = db.prepare('UPDATE decisions SET superseded_by = ? WHERE superseded_by = ?');
  const withRef = db.prepare('SELECT id, metadata FROM decisions WHERE instr(metadata, ?) > 0');
  const setMetadata = db.prepare('UPDATE decisions SET metadata = ? WHERE id = ?');
  for (const [from, to] of Object.entries(SOURCE_KEY_PREFIXES)) {
    const rows = db
      .prepare('SELECT id, session_id, source_key FROM decisions WHERE substr(source_key, 1, ?) = ?')
      .all(from.length, from) as { id: string; session_id: string; source_key: string }[];
    for (const r of rows) {
      const sourceKey = to + r.source_key.slice(from.length);
      const id = decisionId(r.session_id, sourceKey);
      setKey.run(id, sourceKey, r.id);
      setSupersedes.run(id, r.id);
      setSupersededBy.run(id, r.id);
      for (const m of withRef.all(JSON.stringify(r.id)) as { id: string; metadata: string }[]) {
        setMetadata.run(JSON.stringify(replaceIdIn(JSON.parse(m.metadata), r.id, id)), m.id);
      }
    }
  }
}

function replaceIdIn(v: unknown, from: string, to: string): unknown {
  if (v === from) return to;
  if (Array.isArray(v)) return v.map((x) => replaceIdIn(x, from, to));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceIdIn(x, from, to)]));
  return v;
}
