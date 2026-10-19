// Grava um hook normalizado pela porta de armazenamento.
// Além do evento, garante um registro mínimo da sessão (para ela aparecer nas listas) e mantém
// `updatedAt`, `cwd` e `model` em dia. Status, espera e agentes não mudam aqui: são da máquina de
// estados (item 1.5), que pode se pendurar no `onEvent` do receptor.

import type { Session } from '../../model.ts';
import type { StoragePort } from '../../storage-port.ts';
import { normalizeHook, type NormalizeOptions, type NormalizedHook } from './normalize.ts';

export interface IngestResult extends NormalizedHook {
  /** `false` quando o evento já existia (entrega repetida). */
  appended: boolean;
  /** `true` quando a sessão nasceu deste evento. */
  sessionCreated: boolean;
}

export async function ingestHook(storage: StoragePort, raw: unknown, opts: NormalizeOptions): Promise<IngestResult> {
  const normalized = normalizeHook(raw, opts);
  const { event, hints } = normalized;

  const current = await storage.getSession(event.sessionId);
  let sessionCreated = false;
  if (!current) {
    const created: Session = {
      id: event.sessionId,
      name: null,
      status: 'active',
      cwd: hints.cwd,
      model: hints.model,
      source: hints.source,
      startedAt: event.createdAt,
      endedAt: null,
      awaitingInputSince: null,
      awaitingReason: null,
      updatedAt: event.createdAt,
      metadata: hookMetadata({}, hints),
    };
    await storage.putSession(created);
    sessionCreated = true;
  } else {
    const next: Session = {
      ...current,
      cwd: current.cwd ?? hints.cwd,
      model: hints.model ?? current.model,
      source: current.source ?? hints.source,
      // Eventos chegam fora de ordem às vezes; a última atividade nunca anda para trás.
      updatedAt: event.createdAt > current.updatedAt ? event.createdAt : current.updatedAt,
      metadata: hookMetadata(current.metadata, hints),
    };
    if (changed(current, next)) await storage.putSession(next);
  }

  const appended = await storage.appendEvent(event);
  return { ...normalized, appended, sessionCreated };
}

function hookMetadata(base: Session['metadata'], hints: NormalizedHook['hints']): Session['metadata'] {
  const out = { ...base };
  if (hints.transcriptPath) out.transcriptPath = hints.transcriptPath;
  if (hints.permissionMode) out.permissionMode = hints.permissionMode;
  return out;
}

function changed(a: Session, b: Session): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
