import type { Provider } from '../identity.ts';

export const RUNTIME_OPERATIONS = ['start', 'resume', 'send', 'interrupt', 'close', 'respond'] as const;
export type RuntimeOperation = typeof RUNTIME_OPERATIONS[number];
export type RuntimeCapability = 'supported' | 'unsupported' | 'unknown';
export type RuntimeCapabilities = Record<RuntimeOperation, RuntimeCapability>;
export interface RuntimeScope {
  provider: Provider;
  accountId: string;
  profileId: string;
  sessionId: string;
}
export interface RuntimeCorrelation extends RuntimeScope { runId: string; turnId: string; requestId: string | null }
export type RuntimeResponse = { kind: 'approval'; decision: 'approve' | 'deny' } |
  { kind: 'question'; answer: string };
export type RuntimeCommand = { operation: 'start' | 'resume' | 'interrupt' | 'close' } |
  { operation: 'send'; message: string } |
  { operation: 'respond'; requestId: string; response: RuntimeResponse };
export type RuntimeResult = { status: 'accepted' } | { status: 'unsupported' } | { status: 'transport_error' };
/** Future adapters implement this contract. No production adapter is registered by #383. */
export interface RuntimeAdapter {
  readonly provider: Provider;
  readonly capabilities: Readonly<RuntimeCapabilities>;
  execute(scope: RuntimeCorrelation, command: RuntimeCommand): Promise<RuntimeResult>;
}
export type RunState = 'prepared' | 'running' | 'blocked' | 'interrupted' | 'closed' | 'transport_error';
export interface RuntimeRun extends RuntimeScope { id: string; turnId: string; state: RunState; createdAt: number }
export interface RuntimeRequest extends RuntimeCorrelation {
  id: string;
  kind: 'approval' | 'question';
  expiresAt: number;
  state: 'pending' | 'claimed' | 'invalidated';
}
export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string) { super('Operação do agente recusada.'); this.code = code; }
}
export function sameRuntimeScope(a: RuntimeScope, b: RuntimeScope): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.profileId === b.profileId && a.sessionId === b.sessionId;
}
export function unavailableCapabilities(): RuntimeCapabilities {
  return { start: 'unsupported', resume: 'unsupported', send: 'unsupported', interrupt: 'unsupported', close: 'unsupported', respond: 'unsupported' };
}
