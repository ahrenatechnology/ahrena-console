// Porta de armazenamento do núcleo. Quem usa o núcleo depende só desta interface;
// o adaptador SQLite (local) e o futuro adaptador DynamoDB (hub, item 7.2) a implementam.
//
// Para caber no DynamoDB sem mudar quem usa:
// - tudo é assíncrono;
// - as operações seguem padrões de acesso (por id, por sessão, por status), sem consulta livre;
// - gravações são "put" do registro inteiro (upsert), sem update parcial;
// - paginação por cursor opaco, nunca por offset;
// - nada depende de chave estrangeira ou de id gerado pelo banco.

import type {
  Agent,
  SessionIdentity,
  Provider,
  ProviderAccount,
  ModelPricing,
  SessionEvent,
  Session,
  SessionStatus,
  TokenUsage,
} from './model.ts';
import type { PlanRecord, SessionPlan } from './plan/model.ts';
import type { ContextMeter } from './context/model.ts';

export interface Page<T> {
  items: T[];
  /** Cursor para a próxima página; `null` quando acabou. */
  nextCursor: string | null;
}

export interface ListSessionsQuery {
  provider?: Provider;
  profileId?: string | null;
  machineId?: string | null;
  environmentId?: string | null;
  /** Filtra pelo status persistido. */
  status?: readonly SessionStatus[];
  /** `true`: só as que esperam alguém; `false`: só as que não esperam. */
  awaiting?: boolean;
  cwd?: string;
  /** Filtra pela conta (`ProviderAccount.id`); `null` na lista pede as sessões "Sem conta". */
  accountIds?: readonly (string | null)[];
  /** Padrão 50, máximo 500. */
  limit?: number;
  cursor?: string | null;
}

export interface ListEventsQuery {
  limit?: number;
  cursor?: string | null;
}

/**
 * Os eventos de todas as sessões, para o feed (#94). Os filtros se somam (E).
 * Duas posições, num cursor opaco só:
 * - `before` pagina para trás por `createdAt` (depois `id`), entre os eventos que já existiam no
 *   primeiro pedido: o que foi gravado depois não entra, para não repetir o que veio pelo ao vivo;
 * - `after` é o ao vivo: o que foi GRAVADO depois da posição, pela ordem de gravação, não pelo
 *   `createdAt`. Assim entra o evento atrasado (backfill do transcript) com `createdAt` mais velho.
 *   Cada adaptador guarda essa ordem (SQLite: a coluna `seq`; DynamoDB: um contador por item).
 */
export interface ListRecentEventsQuery {
  /** Padrão 50, máximo 500. */
  limit?: number;
  /** Ao vivo: só os gravados depois desta posição (o `liveCursor` de uma resposta). Não combina com `before`. */
  after?: string | null;
  /** Página mais velha: o `nextCursor` de uma resposta. */
  before?: string | null;
  sessionId?: string;
  /** Só estes tipos; lista vazia não traz nada. */
  types?: readonly string[];
  /** Fora estes tipos. */
  excludeTypes?: readonly string[];
  toolName?: string;
  /** Contém este texto no `summary` ou no `toolName`, sem diferenciar maiúsculas (ASCII), sem curinga. */
  text?: string;
  /** `createdAt` maior ou igual (ISO 8601 UTC). */
  createdFrom?: string;
  /** `createdAt` menor que (ISO 8601 UTC). */
  createdUntil?: string;
}

export interface RecentEventsPage {
  /** Mais novos primeiro, por `createdAt` e depois `id`. No ao vivo, o lote mais antigo gravado vem primeiro. */
  items: SessionEvent[];
  /**
   * Para `after` no próximo pedido do ao vivo. Sem nada gravado desde o `after`, é o mesmo `after`;
   * `null` só quando não há evento nenhum.
   */
  liveCursor: string | null;
  /** Para `before`; `null` quando acabou (e sempre no ao vivo). */
  nextCursor: string | null;
}

/** Os valores distintos para as opções dos filtros do feed, em ordem alfabética. */
export interface EventFacets {
  types: string[];
  toolNames: string[];
}

export interface StoragePort {
  /** Grava a sessão inteira (cria ou substitui). */
  putSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  getSessionByIdentity(identity: SessionIdentity): Promise<Session | null>;
  /** Mais recentes primeiro, por `updatedAt`. */
  listSessions(query?: ListSessionsQuery): Promise<Page<Session>>;

  /** Grava a conta inteira (cria ou substitui). */
  putAccount(account: ProviderAccount): Promise<void>;
  getAccount(id: string): Promise<ProviderAccount | null>;
  /** Na ordem em que foram vistas pela primeira vez. Sem paginação: são poucas por máquina. */
  listAccounts(): Promise<ProviderAccount[]>;

  putAgent(agent: Agent): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  /** Na ordem em que começaram. */
  listAgents(sessionId: string): Promise<Agent[]>;

  /** Acrescenta o evento. Devolve `false` se o id já existia (o evento não é duplicado nem alterado). */
  appendEvent(event: SessionEvent): Promise<boolean>;
  /** Sets `data.text` of an existing event, keeping the rest of its `data`. Returns `false` if the id does not exist. */
  setEventText(id: string, text: string): Promise<boolean>;
  /** Em ordem cronológica. */
  listEvents(sessionId: string, query?: ListEventsQuery): Promise<Page<SessionEvent>>;
  /** Todas as sessões, mais novos primeiro, com filtros e o ao vivo (feed, #94). */
  listRecentEvents(query?: ListRecentEventsQuery): Promise<RecentEventsPage>;
  /** Tipos e ferramentas distintos dos eventos, até `limit` de cada (padrão 100). */
  listEventFacets(limit?: number): Promise<EventFacets>;

  /** Grava o bucket inteiro, substituindo o anterior com a mesma chave. */
  putTokenUsage(usage: TokenUsage): Promise<void>;
  listTokenUsage(sessionId: string): Promise<TokenUsage[]>;

  putModelPricing(pricing: ModelPricing): Promise<void>;
  listModelPricing(): Promise<ModelPricing[]>;
  /** Devolve `false` se o padrão não existia. */
  deleteModelPricing(pattern: string): Promise<boolean>;

  /** Grava o plano inteiro da sessão (cria ou substitui). Item 1.9. */
  putPlan(plan: SessionPlan): Promise<void>;
  getPlan(sessionId: string): Promise<SessionPlan | null>;
  /** Grava um plano do histórico da sessão (cria ou substitui pelo `seq`). Issue #131. */
  putPlanRecord(record: PlanRecord): Promise<void>;
  /** Os planos da sessão, do mais recente para o mais antigo. Sem paginação: são poucos por sessão. */
  listPlanRecords(sessionId: string): Promise<PlanRecord[]>;
  /** Apaga o histórico de planos da sessão, para reconstruí-lo dos eventos. */
  deletePlanRecords(sessionId: string): Promise<void>;

  /** Grava o medidor de contexto de um agente da sessão (cria ou substitui). Item 1.7. */
  putContextMeter(meter: ContextMeter): Promise<void>;
  /** Medidores da sessão: o principal primeiro, depois os subagentes por id. */
  listContextMeters(sessionId: string): Promise<ContextMeter[]>;
  /** Apaga os medidores da sessão, para refazê-los do zero (reprocessamento). */
  deleteContextMeters(sessionId: string): Promise<void>;

  close(): Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit inválido: ${limit}`);
  return Math.min(limit, MAX_PAGE_SIZE);
}
