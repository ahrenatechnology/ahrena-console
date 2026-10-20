// As leituras do Detalhe da sessão na /ui (#29 e #30): o topo do A5 e as abas Agentes (C4),
// Conversa (C5) e Linha do tempo (C6). Só leitura, do banco: nenhum pedido abre transcript
// (decisão 0004). O texto das mensagens é o resumo que o núcleo guarda de cada evento.
//
// | Rota                                  | O quê                                                     |
// | ------------------------------------- | --------------------------------------------------------- |
// | `GET /api/sessions/<id>`              | O topo: título, status, motivo, pílulas, faixa e contagens |
// | `GET /api/sessions/<id>/agents`       | Números, ferramentas, tarefas, tokens e a árvore de agentes |
// | `GET /api/sessions/<id>/conversation` | As mensagens de um agente (`?agent=`, `?limit=`)            |
// | `GET /api/sessions/<id>/events`       | A linha do tempo, filtrada e paginada (veja `filtroDe`)     |
//
// `GET /api/sessions` (a lista, sem id) não é daqui: é da tela Sessões (#28). The old
// `/api/sessoes/<id>[/agentes|/conversa|/eventos]` and parameter names are aliases (src/api/legacy-routes.ts).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { parcelasDaSessao, relatorioDeCusto } from '../custo/agregacao.ts';
import { precosVigentes } from '../custo/tabela.ts';
import type { Agent, DisplayStatus, Session, SessionEvent } from '../model.ts';
import { effectiveTokens } from '../pricing.ts';
import type { StoragePort } from '../storage-port.ts';
import type { MontadorDoPainel } from './painel.ts';
import type { CustoDoPainel, PlanoDoPainel, SessaoDoPainel } from './tipos.ts';

/** `/api/sessions/<id>` e as três abas; o id passa pelo mesmo padrão das outras rotas. */
export const DETAIL_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/(agents|conversation|events))?$/;
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DO_DETALHE = /^\/api\/sessoes\/([^/]+)(?:\/(agentes|conversa|eventos))?$/;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LOCAL = /^local_[0-9a-f-]{36}$/;
const PAGINA_DE_EVENTOS = 50;
const MAX_PAGINA = 500;
const MAX_MENSAGENS = 200;
const MAX_DADOS = 4_000;
const MAX_TEXTO = 2_000;
const MAX_FERRAMENTAS = 8;

// ---------- Contrato ----------

export interface CabecaDoDetalhe {
  versao: 1;
  geradoEm: string;
  sessao: SessaoDoPainel;
  custo: CustoDoPainel | null;
  /** O branch: o do Desktop ou do hook, senão o do git da pasta. */
  branch: string | null;
  /** `local_…` do Claude Desktop, para o "Abrir no Claude Desktop"; `null` na sessão só de terminal. */
  local: string | null;
  /** A API abre a conversa no Claude Desktop (`POST /open/<local_…>`): no macOS. */
  abreSessao: boolean;
  /** O comando ou o alvo da ferramenta que pede permissão, para a faixa mostrar em código; `null` sem pedido. */
  comando: string | null;
  /** Quando acabou: o fim gravado, ou a última atividade da que não está mais ativa. `null` ativa. */
  encerradaEm: string | null;
  contagens: { agentes: number; eventos: number };
}

export interface AgenteDoDetalhe {
  id: string;
  tipo: 'principal' | 'subagente';
  /** "Agente principal", ou o tipo do subagente ("Explore"). */
  nome: string;
  tarefa: string | null;
  modelo: string | null;
  /** Prompts do principal; `null` nos subagentes. */
  turnos: number | null;
  status: Agent['status'];
  inicio: string;
  fim: string | null;
  /** `null`: há uso sem preço, ou nenhum uso medido. */
  custoUsd: number | null;
  pai: string | null;
}

export interface AgentesDoDetalhe {
  numeros: {
    eventos: number;
    /** Eventos por minuto, na duração da sessão. */
    porMinuto: number;
    ferramentas: number;
    ferramentasUnicas: number;
    subagentes: number;
    compactacoes: number;
    erros: number;
    duracaoMin: number;
    rodando: boolean;
  };
  /** As mais usadas, até 8, da mais para a menos usada. */
  ferramentas: { nome: string; n: number }[];
  tarefas: PlanoDoPainel | null;
  tokens: { cacheLido: number; cacheGravado: number; entrada: number; saida: number; total: number } | null;
  agentes: AgenteDoDetalhe[];
}

export type EstadoDaFerramenta = 'ok' | 'erro' | 'permissao' | 'rodando' | null;

export interface FerramentaNaConversa {
  id: string;
  nome: string;
  resumo: string | null;
  estado: EstadoDaFerramenta;
  /** A entrada e o resultado, como texto; o navegador mostra por `textContent`. */
  entrada: string | null;
  resultado: string | null;
}

export interface MensagemDaConversa {
  id: string;
  papel: 'voce' | 'assistente';
  em: string;
  texto: string | null;
  modelo: string | null;
  tokens: { entrada: number; saida: number } | null;
  ferramentas: FerramentaNaConversa[];
}

export interface ConversaDoDetalhe {
  agentes: { id: string; nome: string }[];
  agente: string;
  /** Mensagens do agente, todas; `mensagens` traz só as últimas `limite`. */
  total: number;
  mensagens: MensagemDaConversa[];
}

export interface EventoDoDetalhe {
  id: string;
  em: string;
  tipo: string;
  ferramenta: string | null;
  resumo: string | null;
  agente: { id: string; nome: string } | null;
  status: Extract<DisplayStatus, 'active' | 'waiting' | 'error'>;
  /** O `data` do evento em JSON, cortado: o expandir da linha. */
  dados: string | null;
}

export interface EventosDoDetalhe {
  total: number;
  filtrados: number;
  itens: EventoDoDetalhe[];
  /** O `antes=` da próxima página; `null` quando acabou. */
  proximo: string | null;
  opcoes: { tipos: string[]; ferramentas: string[]; agentes: { id: string; nome: string }[]; status: EventoDoDetalhe['status'][] };
}

// ---------- Leitura ----------

export interface OpcoesDoDetalhe {
  storage: StoragePort;
  montador: MontadorDoPainel;
  agora?: () => number;
  /** O `local_…` de uma sessão, além do índice do Desktop (a demonstração dá um sintético). */
  local?: (sessionId: string) => string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function cortar(texto: string | null, max: number): string | null {
  if (texto === null) return null;
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

function emJson(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return cortar(v, MAX_DADOS);
  try {
    return cortar(JSON.stringify(v, null, 2), MAX_DADOS);
  } catch {
    return null;
  }
}

/** O id da chamada de ferramenta: o do transcript (`toolUseId`) ou o do hook (`tool_use_id`). */
function idDaChamada(e: SessionEvent): string | null {
  const d = obj(e.data);
  return str(d?.toolUseId) ?? str(d?.tool_use_id);
}

const CHAMADAS = new Set(['ToolUse', 'PreToolUse']);
const RESULTADOS = new Set(['ToolResult', 'PostToolUse', 'PostToolUseFailure']);
const PROMPTS = new Set(['UserPrompt', 'UserPromptSubmit']);

function falhou(e: SessionEvent): boolean {
  const d = obj(e.data);
  if (e.type === 'PostToolUseFailure') return true;
  if (e.type === 'ToolResult') return d?.isError === true;
  if (e.type === 'PostToolUse') {
    const r = obj(d?.tool_response);
    return r?.is_error === true || r?.success === false || (e.summary?.startsWith('erro:') ?? false);
  }
  return false;
}

function statusDoEvento(e: SessionEvent): EventoDoDetalhe['status'] {
  if (e.type === 'Notification' || e.type === 'Stop') return 'waiting';
  if (e.type === 'APIError' || falhou(e)) return 'error';
  return 'active';
}

/** Quem é o agente de cada evento: os hooks mandam o id cru; o transcript, `<sessão>:<id>`. */
class Agentes {
  readonly principal: string;
  private readonly ids = new Set<string>();
  private readonly nomes = new Map<string, string>();

  private readonly sessionId: string;
  readonly lista: Agent[];

  constructor(sessionId: string, lista: Agent[]) {
    this.sessionId = sessionId;
    this.lista = lista;
    const main = lista.find((a) => a.type === 'main');
    this.principal = main?.id ?? `${sessionId}:main`;
    this.nomes.set(this.principal, 'Agente principal');
    for (const a of lista) {
      this.ids.add(a.id);
      if (a.type !== 'main') this.nomes.set(a.id, a.subagentType ?? a.name ?? 'Subagente');
    }
  }

  de(id: string | null): string {
    if (!id || id === this.principal || id.endsWith(':main')) return this.principal;
    if (this.ids.has(id)) return id;
    const prefixado = `${this.sessionId}:${id}`;
    return this.ids.has(prefixado) ? prefixado : id;
  }

  nome(id: string): string {
    return this.nomes.get(id) ?? 'Subagente';
  }

  /** O principal e os subagentes, na ordem em que começaram. */
  opcoes(): { id: string; nome: string }[] {
    return [{ id: this.principal, nome: 'Agente principal' }, ...this.lista.filter((a) => a.type !== 'main').map((a) => ({ id: a.id, nome: this.nome(a.id) }))];
  }
}

export class LeiturasDoDetalhe {
  private readonly storage: StoragePort;
  private readonly montador: MontadorDoPainel;
  private readonly agora: () => number;
  private readonly local: (sessionId: string) => string | null;

  constructor({ storage, montador, agora = Date.now, local = () => null }: OpcoesDoDetalhe) {
    this.storage = storage;
    this.montador = montador;
    this.agora = agora;
    this.local = local;
  }

  /** Responde uma rota do Detalhe; o servidor só a registra. */
  async responder(res: ServerResponse, id: string, aba: string | null, url: URL): Promise<void> {
    if (!ID.test(id)) return send(res, 400, { error: 'id de sessão inválido' });
    const session = await this.storage.getSession(id);
    if (!session) return send(res, 404, { error: 'o núcleo não conhece esta sessão' });
    if (aba === 'agents') return send(res, 200, await this.agentes(session));
    if (aba === 'conversation') return send(res, 200, await this.conversa(session, url.searchParams.get('agent'), url.searchParams.get('limit')));
    if (aba === 'events') return send(res, 200, await this.eventos(session, url.searchParams));
    send(res, 200, await this.cabeca(session));
  }

  private async todosOsEventos(sessionId: string): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listEvents(sessionId, { limit: MAX_PAGINA, cursor });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async cabeca(session: Session): Promise<CabecaDoDetalhe> {
    const painel = await this.montador.montar({ sessionId: session.id }, { literal: true });
    const [agentes, eventos] = await Promise.all([this.storage.listAgents(session.id), this.todosOsEventos(session.id)]);
    const local = this.montador.localDe(session.id) ?? this.local(session.id);
    const pede = painel.session?.banner?.type === 'permission' ? (await this.montador.resumos.ler(session.id, session.updatedAt)).ultimaFerramenta : null;
    return {
      versao: 1,
      geradoEm: new Date(this.agora()).toISOString(),
      sessao: painel.session!,
      custo: painel.cost,
      branch: painel.session?.branch ?? painel.work?.branch ?? null,
      local: local && LOCAL.test(local) ? local : null,
      abreSessao: painel.api.opensSession,
      comando: pede?.resumo ?? null,
      encerradaEm: session.endedAt ?? (session.status === 'active' ? null : session.updatedAt),
      contagens: { agentes: agentes.length, eventos: eventos.length },
    };
  }

  async agentes(session: Session): Promise<AgentesDoDetalhe> {
    const painel = await this.montador.montar({ sessionId: session.id }, { literal: true });
    const [lista, eventos, buckets, precos] = await Promise.all([
      this.storage.listAgents(session.id),
      this.todosOsEventos(session.id),
      this.storage.listTokenUsage(session.id),
      precosVigentes(this.storage),
    ]);
    const quem = new Agentes(session.id, lista);

    // Ferramentas: cada chamada conta uma vez, venha do hook, do transcript ou dos dois.
    const vistas = new Set<string>();
    const porFerramenta = new Map<string, number>();
    let erros = 0;
    let compactacoes = 0;
    for (const e of eventos) {
      if (e.type === 'APIError' || falhou(e)) erros++;
      if (e.type === 'Compaction') compactacoes++;
      if (!CHAMADAS.has(e.type) || !e.toolName) continue;
      const chamada = idDaChamada(e);
      if (chamada) {
        if (vistas.has(chamada)) continue;
        vistas.add(chamada);
      }
      porFerramenta.set(e.toolName, (porFerramenta.get(e.toolName) ?? 0) + 1);
    }
    const ferramentas = [...porFerramenta].map(([nome, n]) => ({ nome, n })).sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));
    const chamadas = ferramentas.reduce((s, f) => s + f.n, 0);

    const inicio = Date.parse(session.startedAt);
    const fim = session.endedAt ? Date.parse(session.endedAt) : session.status === 'active' ? this.agora() : Date.parse(session.updatedAt);
    const duracaoMin = Math.max(0, Math.round((fim - inicio) / 60_000));

    let tokens: AgentesDoDetalhe['tokens'] = null;
    if (buckets.length) {
      tokens = { cacheLido: 0, cacheGravado: 0, entrada: 0, saida: 0, total: 0 };
      for (const b of buckets) {
        const t = effectiveTokens(b);
        tokens.cacheLido += t.cacheRead;
        tokens.cacheGravado += t.cacheWrite5m + t.cacheWrite1h;
        tokens.entrada += t.input;
        tokens.saida += t.output;
      }
      tokens.total = tokens.cacheLido + tokens.cacheGravado + tokens.entrada + tokens.saida;
    }

    // Custo por nó: o uso sem agente (o piso da compactação) fica com o principal.
    const relatorio = relatorioDeCusto(await parcelasDaSessao(this.storage, session.id, precos));
    const custoDe = new Map<string, number | null>();
    for (const linha of relatorio.porAgente) {
      const id = linha.agentId ? quem.de(linha.agentId) : quem.principal;
      const antes = custoDe.get(id);
      custoDe.set(id, linha.custoUsd === null ? (antes ?? null) : (antes ?? 0) + linha.custoUsd);
    }
    const main = lista.find((a) => a.type === 'main');
    const agentes: AgenteDoDetalhe[] = [
      {
        id: quem.principal,
        tipo: 'principal',
        nome: 'Agente principal',
        tarefa: null,
        modelo: session.model,
        turnos: painel.session?.turn ?? 0,
        status: main?.status ?? (session.awaitingInputSince ? 'waiting' : session.status === 'error' ? 'error' : session.status === 'active' ? 'working' : 'completed'),
        inicio: main?.startedAt ?? session.startedAt,
        fim: main?.endedAt ?? session.endedAt,
        custoUsd: custoDe.get(quem.principal) ?? null,
        pai: null,
      },
      ...lista
        .filter((a) => a.type !== 'main')
        .map((a) => ({
          id: a.id,
          tipo: 'subagente' as const,
          nome: quem.nome(a.id),
          tarefa: a.task ?? (a.subagentType ? a.name : null),
          modelo: str(obj(a.metadata)?.model),
          turnos: null,
          status: a.status,
          inicio: a.startedAt,
          fim: a.endedAt,
          custoUsd: custoDe.get(a.id) ?? null,
          pai: a.parentAgentId ?? quem.principal,
        })),
    ];

    return {
      numeros: {
        eventos: eventos.length,
        porMinuto: duracaoMin ? Math.round(eventos.length / duracaoMin) : eventos.length,
        ferramentas: chamadas,
        ferramentasUnicas: ferramentas.length,
        subagentes: agentes.length - 1,
        compactacoes: painel.context ? painel.context.overflows + painel.context.manualCompactions : compactacoes,
        erros,
        duracaoMin,
        rodando: session.status === 'active',
      },
      ferramentas: ferramentas.slice(0, MAX_FERRAMENTAS),
      tarefas: painel.plan,
      tokens,
      agentes,
    };
  }

  async conversa(session: Session, agentePedido: string | null, limitePedido: string | null): Promise<ConversaDoDetalhe> {
    const [lista, eventos] = await Promise.all([this.storage.listAgents(session.id), this.todosOsEventos(session.id)]);
    const quem = new Agentes(session.id, lista);
    const opcoes = quem.opcoes();
    const agente = opcoes.some((o) => o.id === agentePedido) ? agentePedido! : quem.principal;
    const limite = Math.min(MAX_MENSAGENS, Math.max(1, Number(limitePedido) || MAX_MENSAGENS));

    const mensagens: MensagemDaConversa[] = [];
    const chamadas = new Map<string, FerramentaNaConversa>();
    let ultimaChamada: FerramentaNaConversa | null = null;
    const atual = (e: SessionEvent): MensagemDaConversa => {
      const ultima = mensagens.at(-1);
      if (ultima?.papel === 'assistente') return ultima;
      const nova = mensagemDoAssistente(e, null);
      mensagens.push(nova);
      return nova;
    };

    for (const e of eventos) {
      if (quem.de(e.agentId) !== agente) continue;
      if (PROMPTS.has(e.type)) {
        const texto = cortar(textoDoPrompt(e), MAX_TEXTO);
        // O hook e o transcript contam o mesmo prompt: o segundo, igual e logo depois, não entra.
        const anterior = [...mensagens].reverse().find((m) => m.papel === 'voce');
        if (anterior && anterior.texto === texto && Math.abs(Date.parse(e.createdAt) - Date.parse(anterior.em)) < 120_000) continue;
        mensagens.push({ id: e.id, papel: 'voce', em: e.createdAt, texto, modelo: null, tokens: null, ferramentas: [] });
      } else if (e.type === 'AssistantMessage' && e.summary) {
        mensagens.push(mensagemDoAssistente(e, cortar(e.summary, MAX_TEXTO)));
      } else if (CHAMADAS.has(e.type) && e.toolName) {
        const id = idDaChamada(e) ?? e.id;
        const ja = chamadas.get(id);
        const entrada = emJson(obj(e.data)?.tool_input ?? null);
        if (ja) {
          ja.entrada ??= entrada;
          continue;
        }
        const f: FerramentaNaConversa = { id, nome: e.toolName, resumo: e.summary, estado: null, entrada, resultado: null };
        chamadas.set(id, f);
        atual(e).ferramentas.push(f);
        ultimaChamada = f;
      } else if (RESULTADOS.has(e.type)) {
        const id = idDaChamada(e);
        const f = id ? chamadas.get(id) : null;
        if (!f) continue;
        f.estado = falhou(e) ? 'erro' : 'ok';
        f.resultado ??= e.type === 'ToolResult' ? cortar(e.summary, MAX_DADOS) : emJson(obj(e.data)?.tool_response ?? null);
      }
    }
    // A última chamada sem resultado: é ela que pede permissão, ou a que está rodando.
    const ultima = ultimaChamada as FerramentaNaConversa | null;
    if (ultima && ultima.estado === null && agente === quem.principal) {
      if (session.awaitingInputSince && session.awaitingReason === 'notification') ultima.estado = 'permissao';
      else if (session.status === 'active' && !session.awaitingInputSince) ultima.estado = 'rodando';
    }

    return { agentes: opcoes, agente, total: mensagens.length, mensagens: mensagens.slice(-limite) };
  }

  async eventos(session: Session, params: URLSearchParams): Promise<EventosDoDetalhe> {
    const [lista, todos] = await Promise.all([this.storage.listAgents(session.id), this.todosOsEventos(session.id)]);
    const quem = new Agentes(session.id, lista);
    const f = filtroDe(params);

    const tipos = new Set<string>();
    const ferramentas = new Set<string>();
    const itens: EventoDoDetalhe[] = [];
    for (let i = todos.length - 1; i >= 0; i--) {
      const e = todos[i]!;
      tipos.add(e.type);
      if (e.toolName) ferramentas.add(e.toolName);
      const agente = quem.de(e.agentId);
      const status = statusDoEvento(e);
      if (f.tipo && e.type !== f.tipo) continue;
      if (f.ferramenta && e.toolName !== f.ferramenta) continue;
      if (f.agente && agente !== f.agente) continue;
      if (f.status && status !== f.status) continue;
      if (f.de && e.createdAt < f.de) continue;
      if (f.ate && e.createdAt > f.ate) continue;
      const dados = emJson(e.data);
      if (f.q && ![e.summary, e.toolName, e.type, dados].some((t) => t?.toLowerCase().includes(f.q!))) continue;
      itens.push({ id: e.id, em: e.createdAt, tipo: e.type, ferramenta: e.toolName, resumo: e.summary, agente: { id: agente, nome: quem.nome(agente) }, status, dados });
    }

    const comeco = f.antes ? itens.findIndex((e) => e.id === f.antes) + 1 : 0;
    const pagina = itens.slice(comeco, comeco + f.limite);
    const fim = comeco + pagina.length;
    return {
      total: todos.length,
      filtrados: itens.length,
      itens: pagina,
      proximo: fim < itens.length && pagina.length ? pagina.at(-1)!.id : null,
      opcoes: { tipos: [...tipos].sort(), ferramentas: [...ferramentas].sort(), agentes: quem.opcoes(), status: ['active', 'waiting', 'error'] },
    };
  }
}

function textoDoPrompt(e: SessionEvent): string | null {
  return e.summary === 'prompt' && e.type === 'UserPromptSubmit' ? (str(obj(e.data)?.prompt) ?? null) : (e.summary ?? str(obj(e.data)?.prompt));
}

function mensagemDoAssistente(e: SessionEvent, texto: string | null): MensagemDaConversa {
  const usage = obj(obj(e.data)?.usage);
  const t = obj(usage?.tokens);
  return {
    id: e.id,
    papel: 'assistente',
    em: e.createdAt,
    texto,
    modelo: str(usage?.model),
    // ↓ o que entrou de novo (sem a leitura de cache) · ↑ o que saiu.
    tokens: t ? { entrada: num(t.input) + num(t.cacheWrite5m) + num(t.cacheWrite1h), saida: num(t.output) } : null,
    ferramentas: [],
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z$/;
const PARAM = /^[A-Za-z0-9_.:\[\]-]{1,128}$/;

/**
 * Os filtros da linha do tempo: `q` (resumo, ferramenta, tipo e conteúdo), `type`, `tool`,
 * `agent`, `status` (`active`, `waiting` ou `error`), `from` e `to` (ISO em UTC), `limit` (até 500)
 * e `before` (o id do último evento da página anterior).
 */
export function filtroDe(p: URLSearchParams) {
  const param = (k: string) => {
    const v = p.get(k);
    return v && PARAM.test(v) ? v : null;
  };
  const data = (k: string) => {
    const v = p.get(k);
    return v && ISO.test(v) ? new Date(v).toISOString() : null;
  };
  const status = p.get('status');
  const q = p.get('q')?.trim().toLowerCase().slice(0, 200) || null;
  return {
    q,
    tipo: param('type'),
    ferramenta: param('tool'),
    agente: param('agent'),
    status: status === 'active' || status === 'waiting' || status === 'error' ? status : null,
    de: data('from'),
    ate: data('to'),
    limite: Math.min(MAX_PAGINA, Math.max(1, Number(p.get('limit')) || PAGINA_DE_EVENTOS)),
    antes: p.get('before')?.slice(0, 200) || null,
  };
}
