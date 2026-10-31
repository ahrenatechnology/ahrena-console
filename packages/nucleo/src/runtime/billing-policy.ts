import { diagnoseBilling, type AuthDiagnostic, type BillingScope, type DiagnosticOptions, type ProbeReason } from './auth-probes.ts';

export type AdmissionState = 'eligible' | 'blocked' | 'unknown';
export type AdmissionReason = ProbeReason | 'scope_mismatch' | 'evidence_expired' | 'configuration_changed' |
  'api_auth' | 'not_authenticated' | 'extras_unverified' | 'quota_exhausted';
export interface BillingAdmission {
  state: AdmissionState;
  allowed: false;
  pauseQueue: true;
  reasons: AdmissionReason[];
  observedAt: number;
  expiresAt: number;
}
const BLOCKING = new Set<AdmissionReason>(['environment_override', 'config_override', 'api_auth',
  'not_authenticated', 'quota_exhausted', 'scope_mismatch', 'configuration_changed']);

function sameScope(left: BillingScope, right: BillingScope): boolean {
  return left.provider === right.provider && left.profileId === right.profileId &&
    left.accountId === right.accountId && left.configDir === right.configDir && left.cwd === right.cwd;
}

/** No provider-enforced extras-disabled proof is implemented. No caller boolean can grant it. */
export function evaluateBillingAdmission(scope: BillingScope, diagnostic: AuthDiagnostic, now = Date.now()): BillingAdmission {
  const reasons: AdmissionReason[] = [...diagnostic.reasons, 'extras_unverified'];
  if (!sameScope(scope, diagnostic.scope)) reasons.push('scope_mismatch');
  if (!Number.isFinite(now) || !Number.isFinite(diagnostic.observedAt) || !Number.isFinite(diagnostic.expiresAt) ||
      diagnostic.observedAt > now || diagnostic.expiresAt <= now || diagnostic.expiresAt - diagnostic.observedAt > 30_000) {
    reasons.push('evidence_expired');
  }
  if (diagnostic.auth.mode === 'api') reasons.push('api_auth');
  if (diagnostic.auth.mode === 'none') reasons.push('not_authenticated');
  if (diagnostic.auth.mode === 'unknown') reasons.push('auth_unverified');
  return refuse(reasons, now);
}

function refuse(reasons: AdmissionReason[], now: number): BillingAdmission {
  return { state: reasons.some(r => BLOCKING.has(r)) ? 'blocked' : 'unknown', allowed: false,
    pauseQueue: true, reasons: [...new Set(reasons)], observedAt: now, expiresAt: now };
}

export class BillingAdmissionError extends Error {
  readonly admission: BillingAdmission;
  constructor(admission: BillingAdmission) {
    super('Execução recusada: não foi possível comprovar uso somente da franquia.');
    this.name = 'BillingAdmissionError';
    this.admission = admission;
  }
}

export type ManagedOperation = 'launch' | 'resume' | 'turn';

/**
 * Runtime boundary for #383/#123/#384. Call immediately before EVERY launch/resume/new turn.
 * No inference callback exists while extras proof is unsupported, so this boundary cannot launch.
 * It re-reads local state, never caches grants, and pauses the owning queue before refusing.
 */
export class BillingAdmissionGate {
  private readonly exhausted = new Set<string>();

  /** Provider quota-exhausted events latch closed until explicit revalidation after reset. */
  quotaExhausted(scope: BillingScope): void { this.exhausted.add(this.key(scope)); }
  /** Only clears the local latch. It does not grant admission or resume a queue. */
  invalidate(scope: BillingScope): void { this.exhausted.delete(this.key(scope)); }

  async admit(operation: ManagedOperation, scope: BillingScope, options: DiagnosticOptions & {
    pauseQueue: (operation: ManagedOperation, admission: BillingAdmission) => void | Promise<void>;
  }): Promise<never> {
    const snapshot = { ...scope };
    const clock = options.now ?? Date.now;
    let admission: BillingAdmission;
    try {
      const first = await diagnoseBilling(snapshot, options);
      const second = await diagnoseBilling(snapshot, options);
      admission = evaluateBillingAdmission(scope, second, clock());
      if (first.revision !== second.revision || !sameScope(snapshot, scope)) {
        admission = refuse([...admission.reasons, 'configuration_changed'], clock());
      }
    } catch {
      admission = refuse(['probe_failed', 'extras_unverified'], clock());
    }
    if (this.exhausted.has(this.key(snapshot))) admission = refuse([...admission.reasons, 'quota_exhausted'], clock());
    await options.pauseQueue(operation, admission);
    throw new BillingAdmissionError(admission);
  }

  private key(scope: BillingScope): string { return JSON.stringify([scope.provider, scope.profileId, scope.accountId, scope.configDir]); }
}
