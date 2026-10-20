// O feed de atividade (C8, #94): `GET /api/events`, os eventos de todas as sessões, mais novos
// primeiro, com filtros, a página para trás (`before`) e o ao vivo (`after`).
//
// Parâmetros (todos opcionais; inválido dá 400 `{ error }`):
// - `limit` 1..200 (padrão 50); `after` e `before`, cursores opacos que não se combinam;
// - `type` (o `type` do evento), `session`, `tool`, `status` (active|waiting|error|completed);
// - `search` (≤ 100 caracteres, no resumo e na ferramenta, sem curinga);
// - `from` e `to`, ISO 8601. Data sem hora é o dia em UTC, e o `to` com data só inclui o dia todo.
//
// O conteúdo do transcript NÃO é confiável: todo texto sai numa linha só, cortado aqui (por code
// point, sem partir par substituto), e do `data` só sai o id da chamada e uma linha da entrada da
// ferramenta. Resposta, prompt e saída de ferramenta nunca saem.
//
// O cursor do ao vivo segue a ordem de GRAVAÇÃO (ver `ListRecentEventsQuery` na porta): o evento
// que o transcript grava atrasado, com `createdAt` mais velho, também chega. O lote do ao vivo vem
// ordenado por `createdAt` como o resto; quem mostra decide onde encaixá-lo. Se o lote veio cheio
// (`events.length === limit`), há mais: peça de novo com o `cursor` novo.
//
// The body is English since phase 2b of #173 (`{ events, cursor, older, options }`); the old route
// `/api/eventos` answers it in the old keys (src/api/legacy-routes.ts).

import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { send } from '../ingest/hooks/receiver.ts';
import type { Agent, Session, SessionEvent } from '../model.ts';
import type { ListRecentEventsQuery, RecentEventsPage, StoragePort } from '../storage-port.ts';
import { fraseDoEvento, type ContextoDaFrase } from './frase-do-evento.ts';

export const EVENTS_ROUTE = '/api/events';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DOS_EVENTOS = '/api/eventos';

export const STATUS_DO_EVENTO = ['active', 'waiting', 'error', 'completed'] as const;
export type StatusDoEvento = (typeof STATUS_DO_EVENTO)[number];

/**
 * O status de cada tipo de evento. Só pelo tipo, para o filtro caber na consulta.
 * - `waiting`: alguém precisa responder ou é a vez da pessoa (notificação, pedido de permissão,
 *   fim do turno, turno interrompido);
 * - `error`: erro de API e o `StopFailure`;
 * - `completed`: fim da sessão e fim de um subagente;
 * - `active`: todo o resto (ferramentas, prompts, mensagens, início de sessão, tipos novos).
 */
export const TIPOS_POR_STATUS: Readonly<Record<Exclude<StatusDoEvento, 'active'>, readonly string[]>> = {
  waiting: ['Notification', 'PermissionRequest', 'Stop', 'Interrupted'],
  error: ['APIError', 'StopFailure'],
  completed: ['SessionEnd', 'SubagentStop'],
};
const TIPOS_FORA_DE_ACTIVE = Object.values(TIPOS_POR_STATUS).flat();

export function statusDoEvento(tipo: string): StatusDoEvento {
  for (const [status, tipos] of Object.entries(TIPOS_POR_STATUS)) if (tipos.includes(tipo)) return status as StatusDoEvento;
  return 'active';
}

export interface SessaoDoFeed {
  id: string;
  title: string | null;
  project: string | null;
}

/** The agent of an event: `main` for the main agent; a subagent by its type, or `subagent` without one. */
export const MAIN_AGENT = 'main';
export const SUBAGENT = 'subagent';

export interface EventoDoFeed {
  id: string;
  createdAt: string;
  type: string;
  status: StatusDoEvento;
  tool: string | null;
  summary: string | null;
  session: SessaoDoFeed;
  agent: { id: string | null; name: string };
  detail: { callId: string | null; input: string | null };
}

export interface OpcoesDoFeed {
  types: string[];
  tools: string[];
  sessions: SessaoDoFeed[];
}

export interface RespostaDoFeed {
  events: EventoDoFeed[];
  /** Para `after` no próximo pedido do ao vivo. */
  cursor: string | null;
  /** Para `before`; `null` quando acabou. */
  older: string | null;
  /** Só no pedido sem `after` e sem `before`. */
  options: OpcoesDoFeed | null;
}

export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;
const MAX_OPCOES = 100;
const MAX = { id: 128, tipo: 64, ferramenta: 128, resumo: 300, titulo: 120, projeto: 120, agente: 60, callId: 64, entrada: 300, busca: 100 };

const TIPO = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const FERRAMENTA = /^[A-Za-z0-9_.:-]{1,128}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const NUMERO = /^\d{1,3}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
// Com hora, o fuso é obrigatório: sem ele, `Date.parse` leria no fuso do processo.
const DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
// Controles C0 e C1, DEL, os separadores de linha e parágrafo do Unicode, e os de direção (bidi) e
// largura zero, que deixariam um texto do transcript esconder ou inverter o que mostra.
const CONTROLES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const CONTROLES_G = new RegExp(CONTROLES.source, 'g');
const DIA_MS = 86_400_000;

/**
 * Texto não confiável numa linha só, com no máximo `max` code points (o último vira "…" quando
 * corta). Substituto solto vira U+FFFD. Vazio ou não-texto é `null`.
 */
export function textoDeUmaLinha(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const limpo = v.toWellFormed().replace(CONTROLES_G, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const pontos: string[] = [];
  for (const p of limpo) {
    if (pontos.length === max) {
      pontos[max - 1] = '…';
      return pontos.join('');
    }
    pontos.push(p);
  }
  return pontos.join('');
}

class ErroDoPedido extends Error {}

type Json = Record<string, unknown>;
const objeto = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** A linha que descreve a entrada da ferramenta: o primeiro destes campos que for texto. */
function entradaDe(data: Json | null): string | null {
  const entrada = objeto(data?.tool_input);
  if (!entrada) return null;
  for (const campo of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const t = textoDeUmaLinha(entrada[campo], MAX.entrada);
    if (t) return t;
  }
  return null;
}

function dataDoParametro(nome: 'from' | 'to', v: string): { inicio: number; dia: boolean } {
  const dia = DATA.test(v);
  const ms = dia || DATA_HORA.test(v) ? Date.parse(v) : Number.NaN;
  // `Date.parse` aceita 2026-02-30 (vira março): a data sem hora tem de voltar igual.
  if (Number.isNaN(ms) || (dia && new Date(ms).toISOString().slice(0, 10) !== v)) {
    throw new ErroDoPedido(`${nome}: use uma data ISO 8601 (2026-11-02 ou 2026-11-02T12:00:00Z)`);
  }
  return { inicio: ms, dia };
}

interface Pedido {
  query: ListRecentEventsQuery;
  inicial: boolean;
}

function lerPedido(p: URLSearchParams): Pedido {
  const v = (k: string): string | null => {
    const x = p.get(k);
    return x === null || x === '' ? null : x;
  };
  const query: ListRecentEventsQuery = { limit: LIMITE_PADRAO };

  const limite = v('limit');
  if (limite !== null) {
    const n = NUMERO.test(limite) ? Number(limite) : 0;
    if (n < 1 || n > LIMITE_MAXIMO) throw new ErroDoPedido(`limit: um inteiro de 1 a ${LIMITE_MAXIMO}`);
    query.limit = n;
  }

  const depois = v('after');
  const antes = v('before');
  if (depois !== null && antes !== null) throw new ErroDoPedido('after e before não se combinam');
  for (const [nome, c] of [['after', depois], ['before', antes]] as const) {
    if (c !== null && !CURSOR.test(c)) throw new ErroDoPedido(`${nome}: cursor inválido`);
  }
  if (depois !== null) query.after = depois;
  if (antes !== null) query.before = antes;

  const tipo = v('type');
  if (tipo !== null && !TIPO.test(tipo)) throw new ErroDoPedido('type: só letras, números e _, até 64');
  const sessao = v('session');
  if (sessao !== null) {
    if (!ID.test(sessao)) throw new ErroDoPedido('session: id de sessão inválido');
    query.sessionId = sessao;
  }
  const ferramenta = v('tool');
  if (ferramenta !== null) {
    if (!FERRAMENTA.test(ferramenta)) throw new ErroDoPedido('tool: nome de ferramenta inválido');
    query.toolName = ferramenta;
  }

  const status = v('status');
  if (status !== null && !STATUS_DO_EVENTO.includes(status as StatusDoEvento)) {
    throw new ErroDoPedido(`status: um de ${STATUS_DO_EVENTO.join(', ')}`);
  }
  if (status === 'active') {
    query.excludeTypes = TIPOS_FORA_DE_ACTIVE;
    if (tipo !== null) query.types = statusDoEvento(tipo) === 'active' ? [tipo] : [];
  } else if (status !== null) {
    const doStatus = TIPOS_POR_STATUS[status as Exclude<StatusDoEvento, 'active'>];
    query.types = tipo === null ? doStatus : doStatus.includes(tipo) ? [tipo] : [];
  } else if (tipo !== null) {
    query.types = [tipo];
  }

  const busca = p.get('search');
  if (busca !== null) {
    if (CONTROLES.test(busca)) throw new ErroDoPedido('search: sem quebras de linha nem caracteres de controle');
    const t = busca.trim();
    if ([...t].length > MAX.busca) throw new ErroDoPedido(`search: até ${MAX.busca} caracteres`);
    if (t) query.text = t;
  }

  const de = v('from');
  const ate = v('to');
  const inicio = de === null ? null : dataDoParametro('from', de).inicio;
  let fim: number | null = null;
  if (ate !== null) {
    const d = dataDoParametro('to', ate);
    fim = d.dia ? d.inicio + DIA_MS : d.inicio + 1;
  }
  if (inicio !== null && fim !== null && inicio >= fim) throw new ErroDoPedido('from: depois do to');
  if (inicio !== null) query.createdFrom = new Date(inicio).toISOString();
  if (fim !== null) query.createdUntil = new Date(fim).toISOString();

  return { query, inicial: depois === null && antes === null };
}

const TIPOS_DE_PROMPT = ['UserPromptSubmit', 'UserPrompt'] as const;
const TIPOS_DE_FERRAMENTA = ['PreToolUse', 'ToolUse'] as const;

export type PortaDoFeed = Pick<StoragePort, 'listRecentEvents' | 'listEventFacets' | 'listSessions' | 'getSession' | 'getAgent'>;

export interface OpcoesDoFeedDeEventos {
  storage: PortaDoFeed;
}

const sessaoDoFeed = (id: string, s: Session | null): SessaoDoFeed => ({
  id: textoDeUmaLinha(id, MAX.id) ?? '',
  title: textoDeUmaLinha(s?.name, MAX.titulo),
  project: s?.cwd ? textoDeUmaLinha(basename(s.cwd), MAX.projeto) : null,
});

/** Monta a resposta do feed. Sessões e agentes do lote são lidos uma vez por pedido. */
export class FeedDeEventos {
  private readonly storage: PortaDoFeed;

  constructor(opts: OpcoesDoFeedDeEventos) {
    this.storage = opts.storage;
  }

  async responder(params: URLSearchParams): Promise<{ status: number; corpo: RespostaDoFeed | { error: string } }> {
    let pedido: Pedido;
    try {
      pedido = lerPedido(params);
    } catch (err) {
      if (err instanceof ErroDoPedido) return { status: 400, corpo: { error: err.message } };
      throw err;
    }
    let pagina: RecentEventsPage;
    try {
      pagina = await this.storage.listRecentEvents(pedido.query);
    } catch (err) {
      if (err instanceof RangeError) return { status: 400, corpo: { error: 'cursor inválido' } };
      throw err;
    }
    const eventos = await this.montar(pagina.items);
    const opcoes = pedido.inicial ? await this.opcoes() : null;
    return { status: 200, corpo: { events: eventos, cursor: pagina.liveCursor, older: pagina.nextCursor, options: opcoes } };
  }

  private async montar(items: SessionEvent[]): Promise<EventoDoFeed[]> {
    const sessoes = new Map<string, Promise<Session | null>>();
    const agentes = new Map<string, Promise<Agent | null>>();
    const sessao = (id: string) => {
      let s = sessoes.get(id);
      if (!s) sessoes.set(id, (s = this.storage.getSession(id)));
      return s;
    };
    // O hook do subagente traz o `agent_id` cru; o agente gravado é `<sessão>:<agent_id>`.
    const agente = (e: SessionEvent & { agentId: string }) => {
      const chave = `${e.sessionId}\0${e.agentId}`;
      let a = agentes.get(chave);
      if (!a) {
        a = this.storage.getAgent(e.agentId).then((x) => x ?? this.storage.getAgent(`${e.sessionId}:${e.agentId}`));
        agentes.set(chave, a);
      }
      return a;
    };
    // O que a frase precisa de antes do evento: o último prompt (duração do turno) e a última ferramenta
    // (o pedido de permissão diz qual). Uma consulta de um item por evento que precisa, só esses.
    const anterior = async (e: SessionEvent, types: readonly string[]) =>
      (await this.storage.listRecentEvents({ sessionId: e.sessionId, types, createdUntil: e.createdAt, limit: 1 })).items[0] ?? null;
    const contexto = async (e: SessionEvent): Promise<ContextoDaFrase> => {
      const d = objeto(e.data);
      if (e.type === 'Stop' || (e.type === 'TurnDuration' && typeof d?.durationMs !== 'number')) {
        const p = await anterior(e, TIPOS_DE_PROMPT);
        return { ultimoPrompt: p ? Date.parse(p.createdAt) : null };
      }
      if ((e.type === 'Notification' && d?.notification_type === 'permission_prompt') || (e.type === 'PermissionRequest' && !e.toolName)) {
        const f = await anterior(e, TIPOS_DE_FERRAMENTA);
        return { ultimaFerramenta: f ? { nome: f.toolName, resumo: f.summary } : null };
      }
      return {};
    };
    return Promise.all(
      items.map(async (e): Promise<EventoDoFeed> => {
        const [s, a, ctx] = await Promise.all([
          sessao(e.sessionId),
          e.agentId === null ? null : agente(e as SessionEvent & { agentId: string }),
          contexto(e),
        ]);
        const data = objeto(e.data);
        const principal = e.agentId === null || a?.type === 'main' || (!a && e.agentId.endsWith(':main'));
        return {
          id: textoDeUmaLinha(e.id, MAX.id) ?? '',
          createdAt: e.createdAt,
          type: textoDeUmaLinha(e.type, MAX.tipo) ?? '',
          status: statusDoEvento(e.type),
          tool: textoDeUmaLinha(e.toolName, MAX.ferramenta),
          // A frase legível; sem uma, o resumo cru do evento, e por fim o tipo.
          summary: textoDeUmaLinha(fraseDoEvento(e, ctx) ?? e.summary ?? e.type, MAX.resumo),
          session: sessaoDoFeed(e.sessionId, s),
          agent: {
            id: textoDeUmaLinha(a?.id ?? e.agentId, MAX.id),
            name: principal ? MAIN_AGENT : (textoDeUmaLinha(a?.subagentType ?? a?.name, MAX.agente) ?? SUBAGENT),
          },
          detail: {
            callId: textoDeUmaLinha(data?.tool_use_id ?? data?.toolUseId, MAX.callId),
            input: entradaDe(data),
          },
        };
      }),
    );
  }

  private async opcoes(): Promise<OpcoesDoFeed> {
    const [facetas, sessoes] = await Promise.all([this.storage.listEventFacets(MAX_OPCOES), this.storage.listSessions({ limit: MAX_OPCOES })]);
    const lista = (vs: string[], max: number) => vs.map((x) => textoDeUmaLinha(x, max)).filter((x): x is string => x !== null);
    return {
      types: lista(facetas.types, MAX.tipo),
      tools: lista(facetas.toolNames, MAX.ferramenta),
      sessions: sessoes.items.map((s) => sessaoDoFeed(s.id, s)),
    };
  }
}

/** A rota no servidor (api/servidor.ts): só GET, já atrás da checagem de origem. */
export async function responderEventos(res: ServerResponse, url: URL, feed: FeedDeEventos): Promise<void> {
  const { status, corpo } = await feed.responder(url.searchParams);
  send(res, status, corpo);
}
