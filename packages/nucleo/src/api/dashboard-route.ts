// `GET /api/dashboard`: what the Dashboard (C1, #27) draws beyond "precisam de você", which comes
// from `GET /api/attention` (#87). The six numbers, the active agents with their subagents and the
// recent activity, in one request.
//
// Everything through the port and in-memory caches (decision 0004): no transcript is read.
// - Live sessions and their state: the MCP's `FleetReader`, the same as the tray's.
// - Events: each session is read once and, after that, only from the cursor on when its `updatedAt`
//   changes. Every `releituraMs` the session is re-read whole, to catch an event that arrived late.
// - Cost: the report of the last 30 days and of the live sessions, at most every `custoMs`. The usage samples
//   come with the events already read (one per message, only for the sessions that can be costed), and the
//   token-usage buckets are read on every refresh, so the cost never reads the events a second time (#311).
// - The scan yields to the event loop every `SLICE_MS`, so the núcleo keeps answering (`/api/telemetry`) while it builds.
// - The whole response holds for `cacheMs`: a burst of changes does not redo the math on every request.
//
// #245: the session numbers split `blocked` ("Precisam de você", the errors included) from `idle`
// ("Ociosas"), each active-agent card and each waiting activity row carries `attention` (src/api/attention.ts).
// The "precisam de você" inbox itself is `GET /api/attention`: its items carry the same `attention`, and
// its `blocked` and `idle` counts are the inbox's and the neutral row's.
//
// Conversation text: only the one-line summary the core already keeps (the prompt, cut), in the
// card's last two messages, as C1 asks. Never the agent's answer.

import { costReport, costSlicesOf, dayOf, usageSampleOf, type CostReport, type CostSlice } from '../cost/aggregation.ts';
import { isBetterSample, messageKeyOf, type UsageSample } from '../ingest/history/usage.ts';
import { currentPrices } from '../cost/table.ts';
import type { InboxState } from '../states/inbox.ts';
import { eventAttention, type SessionAttention } from './attention.ts';
import { fraseDoEvento } from './event-phrase.ts';
import type { Agent, AgentStatus, SessionEvent } from '../model.ts';
import { minutesSince, projectOf, type FleetReader, type FleetSession } from '../mcp/fleet.ts';
import type { StoragePort } from '../storage-port.ts';

export const DASHBOARD_ROUTE = '/api/dashboard';

/** O status que o badge mostra (os cinco do wireframe). */
export type StatusDoBadge = 'active' | 'waiting' | 'completed' | 'error' | 'abandoned';

// The JSON is English since #173 phase 2b (layer 3); the route never had a Portuguese alias.
export interface NumerosDoDashboard {
  /** Todas as sessões do banco; as vivas por estado. */
  sessions: {
    total: number;
    active: number;
    waiting: number;
    withError: number;
    /** #245: as vivas que precisam de você (`attention.level` `blocked`, as de erro incluídas). */
    blocked: number;
    /** #245: as vivas ociosas (`attention.level` `idle`). */
    idle: number;
  };
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
  /** #245: `blocked` ou `idle`, com o motivo; `null` quando não espera você nem está com erro. */
  attention: SessionAttention | null;
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
  /** #245: a da linha que espera você (`blocked`: o pedido ou o erro; `idle`: o Esc); `null` nas outras. */
  attention: SessionAttention | null;
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
  frota: FleetReader;
  cacheMs?: number;
  custoMs?: number;
  releituraMs?: number;
  /** The longest a build holds the event loop before yielding (default 20 ms). */
  sliceMs?: number;
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
/** The longest the build holds the event loop before giving it back. */
const SLICE_MS = 20;

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
  atividade: { texto: string; status: StatusDoBadge; attention: SessionAttention | null; em: string }[];
  /** The usage the events carry, for the cost slices: read with the events, not in a second pass (#311). */
  usageSamples: Map<string, UsageSample>;
  eventTimes: Map<string, string>;
  /** Whether the usage is being collected: only for the sessions the cost report can reach. */
  costed: boolean;
}

const novaLeitura = (updatedAt: string, agora: number, costed: boolean): Leitura => ({
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
  usageSamples: new Map(),
  eventTimes: new Map(),
  costed,
});

export class MontadorDoDashboard {
  private readonly frota: FleetReader;
  private readonly storage: StoragePort;
  private readonly cacheMs: number;
  private readonly custoMs: number;
  private readonly releituraMs: number;
  private readonly linhas: number;
  private readonly sliceMs: number;
  private readonly leituras = new Map<string, Leitura>();
  private resposta: { em: number; corpo: RespostaDoDashboard } | null = null;
  private rodando: Promise<RespostaDoDashboard> | null = null;
  private custo: { em: number; chave: string; mes: CostReport; vivas: CostReport } | null = null;
  private sliceDeadline = 0;

  constructor({ frota, cacheMs = 2_000, custoMs = 30_000, releituraMs = 10 * 60_000, linhas = 8, sliceMs = SLICE_MS }: OpcoesDoDashboard) {
    this.frota = frota;
    this.storage = frota.storage;
    this.cacheMs = cacheMs;
    this.custoMs = custoMs;
    this.releituraMs = releituraMs;
    this.linhas = linhas;
    this.sliceMs = sliceMs;
  }

  async montar(): Promise<RespostaDoDashboard> {
    if (this.resposta && this.frota.now() - this.resposta.em < this.cacheMs) return this.resposta.corpo;
    this.rodando ??= this.montarAgora()
      .then((corpo) => {
        this.resposta = { em: this.frota.now(), corpo };
        return corpo;
      })
      .finally(() => {
        this.rodando = null;
      });
    return this.rodando;
  }

  private async montarAgora(): Promise<RespostaDoDashboard> {
    const agora = this.frota.now();
    const fuso = this.frota.timeZone;
    const hoje = this.frota.today();
    const vivas = await this.frota.live();
    this.sliceDeadline = performance.now() + this.sliceMs;
    const desde = this.costStart(hoje);
    const liveIds = new Set(vivas.map((v) => v.session.id));

    // Todas as sessões, mais recentes primeiro: os eventos de cada uma e a atividade das últimas.
    let totalDeSessoes = 0;
    const recentes: { id: string; projeto: string | null; status: StatusDoBadge }[] = [];
    const sessionsByRecency: { id: string; updatedAt: string }[] = [];
    const vistas = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        totalDeSessoes++;
        vistas.add(s.id);
        sessionsByRecency.push({ id: s.id, updatedAt: s.updatedAt });
        await this.ler(s.id, s.updatedAt, agora, liveIds.has(s.id) || dayOf(s.updatedAt, fuso) >= desde);
        await this.yieldLoop();
        if (recentes.length < SESSOES_NA_ATIVIDADE) recentes.push({ id: s.id, projeto: projectOf(s), status: s.status === 'completed' ? 'completed' : s.status === 'abandoned' ? 'abandoned' : 'active' });
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

    const { mes, vivas: custoDasVivas } = await this.custos(sessionsByRecency, desde, vivas.map((v) => ({ id: v.session.id, updatedAt: v.session.updatedAt })), hoje);
    const custoPorSessao = new Map(custoDasVivas.bySession.map((l) => [l.key, l.costUsd]));

    const sessoes = { total: totalDeSessoes, active: 0, waiting: 0, withError: 0, blocked: 0, idle: 0 };
    const agentes = { active: 0, sessions: 0 };
    const subagentes = { active: 0, sessions: 0 };
    const cards: AgenteDoDashboard[] = [];
    for (const v of vivas) {
      const estado = v.inbox.state;
      if (estado === 'waiting') sessoes.waiting++;
      else if (estado === 'error') sessoes.withError++;
      else sessoes.active++;
      const attention = await this.frota.sessionAttention(v);
      if (attention) sessoes[attention.level]++;
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
      cards.push(await this.card(v, lista, attention, custoPorSessao.has(v.session.id) ? (custoPorSessao.get(v.session.id) ?? null) : 0, agora));
    }
    // Trabalhando primeiro, depois quem espera, depois os erros; dentro, a atividade mais recente.
    const ordem: Record<StatusDoBadge, number> = { active: 0, waiting: 1, error: 2, completed: 3, abandoned: 4 };
    cards.sort((a, b) => ordem[a.status] - ordem[b.status] || b.lastActivity.localeCompare(a.lastActivity));

    const atividade: AtividadeDoDashboard[] = [];
    for (const r of recentes) {
      const l = this.leituras.get(r.id);
      for (const a of l?.atividade ?? []) atividade.push({ session: r.id, project: r.projeto, status: a.status, attention: a.attention, text: a.texto, at: a.em });
    }
    // A interrupção (Esc) não deixa evento: ela vem do estado da sessão viva.
    for (const v of vivas) {
      if (v.session.awaitingReason === 'interrupted' && v.session.awaitingInputSince) {
        atividade.push({ session: v.session.id, project: projectOf(v.session), status: 'waiting', attention: { level: 'idle', reason: 'interrupted' }, text: 'Interrompida (Esc)', at: v.session.awaitingInputSince });
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

  private async card(v: FleetSession, lista: Agent[], attention: SessionAttention | null, custoUsd: number | null, agora: number): Promise<AgenteDoDashboard> {
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
      title: v.title,
      project: projectOf(s),
      status,
      state: v.inbox.state,
      attention,
      model: s.model,
      costUsd: custoUsd === null ? null : Math.round(custoUsd * 100) / 100,
      lastActivity: s.updatedAt,
      minutes: minutesSince(s.updatedAt, agora),
      turns: l ? Math.max(l.promptsHook, l.promptsTranscript) : 0,
      messages: l?.mensagens ?? [],
      task: await this.tarefa(v, l),
      subagents: subs,
    };
  }

  private async tarefa(v: FleetSession, l: Leitura | undefined): Promise<string | null> {
    const f = l?.ultimaFerramenta;
    const ferramenta = f?.nome ? cortar(f.resumo && f.resumo !== f.nome ? `${f.nome}: ${f.resumo}` : f.nome, MAX_TEXTO) : null;
    if (v.inbox.state === 'waiting' && v.session.awaitingReason === 'notification') return ferramenta;
    const plano = await this.storage.getPlan(v.session.id);
    const passo = plano?.steps.find((p) => p.id === plano.currentStepId);
    return cortar(passo?.text ?? null, MAX_TEXTO) ?? ferramenta;
  }

  /** Lê os eventos novos da sessão, se ela mudou desde a última leitura. */
  private async ler(id: string, updatedAt: string, agora: number, costed: boolean): Promise<void> {
    let l = this.leituras.get(id);
    if (l && l.updatedAt === updatedAt && (l.costed || !costed)) return;
    // A session that enters the cost window was read without its usage: read it whole.
    if (!l || agora - l.lidoEm >= this.releituraMs || (costed && !l.costed)) {
      // The first read of every session happens together; spread the whole re-reads so they do not all fall due at once.
      const stagger = l ? 0 : Math.floor((hashOf(id) % 1000) / 1000 * (this.releituraMs / 2));
      l = novaLeitura(updatedAt, agora - stagger, costed);
    }
    l.updatedAt = updatedAt;
    if (!costed) {
      l.costed = false;
      l.usageSamples.clear();
      l.eventTimes.clear();
    }
    let cursor = l.cursor;
    for (;;) {
      let page;
      try {
        page = await this.storage.listEvents(id, { limit: 500, cursor });
      } catch (err) {
        // Cursor que o adaptador não reconhece: relê do início.
        if (!(err instanceof RangeError) || cursor === null) throw err;
        l = novaLeitura(updatedAt, agora, costed);
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

  private costStart(hoje: string): string {
    return dayOf(new Date(Date.parse(`${hoje}T12:00:00Z`) - (DIAS_DO_CUSTO - 1) * 24 * HORA).toISOString(), 'UTC');
  }

  private async custos(todas: { id: string; updatedAt: string }[], desde: string, vivas: { id: string }[], hoje: string): Promise<{ mes: CostReport; vivas: CostReport }> {
    const chave = `${hoje}|${vivas.map((v) => v.id).sort().join(',')}`;
    const c = this.custo;
    if (c && c.chave === chave && this.frota.now() - c.em < this.custoMs) return c;
    const fusoHorario = this.frota.timeZone;
    const prices = await currentPrices(this.storage);
    // Most recent first: a session with no activity since `desde` has no slice in the period.
    const inMonth: string[] = [];
    for (const s of todas) {
      if (dayOf(s.updatedAt, fusoHorario) < desde) break;
      inMonth.push(s.id);
    }
    // The buckets are read every time (the importer writes them apart from the events); only the events are kept.
    const slicesOf = async (id: string): Promise<CostSlice[]> => {
      const l = this.leituras.get(id);
      const slices = await costSlicesOf(this.storage, id, l ? [...l.usageSamples.values()] : [], l?.eventTimes ?? new Map(), prices, fusoHorario);
      await this.yieldLoop();
      return slices;
    };
    const monthSlices: CostSlice[] = [];
    for (const id of inMonth) {
      for (const p of await slicesOf(id)) if (p.day >= desde && p.day <= hoje) monthSlices.push(p);
    }
    const liveSlices: CostSlice[] = [];
    for (const v of vivas) liveSlices.push(...(await slicesOf(v.id)));
    this.custo = { em: this.frota.now(), chave, mes: costReport(monthSlices, fusoHorario), vivas: costReport(liveSlices, fusoHorario) };
    return this.custo;
  }

  /** Gives the event loop back when the build has held it for `SLICE_MS`. */
  private async yieldLoop(): Promise<void> {
    if (performance.now() < this.sliceDeadline) return;
    await new Promise<void>((r) => setImmediate(r));
    this.sliceDeadline = performance.now() + this.sliceMs;
  }
}

function hashOf(texto: string): number {
  let h = 0;
  for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
  return h;
}

// A porta só devolve cursor quando há outra página. Para continuar depois do último evento lido,
// o cursor sai no formato do adaptador SQLite, como em `summary.ts`; outro adaptador que não o
// reconheça lança RangeError, e `ler` volta a ler do início.
function cursorDe(ev: SessionEvent): string {
  return Buffer.from(JSON.stringify([ev.createdAt, ev.id])).toString('base64url');
}

function aplicar(l: Leitura, e: SessionEvent, agora: number): void {
  l.total++;
  const sample = l.costed ? usageSampleOf(e) : null;
  if (sample) {
    // One sample per message, as `dedupeByMessage` keeps it.
    const key = messageKeyOf(sample);
    const prev = l.usageSamples.get(key);
    if (isBetterSample(sample, prev)) {
      if (prev) l.eventTimes.delete(prev.eventId);
      l.usageSamples.set(key, sample);
      l.eventTimes.set(e.id, e.createdAt);
    }
  }
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
        anotar(l, fraseDoEvento(e, { ultimaFerramenta: l.ultimaFerramenta })!, 'waiting', e.createdAt, eventAttention(e));
      }
      return;
    }
    case 'Stop':
      anotar(l, fraseDoEvento(e, { ultimoPrompt: l.ultimoPrompt })!, 'active', e.createdAt);
      return;
    case 'APIError':
    case 'StopFailure':
      anotar(l, fraseDoEvento(e)!, 'error', e.createdAt, eventAttention(e));
      return;
    case 'SessionStart':
      anotar(l, fraseDoEvento(e)!, 'active', e.createdAt);
      return;
    case 'SessionEnd':
      anotar(l, fraseDoEvento(e)!, 'completed', e.createdAt);
      return;
  }
}

function anotar(l: Leitura, texto: string, status: StatusDoBadge, em: string, attention: SessionAttention | null = null): void {
  l.atividade.unshift({ texto: cortar(texto, MAX_TEXTO) ?? texto, status, attention, em });
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

const montadores = new WeakMap<FleetReader, MontadorDoDashboard>();

/** A resposta da rota, com um montador (e os caches dele) por frota. */
export function montarDashboard(frota: FleetReader): Promise<RespostaDoDashboard> {
  let m = montadores.get(frota);
  if (!m) montadores.set(frota, (m = new MontadorDoDashboard({ frota })));
  return m.montar();
}
