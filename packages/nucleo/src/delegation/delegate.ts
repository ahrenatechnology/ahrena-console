/*
 * The delegation use cases (#567): preview the prompt for an open alert, then open it in a Claude session.
 * Both ports are injected; nothing here touches a file, a command or the network.
 *
 * - `previewDelegation` builds the prompt and stores it; `delegate` sends the STORED prompt, never a rebuilt one.
 * - A preview stays stored after a successful open until it expires or is replaced: a second POST with the same
 *   `takenAt` reopens the same prompt.
 * - Every refusal returns before the launcher is called.
 */

import type { Diagnosis } from '../diagnosis/model.ts';
import type { Alert } from '../telemetry/model.ts';
import { URL_BUDGET, acceptsVia, SSH_HOST, type Via } from './model.ts';
import { delegationPrompt } from './prompt.ts';
import type { PreviewStore } from './preview-store.ts';

/** What the diagnosis port answers; a failure or a not-diagnosable alert is `unavailable` (#567). */
export type DiagnosisAnswer = { kind: 'ok'; diagnosis: Diagnosis } | { kind: 'unavailable' } | { kind: 'unknown-machine' } | { kind: 'alert-not-open' };

/** The stable reasons an SSH opening fails; never the command's text (#567). */
export type SshFailure = 'ssh-unreachable' | 'ssh-timeout';

export type LaunchResult = 'opened' | 'unsupported';
export type SshLaunchResult = 'opened' | 'unsupported' | { failed: SshFailure };

export interface Launcher {
  openDesktop(folder: string, prompt: string): Promise<LaunchResult>;
  openTerminal(folder: string, prompt: string): Promise<LaunchResult>;
  openSsh(host: string, prompt: string): Promise<SshLaunchResult>;
}

export interface DelegationDeps {
  /** The machine's open alerts; `AlertTracker` satisfies it (#567). */
  alerts: { active(machineId: string): Alert[] };
  isKnownMachine(machineId: string): boolean;
  diagnosis(machine: string, alertId: string): Promise<DiagnosisAnswer>;
  launcher: Launcher;
  previews: PreviewStore;
  /** The folder a local session opens in (the core user's home) (#567). */
  localFolder(): string;
  /** The current ISO instant (#567). */
  now(): string;
}

export interface DelegationRequest {
  machine: string;
  alertId: string;
}

export type PreviewResult =
  | { kind: 'ok'; prompt: string; size: number; truncated: boolean; takenAt: string }
  | { kind: 'unknown-machine' }
  | { kind: 'alert-not-open' };

export interface DelegateRequest extends DelegationRequest {
  via: Via;
  takenAt: string;
}

export type DelegateResult =
  | { kind: 'opened'; via: Via }
  | { kind: 'unknown-machine' }
  | { kind: 'alert-not-open' }
  | { kind: 'via-not-accepted' }
  | { kind: 'stale' }
  | { kind: 'too-large' }
  | { kind: 'unsupported' }
  | { kind: 'ssh-failed'; reason: SshFailure };

type Refusal = { kind: 'unknown-machine' } | { kind: 'alert-not-open' };

function openAlert(request: DelegationRequest, deps: DelegationDeps): { alert: Alert } | Refusal {
  if (!deps.isKnownMachine(request.machine)) return { kind: 'unknown-machine' };
  const alert = deps.alerts.active(request.machine).find((a) => a.id === request.alertId);
  return alert ? { alert } : { kind: 'alert-not-open' };
}

export async function previewDelegation(request: DelegationRequest, deps: DelegationDeps): Promise<PreviewResult> {
  const found = openAlert(request, deps);
  if ('kind' in found) return found;
  const answer = await deps.diagnosis(request.machine, request.alertId);
  if (answer.kind === 'unknown-machine' || answer.kind === 'alert-not-open') return { kind: answer.kind };
  const diagnosis = answer.kind === 'ok' ? answer.diagnosis : null;
  const takenAt = diagnosis ? diagnosis.takenAt : deps.now();
  const built = delegationPrompt({ alert: found.alert, diagnosis });
  deps.previews.save(request.machine, request.alertId, { prompt: built.prompt, takenAt }, Date.parse(deps.now()));
  return { kind: 'ok', prompt: built.prompt, size: built.size, truncated: built.truncated, takenAt };
}

export async function delegate(request: DelegateRequest, deps: DelegationDeps): Promise<DelegateResult> {
  const found = openAlert(request, deps);
  if ('kind' in found) return found;
  if (!acceptsVia(request.machine, request.via)) return { kind: 'via-not-accepted' };
  const stored = deps.previews.find(request.machine, request.alertId, Date.parse(deps.now()));
  if (!stored || stored.takenAt !== request.takenAt) return { kind: 'stale' };
  if (request.via === 'desktop' && encodeURIComponent(stored.prompt).length > URL_BUDGET) return { kind: 'too-large' };
  return launch(request.via, stored.prompt, deps);
}

async function launch(via: Via, prompt: string, deps: DelegationDeps): Promise<DelegateResult> {
  const { launcher } = deps;
  if (via === 'ssh') {
    const outcome = await launcher.openSsh(SSH_HOST, prompt);
    if (outcome === 'opened') return { kind: 'opened', via };
    return outcome === 'unsupported' ? { kind: 'unsupported' } : { kind: 'ssh-failed', reason: outcome.failed };
  }
  const outcome = via === 'desktop' ? await launcher.openDesktop(deps.localFolder(), prompt) : await launcher.openTerminal(deps.localFolder(), prompt);
  return outcome === 'opened' ? { kind: 'opened', via } : { kind: 'unsupported' };
}
