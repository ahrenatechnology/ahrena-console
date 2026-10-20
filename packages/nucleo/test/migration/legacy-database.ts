// A database as the core wrote it before #173 phase 5: schema version 9, the Portuguese table,
// column and trigger names, and every Portuguese value the code stored. Written with raw SQL, the way
// the old code left it, so the migration test does not depend on today's code to build its input.

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate } from '../../src/adapters/sqlite/migrations.ts';
import { decisionId } from '../../src/decisions/registry.ts';

export const LEGACY_VERSION = 9;
export const T = '2026-10-01T12:00:00.000Z';

/** The values of each CHECK column, old → new. */
export const WINDOW_SOURCES = { modelo: 'model', sufixo: 'suffix', observado: 'observed' } as const;
export const DECIDERS = { usuario: 'user', agente: 'agent' } as const;
export const ORIGINS = { pergunta: 'question', plano: 'plan', permissao: 'permission', correcao: 'correction', sugerida: 'suggested' } as const;
export const STATES = { vigente: 'current', substituida: 'superseded', revertida: 'reverted', a_confirmar: 'to_confirm', descartada: 'dismissed' } as const;
export const SCOPES = { sessao: 'session', familia: 'family', branch: 'branch' } as const;
export const LINK_REASONS = { clear: 'clear', compact: 'compact', resume: 'resume', filha: 'child' } as const;
export const REPROCESSINGS = { 'planos-e-decisoes-1': 'plans-and-decisions-1', 'decisoes-ruido-1': 'decision-noise-1', 'contexto-1': 'context-1', 'outro-nome': 'outro-nome' } as const;

/** Topic keys, old → new: the prefix follows the origin. */
export const TOPICS = {
  plano: 'plan',
  'pergunta:banco nos testes': 'question:banco nos testes',
  'permissao:bash npm test': 'permission:bash npm test',
  'assunto:cards por coluna': 'subject:cards por coluna',
  'ajuste:dec:abc': 'adjust:dec:abc',
  'kanban:arrastar': 'kanban:arrastar',
} as const;

/** GitHub cache keys: the Portuguese ones go, the rest stays. */
export const CACHE_KEYS_DROPPED = ['repos:lista', 'repos:resumo', 'repos:detalhe:dono/repo:90d', 'painel:issue:dono/repo#3', 'repos:rest:dono/repo:runs:1a'];
export const CACHE_KEYS_KEPT = ['github:issues:is:open', 'repos:rest:dono/repo:languages', 'dev-console:issues:dono/repo'];

export const INFERRED_SESSION = 's-inf';
export const INFERRED_OLD_ID = decisionId(INFERRED_SESSION, 'inferida:u-7');
export const INFERRED_NEW_ID = decisionId(INFERRED_SESSION, 'inferred:u-7');
/** The panel's Adjust of the inferred decision: its source key (`painel:<id>:<time>`) and id stay. */
export const ADJUSTED_KEY = `painel:${INFERRED_OLD_ID}:2026-10-01T12:05:00.000Z`;
export const ADJUSTED_ID = decisionId(INFERRED_SESSION, ADJUSTED_KEY);

const keys = <O extends object>(o: O) => Object.keys(o) as (keyof O & string)[];

export interface LegacyDecision {
  id: string;
  sessionId: string;
  sourceKey: string;
  decidedBy: keyof typeof DECIDERS;
  origin: keyof typeof ORIGINS;
  state: keyof typeof STATES;
  scope: keyof typeof SCOPES;
  topic: keyof typeof TOPICS | null;
  supersedes: string | null;
  supersededBy: string | null;
  metadata: Record<string, unknown>;
}

/** One decision per value of each column (the longest list sets the count), plus the inferred chain. */
export function legacyDecisions(): LegacyDecision[] {
  const origins = keys(ORIGINS);
  const states = keys(STATES);
  const scopes = keys(SCOPES);
  const deciders = keys(DECIDERS);
  const topics = keys(TOPICS);
  const out: LegacyDecision[] = states.map((state, i) => {
    const origin = origins[i % origins.length]!;
    return {
      id: `dec:old-${i}`,
      sessionId: 's1',
      sourceKey: `tool:t${i}`,
      decidedBy: origin === 'sugerida' ? 'agente' : deciders[i % deciders.length]!,
      origin,
      state,
      scope: scopes[i % scopes.length]!,
      topic: topics[i % topics.length]!,
      supersedes: null,
      supersededBy: state === 'substituida' ? 'dec:old-0' : null,
      metadata: {},
    };
  });
  out.push({
    id: 'dec:old-topic',
    sessionId: 's1',
    sourceKey: 'tool:topic',
    decidedBy: 'usuario',
    origin: 'pergunta',
    state: 'vigente',
    scope: 'familia',
    topic: topics.at(-1)!,
    supersedes: null,
    supersededBy: null,
    metadata: {},
  });
  // A suggested decision from the small model, superseded by one the person adjusted from it.
  out.push({
    id: INFERRED_OLD_ID,
    sessionId: INFERRED_SESSION,
    sourceKey: 'inferida:u-7',
    decidedBy: 'agente',
    origin: 'sugerida',
    state: 'substituida',
    scope: 'familia',
    topic: 'assunto:cards por coluna',
    supersedes: null,
    supersededBy: ADJUSTED_ID,
    metadata: { painel: { acao: 'ajustar', por: 'usuario', sessao: INFERRED_SESSION, conta: null, em: T, antes: 'a_confirmar', nova: ADJUSTED_ID } },
  });
  out.push({
    id: ADJUSTED_ID,
    sessionId: INFERRED_SESSION,
    sourceKey: ADJUSTED_KEY,
    decidedBy: 'usuario',
    origin: 'correcao',
    state: 'vigente',
    scope: 'familia',
    topic: 'assunto:cards por coluna',
    supersedes: INFERRED_OLD_ID,
    supersededBy: null,
    metadata: { texto: 'cards por coluna: 8', ajusteDe: INFERRED_OLD_ID },
  });
  return out;
}

/** Creates the version 9 database at `path`, with rows in every table. Returns the row count per table. */
export function writeLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  migrate(db, MIGRATIONS.filter((m) => m.version <= LEGACY_VERSION));
  const run = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).run(...params);

  run(`INSERT INTO accounts (id, account_uuid, organization_uuid, organization_name, organization_type, label, color, config_dirs, first_seen_at, last_seen_at, metadata)
       VALUES ('acc/org', 'acc', 'org', 'Org', 'team', 'equipe', '#336699', '[]', ?, ?, '{}')`, T, T);
  for (const id of ['s1', 's2', INFERRED_SESSION]) {
    run(`INSERT INTO sessions (id, name, status, cwd, model, source, started_at, updated_at, account_id, account_source, metadata)
         VALUES (?, 'sessão', 'active', '/repo/app', 'claude-opus-5-5', 'startup', ?, ?, 'acc/org', 'transcript', '{}')`, id, T, T);
    run(`INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at, metadata)
         VALUES (?, ?, 'principal', 'main', 'working', ?, ?, '{}')`, `${id}:main`, id, T, T);
  }
  for (let i = 0; i < 4; i++) {
    run(`INSERT INTO events (id, session_id, agent_id, type, tool_name, summary, data, created_at)
         VALUES (?, 's1', 's1:main', 'PreToolUse', 'Bash', 'npm test', '{"command":"npm test"}', ?)`, `e${i}`, T);
  }
  run(`INSERT INTO token_usage VALUES ('s1', 'claude-opus-5-5', 'standard', 'global', 'standard', '200k', 10, 20, 30, 0, 0, 0, 0, 0, 10, 20, 30, 0, 0, ?)`, T);
  run(`INSERT INTO model_pricing VALUES ('claude-opus-5-5*', 5, 25, 0.5, 6.25, 10, ?)`, T);
  run(`INSERT INTO session_plans (session_id, source, steps, done, total, current_step_id, changed_at, metadata)
       VALUES ('s1', 'TodoWrite', '[{"id":"1","text":"passo","status":"pending"}]', 0, 1, '1', ?, '{}')`, T);
  run(`INSERT INTO session_plan_history (session_id, seq, source, started_at, ended_at, result, steps, done, total, current_step_id, changed_at, metadata)
       VALUES ('s1', 1, 'TodoWrite', ?, NULL, 'current', '[]', 0, 1, NULL, ?, '{}')`, T, T);
  for (const name of keys(REPROCESSINGS)) run('INSERT INTO reprocessamentos (nome, feito_em) VALUES (?, ?)', name, T);
  for (const [i, source] of keys(WINDOW_SOURCES).entries()) {
    run(`INSERT INTO context_meters (session_id, agent_key, model, used_tokens, window_tokens, window_source, compactions, compactions_transcript,
           compactions_hook, manual_compactions, manual_compactions_transcript, manual_compactions_hook, last_compaction_at, last_compaction_trigger, measured_at, updated_at)
         VALUES ('s1', ?, 'claude-opus-5-5', 1000, 200000, ?, 1, 1, 0, 0, 0, 0, ?, 'auto', ?, ?)`, i === 0 ? '' : `s1:a${i}`, source, T, T, T);
  }
  let seq = 0;
  for (const d of legacyDecisions()) {
    run(`INSERT INTO decisions (id, source_key, session_id, agent_id, family_id, seq, repo, branch, topic, context, choice, alternatives,
           decided_by, origin, inferred, state, scope, supersedes, superseded_by, message_uuid, message_tool_use_id, message_transcript_path,
           text_released, promoted_to, decided_at, updated_at, metadata)
         VALUES (?, ?, ?, NULL, ?, ?, '/repo/app', 'feat/x', ?, NULL, 'escolha', '[]', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, ?)`,
      d.id, d.sourceKey, d.sessionId, d.sessionId, ++seq, d.topic, d.decidedBy, d.origin, d.origin === 'sugerida' ? 1 : 0, d.state, d.scope,
      d.supersedes, d.supersededBy, T, T, JSON.stringify(d.metadata));
  }
  for (const [i, reason] of keys(LINK_REASONS).entries()) {
    run('INSERT INTO session_links (session_id, parent_session_id, family_id, reason, linked_at) VALUES (?, ?, ?, ?, ?)', `child-${i}`, 's1', 's1', reason, T);
  }
  run(`INSERT INTO telemetry_samples VALUES ('local', 1, 10, 1.5, 8, 1000, NULL, NULL, NULL, NULL, '{}')`);
  // The GitHub cache creates its own table, outside the migrations.
  db.exec('CREATE TABLE github_cache (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, etag TEXT) STRICT');
  for (const key of [...CACHE_KEYS_DROPPED, ...CACHE_KEYS_KEPT]) run('INSERT INTO github_cache VALUES (?, ?, 1, NULL)', key, '{}');
  db.close();
}

/** Rows per table, by the names of either schema. */
export function rowCounts(db: DatabaseSync): Record<string, number> {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
}
