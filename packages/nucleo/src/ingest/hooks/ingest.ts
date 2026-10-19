// Grava um hook normalizado pela porta de armazenamento.
// Além do evento, garante um registro mínimo da sessão (para ela aparecer nas listas) e mantém
// `updatedAt`, `cwd` e `model` em dia. Status, espera e agentes não mudam aqui: são da máquina de
// estados (item 1.5), que pode se pendurar no `onEvent` do receptor.
//
// A conta da sessão (#110) é resolvida no `SessionStart` e no primeiro evento que o receptor vê de
// cada sessão (ver conta.ts); o resultado respeita a precedência da decisão 0006.

import { applySessionAccount, type ClaudeAccount, type Session } from '../../model.ts';
import type { StoragePort } from '../../storage-port.ts';
import { atualizarPlano } from '../../plano/gravacao.ts';
import { atualizarContexto } from '../../contexto/gravacao.ts';
import { contaDaPasta } from './conta-da-pasta.ts';
import { resolverConta, type ContaResolvida, type LerContaDaPasta } from './conta.ts';
import { normalizeHook, type NormalizeOptions, type NormalizedHook } from './normalize.ts';

export interface IngestOptions extends NormalizeOptions {
  /** Lê a conta logada numa pasta de configuração; o padrão lê o `.claude.json` dela. */
  lerContaDaPasta?: LerContaDaPasta;
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
    const r = await resolverConta(hints.env, hints.transcriptPath, opts.lerContaDaPasta ?? ((pasta) => contaDaPasta(pasta)));
    if (r.conta) next = applySessionAccount(next, r.conta.id, r.conta.source);
    const metadata: Session['metadata'] = { ...next.metadata, accountCheckedAt: event.createdAt };
    if (r.desktopScope) metadata.desktopScope = r.desktopScope;
    if (r.desktopScopeConflict !== null) metadata.desktopScopeConflict = r.desktopScopeConflict;
    next = { ...next, metadata };
    if (r.conta) await registrarConta(storage, r.conta, event.createdAt);
  }

  const sessionCreated = !current;
  if (!current || changed(current, next)) await storage.putSession(next);

  const appended = await storage.appendEvent(event);
  // Plano da sessão (item 1.9): TodoWrite, TaskCreate, TaskUpdate, update_plan e /clear.
  if (appended) await atualizarPlano(storage, event.sessionId, [event]);
  // Medidor de contexto (item 1.7): o hook PreCompact conta um estouro.
  if (appended) await atualizarContexto(storage, event.sessionId, [event]);
  return { ...normalized, appended, sessionCreated };
}

/** Garante a `ClaudeAccount` da conta vista, com a pasta de configuração em que apareceu. */
async function registrarConta(storage: StoragePort, conta: ContaResolvida, vistaEm: string): Promise<void> {
  const atual = await storage.getAccount(conta.id);
  const configDirs = atual?.configDirs ?? [];
  const novas = conta.configDir && !configDirs.includes(conta.configDir) ? [...configDirs, conta.configDir] : configDirs;
  if (atual && novas === configDirs && atual.lastSeenAt >= vistaEm) return;
  const registro: ClaudeAccount = atual
    ? { ...atual, configDirs: novas, lastSeenAt: vistaEm > atual.lastSeenAt ? vistaEm : atual.lastSeenAt }
    : {
        id: conta.id,
        accountUuid: conta.accountUuid,
        organizationUuid: conta.organizationUuid,
        organizationName: null,
        organizationType: null,
        label: null,
        color: null,
        configDirs: novas,
        firstSeenAt: vistaEm,
        lastSeenAt: vistaEm,
        metadata: {},
      };
  await storage.putAccount(registro);
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
