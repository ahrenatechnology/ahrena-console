// Resumo dos eventos de uma sessão, lido do banco (nunca do transcript) e mantido em memória.
// Cada pedido do painel lê só os eventos novos desde o último cursor; a cada `releituraMs`
// relê tudo, para pegar o evento que chegou atrasado com data anterior ao cursor.

import type { SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';

export interface ItemDoPlano {
  texto: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ResumoDosEventos {
  /** Prompts pelos hooks e pelo transcript; os dois contam o mesmo prompt, vale o maior. */
  promptsHook: number;
  promptsTranscript: number;
  plano: ItemDoPlano[] | null;
  /** Última chamada de ferramenta do agente principal. */
  ultimaFerramenta: { nome: string | null; resumo: string | null; em: string; entrada: Record<string, unknown> | null } | null;
  /** Último pedido de permissão ou de input (Notification bloqueante). */
  ultimoPedido: { texto: string | null; tipo: string | null; em: string } | null;
  /** Última pergunta feita com AskUserQuestion. */
  ultimaPergunta: { texto: string; opcoes: number; em: string } | null;
  ultimoErro: { texto: string | null; em: string } | null;
  /** Último texto do assistente no principal ("Rodo os testes?"), para "Sua vez". */
  ultimaMensagem: string | null;
  /** Último uso do principal: o tamanho do contexto que ele mandou. */
  contexto: number | null;
  /** Pergunta com opções e plano para aprovar que o principal fez e ainda não tiveram resposta (#140). */
  pendentes: { toolUseId: string; ferramenta: 'AskUserQuestion' | 'ExitPlanMode' }[];
  /** O fechamento do turno (`wrap_up` do Desktop) pediu uma decisão (`ask`) ou disse que trava (`blocked`). */
  pedidoNoFechamento: { texto: string | null; em: string } | null;
}

export function resumoVazio(): ResumoDosEventos {
  return {
    promptsHook: 0,
    promptsTranscript: 0,
    plano: null,
    ultimaFerramenta: null,
    ultimoPedido: null,
    ultimaPergunta: null,
    ultimoErro: null,
    ultimaMensagem: null,
    contexto: null,
    pendentes: [],
    pedidoNoFechamento: null,
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const doPrincipal = (e: SessionEvent) => e.agentId === null || e.agentId.endsWith(':main');
const idDaChamada = (d: Json | null): string | null => str(d?.tool_use_id) ?? str(d?.toolUseId);
const WRAP_UP = /(^|__)wrap_up$/;

function planoDe(input: Json | null): ItemDoPlano[] | null {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return null;
  const itens: ItemDoPlano[] = [];
  for (const t of todos) {
    const o = obj(t);
    const texto = str(o?.content) ?? str(o?.activeForm) ?? str(o?.subject);
    if (!o || !texto) continue;
    const status = o.status === 'completed' || o.status === 'in_progress' ? o.status : 'pending';
    itens.push({ texto, status });
  }
  return itens;
}

/** Aplica um evento ao resumo. Pura: a ordem dos eventos é a do banco (cronológica). */
export function aplicarEvento(r: ResumoDosEventos, e: SessionEvent): void {
  const d = obj(e.data);
  // Mensagem do assistente (texto ou ferramenta) com uso: o prompt que ela mandou é o contexto.
  const uso = obj(obj(d?.usage)?.tokens);
  if (uso && doPrincipal(e)) r.contexto = n(uso.input) + n(uso.cacheRead) + n(uso.cacheWrite5m) + n(uso.cacheWrite1h) + n(uso.output);
  switch (e.type) {
    case 'UserPromptSubmit':
      r.promptsHook++;
      r.pendentes = [];
      r.pedidoNoFechamento = null;
      return;
    case 'UserPrompt':
      if (doPrincipal(e)) {
        r.promptsTranscript++;
        // A pessoa escreveu: o que estava pendente foi respondido ou deixado de lado.
        r.pendentes = [];
        r.pedidoNoFechamento = null;
      }
      return;
    case 'PreToolUse':
    case 'ToolUse': {
      const entrada = obj(d?.tool_input);
      if (e.toolName === 'TodoWrite') {
        const plano = planoDe(entrada);
        if (plano) r.plano = plano;
      }
      if (e.toolName === 'AskUserQuestion') {
        const perguntas = Array.isArray(entrada?.questions) ? entrada.questions : [];
        const q = obj(perguntas[0]);
        const texto = str(q?.question) ?? str(entrada?.question);
        if (texto) r.ultimaPergunta = { texto, opcoes: Array.isArray(q?.options) ? q.options.length : 0, em: e.createdAt };
      }
      if (doPrincipal(e)) {
        r.ultimaFerramenta = { nome: e.toolName, resumo: e.summary, em: e.createdAt, entrada };
        const id = idDaChamada(d);
        if ((e.toolName === 'AskUserQuestion' || e.toolName === 'ExitPlanMode') && id && !r.pendentes.some((x) => x.toolUseId === id)) {
          r.pendentes = [...r.pendentes, { toolUseId: id, ferramenta: e.toolName }];
        }
        if (e.toolName && WRAP_UP.test(e.toolName) && entrada) {
          const ask = str(entrada.ask);
          r.pedidoNoFechamento = ask || entrada.blocked === true ? { texto: ask, em: e.createdAt } : null;
        }
      }
      return;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'ToolResult': {
      const id = idDaChamada(d);
      if (id && r.pendentes.length) r.pendentes = r.pendentes.filter((x) => x.toolUseId !== id);
      return;
    }
    case 'Notification':
      r.ultimoPedido = { texto: e.summary, tipo: str(d?.notification_type), em: e.createdAt };
      return;
    case 'AssistantMessage':
      if (doPrincipal(e) && e.summary) r.ultimaMensagem = e.summary;
      return;
    case 'APIError':
    case 'StopFailure':
      r.ultimoErro = { texto: e.summary ?? str(d?.error) ?? str(d?.message), em: e.createdAt };
      return;
  }
}

interface Entrada {
  updatedAt: string;
  cursor: string | null;
  lidoEm: number;
  resumo: ResumoDosEventos;
}

export interface OpcoesDoResumo {
  /** Releitura completa, no máximo a cada tanto. Padrão 60 s. */
  releituraMs?: number;
  agora?: () => number;
  /** Quantas sessões guardar. Padrão 64 (o painel só pede a própria). */
  maximo?: number;
}

export class ResumosDeSessao {
  private readonly cache = new Map<string, Entrada>();
  private readonly releituraMs: number;
  private readonly agora: () => number;
  private readonly maximo: number;
  /** Eventos lidos do banco desde o início (para a medição de carga). */
  eventosLidos = 0;

  private readonly porta: Pick<StoragePort, 'listEvents'>;

  constructor(porta: Pick<StoragePort, 'listEvents'>, { releituraMs = 60_000, agora = Date.now, maximo = 64 }: OpcoesDoResumo = {}) {
    this.porta = porta;
    this.releituraMs = releituraMs;
    this.agora = agora;
    this.maximo = maximo;
  }

  /** O resumo da sessão em `updatedAt`. Sem mudança desde o último pedido, nada é lido. */
  async ler(sessionId: string, updatedAt: string): Promise<ResumoDosEventos> {
    let e = this.cache.get(sessionId);
    if (e && e.updatedAt === updatedAt) return e.resumo;
    if (!e || this.agora() - e.lidoEm >= this.releituraMs) {
      e = { updatedAt, cursor: null, lidoEm: this.agora(), resumo: resumoVazio() };
    }
    let cursor = e.cursor;
    for (;;) {
      let page;
      try {
        page = await this.porta.listEvents(sessionId, { limit: 500, cursor });
      } catch (err) {
        // Cursor que o adaptador não reconhece: relê do início.
        if (!(err instanceof RangeError) || cursor === null) throw err;
        e = { updatedAt, cursor: null, lidoEm: this.agora(), resumo: resumoVazio() };
        cursor = null;
        continue;
      }
      for (const ev of page.items) aplicarEvento(e.resumo, ev);
      this.eventosLidos += page.items.length;
      if (page.items.length > 0) cursor = page.nextCursor ?? cursorDe(page.items.at(-1)!);
      if (!page.nextCursor) break;
    }
    e.cursor = cursor;
    e.updatedAt = updatedAt;
    this.cache.delete(sessionId);
    this.cache.set(sessionId, e);
    if (this.cache.size > this.maximo) this.cache.delete(this.cache.keys().next().value!);
    return e.resumo;
  }
}

// A porta só devolve cursor quando há outra página. Para continuar depois do último evento
// lido, monta o cursor no formato do adaptador SQLite (createdAt e id, em base64url); outro
// adaptador que não o reconheça lança RangeError, e `ler` volta a ler do início.
function cursorDe(ev: SessionEvent): string {
  return Buffer.from(JSON.stringify([ev.createdAt, ev.id])).toString('base64url');
}
