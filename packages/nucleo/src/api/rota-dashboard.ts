// `GET /api/dashboard`: o que o Dashboard (C1, #27) desenha além do "precisam de você", que vem
// de `GET /api/attention` (#87). Os seis números, os agentes ativos com os subagentes e a atividade
// recente, num pedido.
//
// Tudo pela porta e por caches em memória (decisão 0004): nenhum transcript é lido.
// - Sessões vivas e o estado delas: a `LeituraDaFrota` do MCP, a mesma da bandeja.
// - Eventos: cada sessão é lida uma vez e, depois, só do cursor em diante quando o `updatedAt`
//   muda. A cada `releituraMs` a sessão é relida inteira, para pegar o evento que chegou atrasado.
// - Cost: `aggregateCost` of the last 30 days and of the live sessions, at most every `custoMs`.
// - A resposta inteira vale `cacheMs`: uma rajada de mudanças não refaz a conta a cada pedido.
//
// Texto da conversa: só o resumo de uma linha que o núcleo já guarda (o prompt, cortado), nas
// duas últimas mensagens do card, como o C1 pede. Nunca a resposta do agente.

import { aggregateCost, dayOf, type CostReport } from '../cost/aggregation.ts';
import type { InboxState } from '../states/inbox.ts';
import { fraseDoEvento } from './frase-do-evento.ts';
import type { Agent, AgentStatus, SessionEvent } from '../model.ts';
import { minutosDesde, projetoDe, type LeituraDaFrota, type SessaoDaFrota } from '../mcp/fleet.ts';
import type { StoragePort } from '../storage-port.ts';

export const ROTA_DO_DASHBOARD = '/api/dashboard';

/** O status que o badge mostra (os cinco do wireframe). */
export type StatusDoBadge = 'active' | 'waiting' | 'completed' | 'error' | 'abandoned';

// The JSON is English since #173 phase 2b (layer 3); the route never had a Portuguese alias.
export interface NumerosDoDashboard {
  /** Todas as sessões do banco; as vivas por estado. */
  sessions: { total: number; active: number; waiting: number; withError: number };
  /** Agentes principais trabalhando, e em quantas sessões. */
  agents: { active: number; sessions: number };
  subagents: { active: number; sessions: number };
  events: { today: number; lastHour: number; total: number };
  /** Estimativa: `null` quando houve uso e nada dele tem preço na tabela. */
  cost: { usd: number | null; days: number; unpriced: string[] };
}

export interface SubagenteDoDashboard {
  id: string;
  type: string | null;
  task: string | null;
  status: AgentStatus;
  since: string;
  until: string | null;
}

export interface AgenteDoDashboard {
  session: string;
  title: string;
  project: string | null;
  status: StatusDoBadge;
  state: InboxState;
  model: string | null;
  costUsd: number | null;
  lastActivity: string;
  minutes: number;
  turns: number;
  /** As duas últimas mensagens da pessoa, já cortadas. */
  messages: string[];
  /** O que o agente faz agora: o passo do plano, o pedido ou a última ferramenta. */
  task: string | null;
  subagents: SubagenteDoDashboard[];
}

export interface AtividadeDoDashboard {
  session: string;
  project: string | null;
  status: StatusDoBadge;
  text: string;
  at: string;
}

export interface RespostaDoDashboard {
  generatedAt: string;
  day: string;
  timeZone: string;
  numbers: NumerosDoDashboard;
  agents: AgenteDoDashboard[];
  activity: AtividadeDoDashboard[];
}

export interface OpcoesDoDashboard {
  frota: LeituraDaFrota;
  cacheMs?: number;
  custoMs?: number;
  releituraMs?: number;
  /** Quantas linhas de atividade. Padrão 8, como no C1. */
  linhas?: number;
}

const HORA = 3_600_000;
const DIAS_DO_CUSTO = 30;
const MAX_MENSAGEM = 140;
const MAX_TEXTO = 120;
/** Eventos com hora guardada, por sessão: o bastante para "hoje" em qualquer fuso. */
const JANELA_RECENTE = 36 * HORA;
const MAX_ATIVIDADE_POR_SESSAO = 8;
const MAX_SUBAGENTES = 20;
const SESSOES_NA_ATIVIDADE = 24;

interface Leitura {
  updatedAt: string;
  cursor: string | null;
  lidoEm: number;
  total: number;
  /** Horas (ms) dos eventos das últimas `JANELA_RECENTE`, na ordem do banco. */
  recentes: number[];
  promptsHook: number;
  promptsTranscript: number;
  mensagens: string[];
  ultimoPrompt: number | null;
  ultimaFerramenta: { nome: string | null; resumo: string | null } | null;
  atividade: { texto: string; status: StatusDoBadge; em: string }[];
}

const novaLeitura = (updatedAt: string, agora: number): Leitura => ({
  updatedAt,
  cursor: null,
  lidoEm: agora,
  total: 0,
  recentes: [],
  promptsHook: 0,
  promptsTranscript: 0,
  mensagens: [],
  ultimoPrompt: null,
  ultimaFerramenta: null,
  atividade: [],
});

export class MontadorDoDashboard {
  private readonly frota: LeituraDaFrota;
  private readonly storage: StoragePort;
  private readonly cacheMs: number;
  private readonly custoMs: number;
  private readonly releituraMs: number;
  private readonly linhas: number;
  private readonly leituras = new Map<string, Leitura>();
  private resposta: { em: number; corpo: RespostaDoDashboard } | null = null;
  private rodando: Promise<RespostaDoDashboard> | null = null;
  private custo: { em: number; chave: string; mes: CostReport; vivas: CostReport } | null = null;

  constructor({ frota, cacheMs = 2_000, custoMs = 30_000, releituraMs = 10 * 60_000, linhas = 8 }: OpcoesDoDashboard) {
    this.frota = frota;
    this.storage = frota.storage;
    this.cacheMs = cacheMs;
    this.custoMs = custoMs;
    this.releituraMs = releituraMs;
    this.linhas = linhas;
  }

  async montar(): Promise<RespostaDoDashboard> {
    if (this.resposta && this.frota.agora() - this.resposta.em < this.cacheMs) return this.resposta.corpo;
    this.rodando ??= this.montarAgora()
      .then((corpo) => {
        this.resposta = { em: this.frota.agora(), corpo };
        return corpo;
      })
      .finally(() => {
        this.rodando = null;
      });
    return this.rodando;
  }

  private async montarAgora(): Promise<RespostaDoDashboard> {
    const agora = this.frota.agora();
    const fuso = this.frota.fusoHorario;
    const hoje = this.frota.hoje();
    const vivas = await this.frota.vivas();

    // Todas as sessões, mais recentes primeiro: os eventos de cada uma e a atividade das últimas.
    let totalDeSessoes = 0;
    const recentes: { id: string; projeto: string | null; status: StatusDoBadge }[] = [];
    const vistas = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        totalDeSessoes++;
        vistas.add(s.id);
        await this.ler(s.id, s.updatedAt, agora);
        if (recentes.length < SESSOES_NA_ATIVIDADE) recentes.push({ id: s.id, projeto: projetoDe(s), status: s.status === 'completed' ? 'completed' : s.status === 'abandoned' ? 'abandoned' : 'active' });
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of this.leituras.keys()) if (!vistas.has(id)) this.leituras.delete(id);

    const inicioDoDia = inicioDoDiaEm(hoje, agora, fuso);
    const eventos = { today: 0, lastHour: 0, total: 0 };
    for (const l of this.leituras.values()) {
      eventos.total += l.total;
      for (const t of l.recentes) {
        if (t >= inicioDoDia) eventos.today++;
        if (t > agora - HORA) eventos.lastHour++;
      }
    }

    const { mes, vivas: custoDasVivas } = await this.custos(vivas.map((v) => v.session.id), hoje);
    const custoPorSessao = new Map(custoDasVivas.bySession.map((l) => [l.key, l.costUsd]));

    const sessoes = { total: totalDeSessoes, active: 0, waiting: 0, withError: 0 };
    const agentes = { active: 0, sessions: 0 };
    const subagentes = { active: 0, sessions: 0 };
    const cards: AgenteDoDashboard[] = [];
    for (const v of vivas) {
      const estado = v.inbox.state;
      if (estado === 'waiting') sessoes.waiting++;
      else if (estado === 'error') sessoes.withError++;
      else sessoes.active++;
      const lista = await this.storage.listAgents(v.session.id);
      const principais = lista.filter((a) => a.type === 'main' && a.status === 'working').length;
      if (principais > 0 && estado !== 'waiting' && estado !== 'error') {
        agentes.active += principais;
        agentes.sessions++;
      }
      if (v.inbox.activeSubagents > 0) {
        subagentes.active += v.inbox.activeSubagents;
        subagentes.sessions++;
      }
      cards.push(await this.card(v, lista, custoPorSessao.has(v.session.id) ? (custoPorSessao.get(v.session.id) ?? null) : 0, agora));
    }
    // Trabalhando primeiro, depois quem espera, depois os erros; dentro, a atividade mais recente.
    const ordem: Record<StatusDoBadge, number> = { active: 0, waiting: 1, error: 2, completed: 3, abandoned: 4 };
    cards.sort((a, b) => ordem[a.status] - ordem[b.status] || b.lastActivity.localeCompare(a.lastActivity));

    const atividade: AtividadeDoDashboard[] = [];
    for (const r of recentes) {
      const l = this.leituras.get(r.id);
      for (const a of l?.atividade ?? []) atividade.push({ session: r.id, project: r.projeto, status: a.status, text: a.texto, at: a.em });
    }
    // A interrupção (Esc) não deixa evento: ela vem do estado da sessão viva.
    for (const v of vivas) {
      if (v.session.awaitingReason === 'interrupted' && v.session.awaitingInputSince) {
        atividade.push({ session: v.session.id, project: projetoDe(v.session), status: 'waiting', text: 'Interrompida (Esc)', at: v.session.awaitingInputSince });
      }
    }
    atividade.sort((a, b) => b.at.localeCompare(a.at));

    const custoDoMes = mes.total.costUsd;
    return {
      generatedAt: new Date(agora).toISOString(),
      day: hoje,
      timeZone: fuso,
      numbers: {
        sessions: sessoes,
        agents: agentes,
        subagents: subagentes,
        events: eventos,
        cost: { usd: custoDoMes === null ? null : Math.round(custoDoMes * 100) / 100, days: DIAS_DO_CUSTO, unpriced: [...mes.total.unpriced.models].sort() },
      },
      agents: cards,
      activity: atividade.slice(0, this.linhas),
    };
  }

  private async card(v: SessaoDaFrota, lista: Agent[], custoUsd: number | null, agora: number): Promise<AgenteDoDashboard> {
    const s = v.session;
    const l = this.leituras.get(s.id);
    const status = badgeDe(v.inbox.state);
    const subs = lista
      .filter((a) => a.type === 'subagent')
      .sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_SUBAGENTES)
      .map((a): SubagenteDoDashboard => ({ id: a.id, type: a.subagentType, task: cortar(a.name ?? a.task, MAX_TEXTO), status: a.status, since: a.startedAt, until: a.endedAt }));
    return {
      session: s.id,
      title: v.titulo,
      project: projetoDe(s),
      status,
      state: v.inbox.state,
      model: s.model,
      costUsd: custoUsd === null ? null : Math.round(custoUsd * 100) / 100,
      lastActivity: s.updatedAt,
      minutes: minutosDesde(s.updatedAt, agora),
      turns: l ? Math.max(l.promptsHook, l.promptsTranscript) : 0,
      messages: l?.mensagens ?? [],
      task: await this.tarefa(v, l),
      subagents: subs,
    };
  }

  private async tarefa(v: SessaoDaFrota, l: Leitura | undefined): Promise<string | null> {
    const f = l?.ultimaFerramenta;
    const ferramenta = f?.nome ? cortar(f.resumo && f.resumo !== f.nome ? `${f.nome}: ${f.resumo}` : f.nome, MAX_TEXTO) : null;
    if (v.inbox.state === 'waiting' && v.session.awaitingReason === 'notification') return ferramenta;
    const plano = await this.storage.getPlan(v.session.id);
    const passo = plano?.steps.find((p) => p.id === plano.currentStepId);
    return cortar(passo?.text ?? null, MAX_TEXTO) ?? ferramenta;
  }

  /** Lê os eventos novos da sessão, se ela mudou desde a última leitura. */
  private async ler(id: string, updatedAt: string, agora: number): Promise<void> {
    let l = this.leituras.get(id);
    if (l && l.updatedAt === updatedAt) return;
    if (!l || agora - l.lidoEm >= this.releituraMs) l = novaLeitura(updatedAt, agora);
    l.updatedAt = updatedAt;
    let cursor = l.cursor;
    for (;;) {
      let page;
      try {
        page = await this.storage.listEvents(id, { limit: 500, cursor });
      } catch (err) {
        // Cursor que o adaptador não reconhece: relê do início.
        if (!(err instanceof RangeError) || cursor === null) throw err;
        l = novaLeitura(updatedAt, agora);
        cursor = null;
        continue;
      }
      for (const e of page.items) aplicar(l, e, agora);
      if (page.items.length > 0) cursor = page.nextCursor ?? cursorDe(page.items.at(-1)!);
      if (!page.nextCursor) break;
    }
    l.cursor = cursor;
    this.leituras.set(id, l);
  }

  private async custos(vivas: string[], hoje: string): Promise<{ mes: CostReport; vivas: CostReport }> {
    const chave = `${hoje}|${[...vivas].sort().join(',')}`;
    const c = this.custo;
    if (c && c.chave === chave && this.frota.agora() - c.em < this.custoMs) return c;
    const fusoHorario = this.frota.fusoHorario;
    const desde = dayOf(new Date(Date.parse(`${hoje}T12:00:00Z`) - (DIAS_DO_CUSTO - 1) * 24 * HORA).toISOString(), 'UTC');
    const [mes, dasVivas] = await Promise.all([
      aggregateCost(this.storage, { since: desde, until: hoje, timeZone: fusoHorario }),
      aggregateCost(this.storage, { sessionIds: vivas, timeZone: fusoHorario }),
    ]);
    this.custo = { em: this.frota.agora(), chave, mes, vivas: dasVivas };
    return this.custo;
  }
}

// A porta só devolve cursor quando há outra página. Para continuar depois do último evento lido,
// o cursor sai no formato do adaptador SQLite, como em `resumo.ts`; outro adaptador que não o
// reconheça lança RangeError, e `ler` volta a ler do início.
function cursorDe(ev: SessionEvent): string {
  return Buffer.from(JSON.stringify([ev.createdAt, ev.id])).toString('base64url');
}

function aplicar(l: Leitura, e: SessionEvent, agora: number): void {
  l.total++;
  const t = Date.parse(e.createdAt);
  if (Number.isFinite(t) && t > agora - JANELA_RECENTE) l.recentes.push(t);
  const d = obj(e.data);
  const principal = e.agentId === null || e.agentId.endsWith(':main');
  switch (e.type) {
    case 'UserPromptSubmit':
      l.promptsHook++;
      l.ultimoPrompt = t;
      guardarMensagem(l, e.summary);
      return;
    case 'UserPrompt':
      if (!principal) return;
      l.promptsTranscript++;
      l.ultimoPrompt = t;
      guardarMensagem(l, e.summary);
      return;
    case 'PreToolUse':
    case 'ToolUse': {
      if (!principal) return;
      l.ultimaFerramenta = { nome: e.toolName, resumo: e.summary };
      if (e.toolName === 'Agent' || e.toolName === 'Task') {
        anotar(l, fraseDoEvento(e)!, 'active', e.createdAt);
      }
      return;
    }
    case 'SubagentStop':
      anotar(l, fraseDoEvento(e)!, 'active', e.createdAt);
      return;
    case 'Notification': {
      const tipo = str(d?.notification_type);
      if (tipo === 'elicitation_dialog' || tipo === 'permission_prompt') {
        anotar(l, fraseDoEvento(e, { ultimaFerramenta: l.ultimaFerramenta })!, 'waiting', e.createdAt);
      }
      return;
    }
    case 'Stop':
      anotar(l, fraseDoEvento(e, { ultimoPrompt: l.ultimoPrompt })!, 'active', e.createdAt);
      return;
    case 'APIError':
    case 'StopFailure':
      anotar(l, fraseDoEvento(e)!, 'error', e.createdAt);
      return;
    case 'SessionStart':
      anotar(l, fraseDoEvento(e)!, 'active', e.createdAt);
      return;
    case 'SessionEnd':
      anotar(l, fraseDoEvento(e)!, 'completed', e.createdAt);
      return;
  }
}

function anotar(l: Leitura, texto: string, status: StatusDoBadge, em: string): void {
  l.atividade.unshift({ texto: cortar(texto, MAX_TEXTO) ?? texto, status, em });
  if (l.atividade.length > MAX_ATIVIDADE_POR_SESSAO) l.atividade.length = MAX_ATIVIDADE_POR_SESSAO;
}

function guardarMensagem(l: Leitura, texto: string | null): void {
  const m = cortar(texto, MAX_MENSAGEM);
  if (!m || l.mensagens.at(-1) === m) return;
  l.mensagens.push(m);
  if (l.mensagens.length > 2) l.mensagens.shift();
}

export function badgeDe(estado: InboxState): StatusDoBadge {
  if (estado === 'waiting') return 'waiting';
  if (estado === 'error') return 'error';
  if (estado === 'completed' || estado === 'abandoned') return estado;
  return 'active';
}

/** Uma linha só, sem quebra, cortada com reticências. */
function cortar(texto: string | null | undefined, max: number): string | null {
  const t = texto?.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** O instante em que `dia` começa no fuso, perto de `agora`. */
function inicioDoDiaEm(dia: string, agora: number, fuso: string): number {
  // Volta de hora em hora até o dia mudar; depois afina por minuto. No máximo 26 + 60 passos.
  let t = agora - (agora % 60_000);
  while (dayOf(new Date(t - HORA).toISOString(), fuso) === dia) t -= HORA;
  while (dayOf(new Date(t - 60_000).toISOString(), fuso) === dia) t -= 60_000;
  return t;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

const montadores = new WeakMap<LeituraDaFrota, MontadorDoDashboard>();

/** A resposta da rota, com um montador (e os caches dele) por frota. */
export function montarDashboard(frota: LeituraDaFrota): Promise<RespostaDoDashboard> {
  let m = montadores.get(frota);
  if (!m) montadores.set(frota, (m = new MontadorDoDashboard({ frota })));
  return m.montar();
}
