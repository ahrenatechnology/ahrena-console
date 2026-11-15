// `PermissionRequestRepository` on the core's SQLite (#618, layer 3). `save` is one transaction, and a save that would undo
// a step another reader already took is refused, so the decision is delivered once even to a reader holding a stale copy (#618)
// (#618/AC-2). The tool input is not here: the aggregate does not hold it (#618/AC-7).
import type { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../../adapters/sqlite/immediate-transaction.ts';
import { PermissionRefusal, PermissionRequest, type RequestState } from '../model.ts';
import type { PermissionRequestRepository } from '../ports.ts';

type Row = Record<string, unknown>;

const COLUMNS = ['id', 'session_id', 'tool_name', 'digest', 'summary', 'summary_truncated', 'cwd', 'permission_mode', 'terminal_only', 'created_at', 'expires_at', 'state', 'decision', 'reason', 'answered_by', 'channel', 'answered_at', 'settled_at', 'settled_by'] as const;
const OLDEST_FIRST = 'ORDER BY created_at, rowid';

/** The states a request may be saved into from the state the store holds: it only moves forward, once. (#618) */
const SETTLED_STATES: readonly RequestState[] = ['delivered', 'expired', 'withdrawn', 'answered_elsewhere', 'core_restarted'];

/** Why a save from `held` into `next` is refused, or `null` when it moves forward (or stays) from an open state. (#618) */
function refusalFor(held: RequestState, next: RequestState): 'already_answered' | 'already_delivered' | 'gone' | null {
  if (held === 'pending' && (next === 'pending' || next === 'answered' || SETTLED_STATES.includes(next))) return null;
  if (held === 'answered' && SETTLED_STATES.includes(next)) return null;
  if (next === 'answered' && (held === 'answered' || held === 'delivered')) return 'already_answered';
  return held === 'delivered' ? 'already_delivered' : 'gone';
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function restore(row: Row): PermissionRequest {
  return PermissionRequest.restore({
    id: row.id as string,
    sessionId: row.session_id as string,
    toolName: row.tool_name as string,
    digest: row.digest as string,
    summary: row.summary as string,
    summaryTruncated: row.summary_truncated === 1,
    cwd: row.cwd as string,
    permissionMode: toText(row.permission_mode),
    terminalOnly: row.terminal_only === 1,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    state: row.state as RequestState,
    decision: toText(row.decision) as PermissionRequest['decision'],
    reason: toText(row.reason),
    answeredBy: toText(row.answered_by),
    channel: toText(row.channel) as PermissionRequest['channel'],
    answeredAt: toNumber(row.answered_at),
    settledAt: toNumber(row.settled_at),
    settledBy: toText(row.settled_by) as PermissionRequest['settledBy'],
  });
}

function values(request: PermissionRequest): (string | number | null)[] {
  return [request.id, request.sessionId, request.toolName, request.digest, request.summary, request.summaryTruncated ? 1 : 0, request.cwd, request.permissionMode, request.terminalOnly ? 1 : 0, request.createdAt, request.expiresAt, request.state, request.decision, request.reason, request.answeredBy, request.channel, request.answeredAt, request.settledAt, request.settledBy];
}

export class SqlitePermissionRepository implements PermissionRequestRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Inserts the request, or updates the stored one when it moves forward from the state the store holds *now*, read and (#618)
   * written in one `BEGIN IMMEDIATE` transaction. A copy that would deliver, answer or close what was already delivered,
   * answered or closed throws `PermissionRefusal` (`already_delivered`, `already_answered` or `gone`) and writes nothing.
   */
  save(request: PermissionRequest): void {
    immediateTransaction(this.db, () => {
      const held = this.db.prepare('SELECT state FROM permission_requests WHERE id = ?').get(request.id);
      if (held === undefined) {
        this.db.prepare(`INSERT INTO permission_requests (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`).run(...values(request));
        return;
      }
      const heldState = held.state as RequestState;
      const refused = refusalFor(heldState, request.state);
      if (refused !== null) throw new PermissionRefusal(refused);
      // A step into a settled state writes the settling columns only: the copy may be stale and not hold the stored answer (#618/AC-2).
      const changed = SETTLED_STATES.includes(request.state)
        ? this.db.prepare('UPDATE permission_requests SET state = ?, settled_at = ?, settled_by = ? WHERE id = ? AND state = ?').run(request.state, request.settledAt, request.settledBy, request.id, heldState)
        : this.db.prepare(`UPDATE permission_requests SET ${COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND state = ?`).run(...values(request).slice(1), request.id, heldState);
      if (changed.changes !== 1) throw new PermissionRefusal('gone');
    });
  }

  find(sessionId: string, requestId: string): PermissionRequest | null {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ? AND session_id = ?').get(requestId, sessionId);
    return row === undefined ? null : restore(row);
  }

  listBySession(sessionId: string): PermissionRequest[] {
    return this.db.prepare(`SELECT * FROM permission_requests WHERE session_id = ? ${OLDEST_FIRST}`).all(sessionId).map(restore);
  }

  listOpen(): PermissionRequest[] {
    return this.db.prepare(`SELECT * FROM permission_requests WHERE state IN ('pending', 'answered') ${OLDEST_FIRST}`).all().map(restore);
  }

  clearReasonsSettledBefore(at: number): void {
    this.db.prepare('UPDATE permission_requests SET reason = NULL WHERE reason IS NOT NULL AND settled_at IS NOT NULL AND settled_at < ?').run(at);
  }

  linkToolUse(requestId: string, toolUseId: string): void {
    this.db.prepare('UPDATE permission_requests SET tool_use_id = ? WHERE id = ?').run(toolUseId, requestId);
  }

  toolUseOf(requestId: string): string | null {
    const row = this.db.prepare('SELECT tool_use_id FROM permission_requests WHERE id = ?').get(requestId);
    return row === undefined ? null : toText(row.tool_use_id);
  }
}
