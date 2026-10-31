import { RUNTIME_MIGRATION_SQL } from '../../runtime/migration.ts';
// Migrações do esquema SQLite. A versão aplicada fica em `PRAGMA user_version`.
// Regra: migração publicada não muda; mudança de esquema é uma migração nova no fim da lista.

import type { DatabaseSync } from 'node:sqlite';
import { CONTEXT_ENGLISH_SQL, CONTEXT_MIGRATION_DESCRIPTION, CONTEXT_MIGRATION_SQL } from '../../context/migration.ts';
import {
  DECISIONS_ENGLISH_SQL,
  DECISIONS_MIGRATION_DESCRIPTION,
  DECISIONS_MIGRATION_SQL,
  rekeyDecisions,
} from '../../decisions/migration.ts';
import { renameLegacyGithubCacheKeys } from '../../github/sqlite-cache.ts';
import { migrateJsonToEnglish } from './english-json.ts';
import { TELEMETRY_MIGRATION_DESCRIPTION, TELEMETRY_MIGRATION_SQL } from '../../telemetry/migration.ts';
import { TOOLS_MIGRATION_DESCRIPTION, TOOLS_MIGRATION_SQL } from '../../tools/migration.ts';
import { INSTALLATION_SETTINGS_MIGRATION_DESCRIPTION, INSTALLATION_SETTINGS_MIGRATION_SQL } from '../../settings/migration.ts';

export interface Migration {
  version: number;
  description: string;
  sql: string;
  /** What SQL alone does not do (hashing, JSON), run after `sql` in the same transaction. */
  up?: (db: DatabaseSync) => void;
}

/**
 * #173 phase 5: the names of the reprocessings already done, old → new. A reprocessing done under
 * the old name stays done under the new one.
 */
export const REPROCESSING_NAMES: Readonly<Record<string, string>> = {
  'planos-e-decisoes-1': 'plans-and-decisions-1',
  'decisoes-ruido-1': 'decision-noise-1',
  'contexto-1': 'context-1',
};

const reprocessingNameCase = `CASE nome ${Object.entries(REPROCESSING_NAMES)
  .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
  .join(' ')} ELSE nome END`;

/** #173 phase 5: tables, columns, trigger and stored values in English (decision 0009). */
const ENGLISH_SCHEMA_SQL = `
  CREATE TABLE reprocessings (
    name TEXT PRIMARY KEY,
    done_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO reprocessings (name, done_at) SELECT ${reprocessingNameCase}, feito_em FROM reprocessamentos;
  DROP TABLE reprocessamentos;

  DROP TRIGGER events_seq_faltando;
  -- A process from before migration 8, with the database already open, writes without seq: the trigger fills it.
  CREATE TRIGGER events_seq_missing AFTER INSERT ON events WHEN NEW.seq IS NULL
  BEGIN
    UPDATE events SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM events) WHERE rowid = NEW.rowid;
  END;
  ${CONTEXT_ENGLISH_SQL}
  ${DECISIONS_ENGLISH_SQL}
`;

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
  // The decisions schema lives in their own folder (src/decisions/migration.ts).
  { version: 4, description: DECISIONS_MIGRATION_DESCRIPTION, sql: DECISIONS_MIGRATION_SQL },
  {
    version: 5,
    description: 'histórico dos planos da sessão (issue #131)',
    // Aditiva: tabela nova, um registro por plano da sessão. O plano gravado na versão 3 vira o
    // primeiro do histórico na próxima mudança dele.
    sql: `
      CREATE TABLE session_plan_history (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        source TEXT NOT NULL CHECK (source IN ('TodoWrite', 'Task', 'update_plan')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        result TEXT NOT NULL CHECK (result IN ('current', 'completed', 'abandoned')),
        steps TEXT NOT NULL DEFAULT '[]',
        done INTEGER NOT NULL,
        total INTEGER NOT NULL,
        current_step_id TEXT,
        changed_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, seq)
      ) STRICT;
    `,
  },
  {
    version: 6,
    description: 'reprocessamentos feitos uma vez por banco (#131)',
    // Aditiva: guarda o nome de cada reprocessamento de dados já feito (refazer o histórico de
    // planos e capturar as decisões das sessões importadas antes deles).
    sql: `
      CREATE TABLE reprocessamentos (
        nome TEXT PRIMARY KEY,
        feito_em TEXT NOT NULL
      ) STRICT;
    `,
  },
  // The context meter schema lives in its own folder (src/context/migration.ts).
  { version: 7, description: CONTEXT_MIGRATION_DESCRIPTION, sql: CONTEXT_MIGRATION_SQL },
  {
    version: 8,
    description: 'ordem de gravação dos eventos e índices do feed (#94)',
    // Aditiva: `seq` é a ordem em que o evento foi gravado (o ao vivo do feed pega o evento atrasado,
    // com createdAt mais velho). Os que já existem recebem o rowid, que é a ordem em que entraram.
    // Coluna própria, e não o rowid direto: o VACUUM pode renumerar o rowid de tabela sem INTEGER PRIMARY KEY.
    sql: `
      ALTER TABLE events ADD COLUMN seq INTEGER;
      UPDATE events SET seq = rowid;
      CREATE UNIQUE INDEX events_by_seq ON events (seq);
      CREATE INDEX events_by_created ON events (created_at, id);
      CREATE INDEX events_by_type ON events (type, created_at);
      CREATE INDEX events_by_tool ON events (tool_name, created_at);
      -- Um processo de antes da migração, com o banco já aberto, grava sem seq: o gatilho preenche.
      CREATE TRIGGER events_seq_faltando AFTER INSERT ON events WHEN NEW.seq IS NULL
      BEGIN
        UPDATE events SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM events) WHERE rowid = NEW.rowid;
      END;
    `,
  },
  // The telemetry samples schema lives in its own folder (src/telemetry/migration.ts).
  { version: 9, description: TELEMETRY_MIGRATION_DESCRIPTION, sql: TELEMETRY_MIGRATION_SQL },
  {
    version: 10,
    description: 'English schema: tables, columns, trigger and stored values (#173)',
    // Rebuilds the tables whose CHECK lists Portuguese values; the rows are copied with the values mapped.
    sql: ENGLISH_SCHEMA_SQL,
    up: (db) => {
      rekeyDecisions(db);
      renameLegacyGithubCacheKeys(db);
    },
  },
  {
    version: 11,
    description: 'English keys and values in the stored JSON (#173)',
    // `metadata` and `data`: the state machine's memory, the import cursor, the plan's extraction and
    // history, the panel's record on a decision, the synthetic events and the simulator's keys.
    sql: '',
    up: migrateJsonToEnglish,
  },
  // The installation's settings (#241) live in their own folder (src/settings/migration.ts).
  { version: 12, description: INSTALLATION_SETTINGS_MIGRATION_DESCRIPTION, sql: INSTALLATION_SETTINGS_MIGRATION_SQL },
  // The Tools checks schema lives in its own folder (src/tools/migration.ts).
  { version: 13, description: TOOLS_MIGRATION_DESCRIPTION, sql: TOOLS_MIGRATION_SQL },
  {
    version: 14,
    description: 'Provider-scoped session and account identity (#377)',
    sql: `
      ALTER TABLE sessions ADD COLUMN identity TEXT;
      ALTER TABLE sessions ADD COLUMN capabilities TEXT;
      ALTER TABLE sessions ADD COLUMN account_confidence TEXT NOT NULL DEFAULT 'unknown';
      UPDATE sessions SET identity = json_object('provider', 'claude', 'providerSessionId', id,
        'profileId', NULL, 'machineId', NULL, 'environmentId', NULL);
      CREATE UNIQUE INDEX sessions_by_identity ON sessions (
        json_extract(identity, '$.provider'), json_extract(identity, '$.providerSessionId'),
        COALESCE(json_extract(identity, '$.profileId'), ''), COALESCE(json_extract(identity, '$.machineId'), ''),
        COALESCE(json_extract(identity, '$.environmentId'), ''));
      ALTER TABLE accounts ADD COLUMN identity TEXT;
      ALTER TABLE accounts ADD COLUMN confidence TEXT NOT NULL DEFAULT 'unknown';
      UPDATE accounts SET identity = json_object('provider', 'claude', 'providerAccountId', account_uuid,
        'organizationId', organization_uuid, 'profileId', NULL, 'machineId', NULL, 'environmentId', NULL);
      CREATE UNIQUE INDEX accounts_by_identity ON accounts (
        json_extract(identity, '$.provider'), json_extract(identity, '$.providerAccountId'),
        COALESCE(json_extract(identity, '$.organizationId'), ''), COALESCE(json_extract(identity, '$.profileId'), ''),
        COALESCE(json_extract(identity, '$.machineId'), ''), COALESCE(json_extract(identity, '$.environmentId'), ''));
    `,
  },
  { version: 15, description: 'Durable managed runtime runs and requests (#383)', sql: RUNTIME_MIGRATION_SQL },
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
      m.up?.(db);
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
