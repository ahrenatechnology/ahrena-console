import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeCursor } from '../changes/cursor.ts';
import { scopedEntityId } from '../identity.ts';
import { RuntimeError, sameRuntimeScope, type RuntimeScope, type RuntimeRun, type RuntimeRequest, type RuntimeResponse, type RuntimeCommand, type RuntimeOperation, type RunState } from './contracts.ts';

type Row = Record<string, unknown>;
function run(row: Row): RuntimeRun {
  return { id: row.id as string, provider: row.provider as RuntimeRun['provider'], accountId: row.account_id as string,
    profileId: row.profile_id as string, sessionId: row.session_id as string, turnId: row.turn_id as string, state: row.state as RunState, createdAt: row.created_at as number };
}
/** Uses the core's database and event feed. Transactions claim requests before any transport call.
 * A claimed request is NEVER retried automatically, even after disconnect/restart/transport error.
 * This store does not grant execution; only a future admitted adapter may produce active runs.
 */
export class SqliteRuntimeStore {
  private readonly db: DatabaseSync;
  private readonly changes?: ChangeCursor;
  constructor(db: DatabaseSync, changes?: ChangeCursor) { this.db = db; this.changes = changes; }
  getRun(id: string): RuntimeRun | null {
    const row = this.db.prepare('SELECT * FROM runtime_runs WHERE id = ?').get(id);
    return row ? run(row) : null;
  }
  listRuns(sessionId: string): RuntimeRun[] {
    return this.db.prepare('SELECT * FROM runtime_runs WHERE session_id = ? ORDER BY created_at DESC, id LIMIT 100').all(sessionId).map(run);
  }
  private transaction<T>(scope: RuntimeScope, fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try { result = fn(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.changes?.record({ type: 'state', key: scope.sessionId, sessionId: scope.sessionId, accountId: scope.accountId });
    return result;
  }
  /** A core restart is a disconnect, never permission to resend an uncertain command. */
  recoverDisconnected(now = Date.now()): number {
    const active = this.db.prepare("SELECT * FROM runtime_runs WHERE state IN ('prepared','running')").all().map(run);
    for (const record of active) this.transaction(record, () => {
      this.db.prepare("UPDATE runtime_runs SET state = 'transport_error' WHERE id = ?").run(record.id);
      this.db.prepare("UPDATE runtime_requests SET state = 'invalidated' WHERE run_id = ? AND state = 'pending'").run(record.id);
      this.event(record, record.id, null, 'runtime.transport_error', now);
    });
    return active.length;
  }
  private assertScope(scope: RuntimeScope): void {
    const row = this.db.prepare('SELECT identity, account_id, capabilities FROM sessions WHERE id = ?').get(scope.sessionId);
    const account = this.db.prepare('SELECT identity FROM accounts WHERE id = ?').get(scope.accountId);
    const identity = row && JSON.parse(row.identity as string);
    const accountIdentity = account && JSON.parse(account.identity as string);
    if (!row || !account || identity?.provider !== scope.provider || identity?.profileId !== scope.profileId ||
        accountIdentity?.provider !== scope.provider || accountIdentity?.profileId !== scope.profileId ||
        accountIdentity?.machineId !== identity.machineId || accountIdentity?.environmentId !== identity.environmentId ||
        row.account_id !== scope.accountId || JSON.parse(row.capabilities as string || 'null')?.mode !== 'managed') {
      throw new RuntimeError('scope_mismatch');
    }
  }
  private event(scope: RuntimeScope, runId: string, requestId: string | null, type: string, now: number, operation?: RuntimeOperation): void {
    // Only correlated lifecycle metadata: no prompts, answers, credentials or raw transport errors.
    const data = JSON.stringify({ provider: scope.provider, accountId: scope.accountId, profileId: scope.profileId,
      sessionId: scope.sessionId, runId, turnId: this.getRun(runId)?.turnId, requestId, ...(operation ? { operation } : {}) });
    this.db.prepare(`INSERT INTO events (id, session_id, agent_id, type, tool_name, summary, data, created_at, seq)
      VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events))`)
      .run(scopedEntityId(scope.sessionId, 'event', randomUUID()), scope.sessionId, type, data, new Date(now).toISOString());
  }
  createRun(scope: RuntimeScope, now = Date.now(), state: 'prepared' | 'blocked' = 'prepared'): RuntimeRun {
    return this.transaction(scope, () => {
      this.assertScope(scope);
      const record: RuntimeRun = { ...scope, id: randomUUID(), turnId: randomUUID(), state, createdAt: now };
      this.db.prepare('INSERT INTO runtime_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, scope.sessionId, scope.provider, scope.accountId, scope.profileId, record.turnId, state, now);
      this.event(scope, record.id, null, `runtime.${state}`, now, state === 'blocked' ? 'start' : undefined);
      return record;
    });
  }
  /** A refused command preserves its target run/request; no request is consumed or run changed. */
  recordRefusal(scope: RuntimeScope, runId: string | null, command: RuntimeCommand, now = Date.now()): string {
    if (command.operation === 'start') return this.createRun(scope, now, 'blocked').id;
    return this.transaction(scope, () => {
      this.assertScope(scope);
      const record = runId ? this.getRun(runId) : null;
      if (!record || !sameRuntimeScope(scope, record) ||
          !(command.operation === 'resume' ? ['interrupted', 'transport_error'] : ['running']).includes(record.state)) throw new RuntimeError('stale_run');
      if (command.operation === 'respond') this.assertResponse(scope, record.id, command.requestId, command.response, now);
      this.event(scope, record.id, command.operation === 'respond' ? command.requestId : null, 'runtime.command.blocked', now, command.operation);
      return record.id;
    });
  }
  transition(scope: RuntimeScope, runId: string, state: Exclude<RunState, 'prepared'>, now = Date.now()): void {
    this.transaction(scope, () => {
      this.assertScope(scope);
      const record = this.getRun(runId);
      if (!record || !sameRuntimeScope(scope, record) || !['prepared', 'running'].includes(record.state)) throw new RuntimeError('stale_run');
      if (state === 'running' && record.state !== 'prepared') throw new RuntimeError('stale_run');
      this.db.prepare('UPDATE runtime_runs SET state = ? WHERE id = ?').run(state, runId);
      if (state !== 'running') this.db.prepare("UPDATE runtime_requests SET state = 'invalidated' WHERE run_id = ? AND state = 'pending'").run(runId);
      this.event(scope, runId, null, `runtime.${state}`, now);
    });
  }
  request(scope: RuntimeScope, runId: string, kind: 'approval' | 'question', expiresAt: number, now = Date.now()): RuntimeRequest {
    return this.transaction(scope, () => {
      this.assertScope(scope);
      const record = this.getRun(runId);
      if (!record || !sameRuntimeScope(scope, record) || record.state !== 'running') throw new RuntimeError('stale_run');
      if (!['approval', 'question'].includes(kind) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new RuntimeError('invalid_request');
      const id = randomUUID();
      this.db.prepare("INSERT INTO runtime_requests VALUES (?, ?, ?, ?, ?, 'pending')").run(id, runId, record.turnId, kind, expiresAt);
      this.event(scope, runId, id, `runtime.${kind}.requested`, now);
      return { ...scope, id, requestId: id, runId, turnId: record.turnId, kind, expiresAt, state: 'pending' };
    });
  }
  nextTurn(scope: RuntimeScope, runId: string, now = Date.now()): string {
    return this.transaction(scope, () => {
      this.assertScope(scope);
      const record = this.getRun(runId);
      if (!record || !sameRuntimeScope(scope, record) || record.state !== 'running') throw new RuntimeError('stale_run');
      const turnId = randomUUID();
      this.db.prepare('UPDATE runtime_runs SET turn_id = ? WHERE id = ?').run(turnId, runId);
      this.db.prepare("UPDATE runtime_requests SET state = 'invalidated' WHERE run_id = ? AND state = 'pending'").run(runId);
      this.event(scope, runId, null, 'runtime.turn.started', now);
      return turnId;
    });
  }
  assertResponse(scope: RuntimeScope, runId: string, requestId: string, response: RuntimeResponse, now = Date.now()): void {
    this.assertScope(scope);
    const record = this.getRun(runId);
    const request = this.db.prepare('SELECT * FROM runtime_requests WHERE id = ? AND run_id = ?').get(requestId, runId);
    if (!Number.isSafeInteger(now) || !record || !sameRuntimeScope(scope, record) || record.state !== 'running' || !request ||
        request.turn_id !== record.turnId || request.state !== 'pending' || (request.expires_at as number) <= now ||
        request.kind !== response?.kind) throw new RuntimeError('stale_request');
    if (response.kind === 'approval' ? !['approve', 'deny'].includes(response.decision) :
        typeof response.answer !== 'string' || response.answer.length === 0 || response.answer.length > 4096) throw new RuntimeError('invalid_response');
  }
  claimResponse(scope: RuntimeScope, runId: string, requestId: string, response: RuntimeResponse, now = Date.now()): void {
    this.transaction(scope, () => {
      this.assertResponse(scope, runId, requestId, response, now);
      const updated = this.db.prepare("UPDATE runtime_requests SET state = 'claimed' WHERE id = ? AND state = 'pending' AND expires_at > ?").run(requestId, now);
      if (updated.changes !== 1) throw new RuntimeError('stale_request');
      this.event(scope, runId, requestId, `runtime.${response.kind}.claimed`, now);
    });
  }
}
