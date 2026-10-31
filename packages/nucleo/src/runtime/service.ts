import { isAbsolute } from 'node:path';
import type { StoragePort } from '../storage-port.ts';
import { BillingAdmissionGate, BillingAdmissionError, type BillingAdmission } from './billing-policy.ts';
import { RuntimeError, unavailableCapabilities, sameRuntimeScope, RUNTIME_OPERATIONS, type RuntimeCommand, type RuntimeScope } from './contracts.ts';
import { SqliteRuntimeStore } from './sqlite.ts';

/** Production boundary deliberately has no adapter registry, injected admission or enable flag.
 * #387 must supply provider-enforced extras proof before ANY transport can be wired here.
 */
export class ManagedRuntime {
  private readonly storage: Pick<StoragePort, 'getSession' | 'getAccount'>;
  private readonly runs: SqliteRuntimeStore;
  private readonly billing = new BillingAdmissionGate();
  constructor(storage: Pick<StoragePort, 'getSession' | 'getAccount'>, runs: SqliteRuntimeStore) {
    this.storage = storage; this.runs = runs;
  }
  async discover(sessionId: string) {
    const session = await this.storage.getSession(sessionId);
    if (!session) throw new RuntimeError('session_not_found');
    return { sessionId, provider: session.identity?.provider ?? 'claude', mode: session.capabilities?.mode ?? 'unknown',
      capabilities: unavailableCapabilities(), allowed: false, reason: 'extras_unverified', runs: this.runs.listRuns(sessionId) };
  }
  async execute(sessionId: string, command: RuntimeCommand, runId: string | null, ownerValid: () => boolean): Promise<never> {
    if (!ownerValid()) throw new RuntimeError('owner_required');
    if (!RUNTIME_OPERATIONS.includes(command.operation)) throw new RuntimeError('invalid_command');
    const session = await this.storage.getSession(sessionId);
    // Never take over a discovered/external session, even if its provider advertises controls.
    if (!session || session.capabilities?.mode !== 'managed') throw new RuntimeError('unmanaged_session');
    const identity = session.identity;
    const account = session.accountId ? await this.storage.getAccount(session.accountId) : null;
    const accountIdentity = account?.identity;
    if (!identity?.profileId || !account || !accountIdentity || identity.provider !== accountIdentity.provider ||
        identity.profileId !== accountIdentity.profileId || identity.machineId !== accountIdentity.machineId ||
        identity.environmentId !== accountIdentity.environmentId || session.accountConfidence !== 'confirmed' ||
        account.confidence !== 'confirmed' || !session.cwd || !isAbsolute(session.cwd) ||
        account.configDirs.length !== 1 || !isAbsolute(account.configDirs[0])) throw new RuntimeError('scope_unverified');
    const scope: RuntimeScope = { provider: identity.provider, profileId: identity.profileId, accountId: account.id, sessionId };
    if (command.operation !== 'start') {
      const run = runId ? this.runs.getRun(runId) : null;
      if (!run || !sameRuntimeScope(scope, run) ||
          !(command.operation === 'resume' ? ['interrupted', 'transport_error'] : ['running']).includes(run.state)) throw new RuntimeError('stale_run');
      if (command.operation === 'respond') this.runs.assertResponse(scope, run.id, command.requestId, command.response);
    }
    // These are persisted hints for a read-only diagnostic, NOT proof of a current provider login.
    const billingScope = { ...scope, configDir: account.configDirs[0], cwd: session.cwd };
    if (!ownerValid()) throw new RuntimeError('owner_required');
    // Every command, including approval, interrupt and close, enters the same fail-closed gate.
    // No request is claimed and no user content is persisted on billing refusal.
    try {
      await this.billing.admit(command.operation === 'start' ? 'launch' : command.operation === 'resume' ? 'resume' : 'turn', billingScope, {
        pauseQueue: () => {}, // No scheduler exists here (#385); refusal cannot dispatch or retry.
      });
    } catch (error) {
      if (!(error instanceof BillingAdmissionError)) throw error;
      if (!ownerValid()) throw new RuntimeError('owner_required');
      const current = await this.storage.getSession(sessionId);
      const currentAccount = await this.storage.getAccount(account.id);
      if (!ownerValid()) throw new RuntimeError('owner_required');
      if (JSON.stringify(current) !== JSON.stringify(session) || JSON.stringify(currentAccount) !== JSON.stringify(account)) throw new RuntimeError('scope_changed');
      // Refusals keep the original command correlation without claiming or changing its run.
      const blockedRunId = this.runs.recordRefusal(scope, runId, command);
      throw new RuntimeBlockedError(error.admission, blockedRunId);
    }
    // Defensive invariant if a later billing implementation changes. Still no transport path.
    throw new RuntimeError('adapter_unavailable');
  }
}
export class RuntimeBlockedError extends Error {
  readonly admission: BillingAdmission;
  readonly runId: string;
  constructor(admission: BillingAdmission, runId: string) {
    super('Execução bloqueada: uso somente da franquia ainda não comprovado.');
    this.admission = admission; this.runId = runId;
  }
}
