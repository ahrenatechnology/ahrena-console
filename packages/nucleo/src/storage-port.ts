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
  ClaudeAccount,
  ModelPricing,
  SessionEvent,
  Session,
  SessionStatus,
  TokenUsage,
} from './model.ts';

export interface Page<T> {
  items: T[];
  /** Cursor para a próxima página; `null` quando acabou. */
  nextCursor: string | null;
}

export interface ListSessionsQuery {
  /** Filtra pelo status persistido. */
  status?: readonly SessionStatus[];
  /** `true`: só as que esperam alguém; `false`: só as que não esperam. */
  awaiting?: boolean;
  cwd?: string;
  /** Filtra pela conta (`ClaudeAccount.id`); `null` na lista pede as sessões "Sem conta". */
  accountIds?: readonly (string | null)[];
  /** Padrão 50, máximo 500. */
  limit?: number;
  cursor?: string | null;
}

export interface ListEventsQuery {
  limit?: number;
  cursor?: string | null;
}

export interface StoragePort {
  /** Grava a sessão inteira (cria ou substitui). */
  putSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  /** Mais recentes primeiro, por `updatedAt`. */
  listSessions(query?: ListSessionsQuery): Promise<Page<Session>>;

  /** Grava a conta inteira (cria ou substitui). */
  putAccount(account: ClaudeAccount): Promise<void>;
  getAccount(id: string): Promise<ClaudeAccount | null>;
  /** Na ordem em que foram vistas pela primeira vez. Sem paginação: são poucas por máquina. */
  listAccounts(): Promise<ClaudeAccount[]>;

  putAgent(agent: Agent): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  /** Na ordem em que começaram. */
  listAgents(sessionId: string): Promise<Agent[]>;

  /** Acrescenta o evento. Devolve `false` se o id já existia (o evento não é duplicado nem alterado). */
  appendEvent(event: SessionEvent): Promise<boolean>;
  /** Em ordem cronológica. */
  listEvents(sessionId: string, query?: ListEventsQuery): Promise<Page<SessionEvent>>;

  /** Grava o bucket inteiro, substituindo o anterior com a mesma chave. */
  putTokenUsage(usage: TokenUsage): Promise<void>;
  listTokenUsage(sessionId: string): Promise<TokenUsage[]>;

  putModelPricing(pricing: ModelPricing): Promise<void>;
  listModelPricing(): Promise<ModelPricing[]>;
  /** Devolve `false` se o padrão não existia. */
  deleteModelPricing(pattern: string): Promise<boolean>;

  close(): Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit inválido: ${limit}`);
  return Math.min(limit, MAX_PAGE_SIZE);
}
