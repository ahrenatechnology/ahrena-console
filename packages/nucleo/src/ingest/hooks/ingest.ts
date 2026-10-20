// Grava um hook normalizado pela porta de armazenamento.
// Além do evento, garante um registro mínimo da sessão (para ela aparecer nas listas) e mantém
// `updatedAt`, `cwd` e `model` em dia. Status, espera e agentes não mudam aqui: são da máquina de
// estados (item 1.5), que pode se pendurar no `onEvent` do receptor.
//
// A conta da sessão (#110) é resolvida no `SessionStart` e no primeiro evento que o receptor vê de
// cada sessão (ver conta.ts); o resultado respeita a precedência da decisão 0006.

import { applySessionAccount, type Session } from '../../model.ts';
import type { StoragePort } from '../../storage-port.ts';
import { atualizarPlano } from '../../plano/gravacao.ts';
import { updateContextMeters } from '../../context/recording.ts';
import { Perfis } from '../../perfis/perfis.ts';
import { resolverConta, type PerfisDoHook } from './conta.ts';
import { normalizeHook, type NormalizeOptions, type NormalizedHook } from './normalize.ts';

export interface IngestOptions extends NormalizeOptions {
  /** Perfis (#109), que leem a conta de uma pasta e gravam a `ClaudeAccount`; o padrão é um novo sobre a porta. */
  perfis?: PerfisDoHook;
}

export interface IngestResult extends NormalizedHook {
  /** `false` quando o evento já existia (entrega repetida). */
  appended: boolean;
  /** `true` quando a sessão nasceu deste evento. */
  sessionCreated: boolean;
}

export async function ingestHook(storage: StoragePort, raw: unknown, opts: IngestOptions): Promise<IngestResult> {
  const normalized = normalizeHook(raw, opts);
  const { event, hints } = normalized;

  const current = await storage.getSession(event.sessionId);
  let next: Session;
  if (!current) {
    next = {
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
      accountId: null,
      accountSource: null,
      metadata: hookMetadata({}, hints),
    };
  } else {
    next = {
      ...current,
      cwd: current.cwd ?? hints.cwd,
      model: hints.model ?? current.model,
      source: current.source ?? hints.source,
      // Eventos chegam fora de ordem às vezes; a última atividade nunca anda para trás.
      updatedAt: event.createdAt > current.updatedAt ? event.createdAt : current.updatedAt,
      metadata: hookMetadata(current.metadata, hints),
    };
  }

  if (event.type === 'SessionStart' || next.metadata.accountCheckedAt === undefined) {
    const r = await resolverConta(hints.env, hints.transcriptPath, opts.perfis ?? new Perfis({ storage }));
    if (r.conta) next = applySessionAccount(next, r.conta.account.id, r.conta.source);
    // O que um SessionStart anterior gravou do Desktop não vale mais se este não trouxe.
    const { desktopScope: _escopo, desktopScopeConflict: _conflito, ...anterior } = next.metadata;
    const metadata: Session['metadata'] = { ...anterior, accountCheckedAt: event.createdAt };
    if (r.desktopScope) metadata.desktopScope = r.desktopScope;
    if (r.desktopScopeConflict !== null) metadata.desktopScopeConflict = r.desktopScopeConflict;
    next = { ...next, metadata };
  }

  const sessionCreated = !current;
  if (!current || changed(current, next)) await storage.putSession(next);

  const appended = await storage.appendEvent(event);
  // Plano da sessão (item 1.9): TodoWrite, TaskCreate, TaskUpdate, update_plan e /clear.
  if (appended) await atualizarPlano(storage, event.sessionId, [event]);
  // Medidor de contexto (item 1.7): o hook PreCompact conta um estouro.
  if (appended) await updateContextMeters(storage, event.sessionId, [event]);
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
