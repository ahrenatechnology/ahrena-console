// Adaptador SQLite da porta das decisões. Usa o mesmo banco do adaptador de armazenamento
// (`SqliteStorage.db`), que já aplicou a migração das decisões.

import type { DatabaseSync } from 'node:sqlite';
import { pageSize, type Page } from '../storage-port.ts';
import { validateDecision, validateSessionLink, type Decision, type SessionLink } from './modelo.ts';
import type { DecisionPort, ListDecisionsQuery } from './porta.ts';

type Row = Record<string, unknown>;

function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === 2 && parts.every((p) => typeof p === 'string')) {
      return parts as [string, string];
    }
  } catch {
    // cai no erro abaixo
  }
  throw new RangeError('cursor inválido');
}

function toDecision(r: Row): Decision {
  return {
    id: r.id as string,
    sourceKey: r.source_key as string,
    sessionId: r.session_id as string,
    agentId: r.agent_id as string | null,
    familyId: r.family_id as string,
    seq: r.seq as number,
    repo: r.repo as string | null,
    branch: r.branch as string | null,
    topic: r.topic as string | null,
    context: r.context as string | null,
    choice: r.choice as string,
    alternatives: JSON.parse(r.alternatives as string),
    decidedBy: r.decided_by as Decision['decidedBy'],
    origin: r.origin as Decision['origin'],
    inferred: r.inferred === 1,
    state: r.state as Decision['state'],
    scope: r.scope as Decision['scope'],
    supersedes: r.supersedes as string | null,
    supersededBy: r.superseded_by as string | null,
    message: {
      uuid: r.message_uuid as string | null,
      toolUseId: r.message_tool_use_id as string | null,
      transcriptPath: r.message_transcript_path as string | null,
    },
    textReleased: r.text_released === 1,
    promotedTo: r.promoted_to as string | null,
    decidedAt: r.decided_at as string,
    updatedAt: r.updated_at as string,
    metadata: JSON.parse(r.metadata as string),
  };
}

function toLink(r: Row): SessionLink {
  return {
    sessionId: r.session_id as string,
    parentSessionId: r.parent_session_id as string,
    familyId: r.family_id as string,
    reason: r.reason as SessionLink['reason'],
    linkedAt: r.linked_at as string,
  };
}

export class SqliteDecisionStore implements DecisionPort {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get();
    if (!ok) throw new Error('banco sem a tabela de decisões: abra-o com o SqliteStorage, que aplica as migrações');
  }

  async putDecision(d: Decision): Promise<void> {
    validateDecision(d);
    this.db
      .prepare(
        `INSERT INTO decisions (id, source_key, session_id, agent_id, family_id, seq, repo, branch, topic, context,
           choice, alternatives, decided_by, origin, inferred, state, scope, supersedes, superseded_by,
           message_uuid, message_tool_use_id, message_transcript_path, text_released, promoted_to,
           decided_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           source_key = excluded.source_key, session_id = excluded.session_id, agent_id = excluded.agent_id,
           family_id = excluded.family_id, seq = excluded.seq, repo = excluded.repo, branch = excluded.branch,
           topic = excluded.topic, context = excluded.context, choice = excluded.choice,
           alternatives = excluded.alternatives, decided_by = excluded.decided_by, origin = excluded.origin,
           inferred = excluded.inferred, state = excluded.state, scope = excluded.scope,
           supersedes = excluded.supersedes, superseded_by = excluded.superseded_by,
           message_uuid = excluded.message_uuid, message_tool_use_id = excluded.message_tool_use_id,
           message_transcript_path = excluded.message_transcript_path, text_released = excluded.text_released,
           promoted_to = excluded.promoted_to, decided_at = excluded.decided_at, updated_at = excluded.updated_at,
           metadata = excluded.metadata`,
      )
      .run(
        d.id, d.sourceKey, d.sessionId, d.agentId, d.familyId, d.seq, d.repo, d.branch, d.topic, d.context,
        d.choice, JSON.stringify(d.alternatives), d.decidedBy, d.origin, d.inferred ? 1 : 0, d.state, d.scope,
        d.supersedes, d.supersededBy, d.message.uuid, d.message.toolUseId, d.message.transcriptPath,
        d.textReleased ? 1 : 0, d.promotedTo, d.decidedAt, d.updatedAt, JSON.stringify(d.metadata ?? {}),
      );
  }

  async getDecision(id: string): Promise<Decision | null> {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? toDecision(row) : null;
  }

  async listDecisions(query: ListDecisionsQuery): Promise<Page<Decision>> {
    const limit = pageSize(query.limit);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if ('sessionId' in query) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    } else if ('familyId' in query) {
      where.push('family_id = ?');
      params.push(query.familyId);
    } else {
      where.push('branch = ?');
      params.push(query.branch);
      if (query.repo !== undefined && query.repo !== null) {
        where.push('repo = ?');
        params.push(query.repo);
      }
    }
    if (query.states) {
      if (query.states.length === 0) return { items: [], nextCursor: null };
      where.push(`state IN (${query.states.map(() => '?').join(', ')})`);
      params.push(...query.states);
    }
    if (query.cursor) {
      const [decidedAt, id] = decodeCursor(query.cursor);
      where.push('(decided_at < ? OR (decided_at = ? AND id < ?))');
      params.push(decidedAt, decidedAt, id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY decided_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1);
    const items = rows.slice(0, limit).map(toDecision);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor([last.decidedAt, last.id]) : null };
  }

  async lastSeq(familyId: string): Promise<number> {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM decisions WHERE family_id = ?').get(familyId) as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  async putSessionLink(l: SessionLink): Promise<void> {
    validateSessionLink(l);
    this.db
      .prepare(
        `INSERT INTO session_links (session_id, parent_session_id, family_id, reason, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id,
           family_id = excluded.family_id, reason = excluded.reason, linked_at = excluded.linked_at`,
      )
      .run(l.sessionId, l.parentSessionId, l.familyId, l.reason, l.linkedAt);
  }

  async getSessionLink(sessionId: string): Promise<SessionLink | null> {
    const row = this.db.prepare('SELECT * FROM session_links WHERE session_id = ?').get(sessionId);
    return row ? toLink(row) : null;
  }

  async listSessionLinks(familyId: string): Promise<SessionLink[]> {
    return this.db
      .prepare('SELECT * FROM session_links WHERE family_id = ? ORDER BY linked_at, session_id')
      .all(familyId)
      .map(toLink);
  }
}
